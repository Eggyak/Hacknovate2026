/**
 * Core Features, over HTTP.
 *
 * Split by who may read what, which is the only split that matters here:
 *
 *   /api/civic/map, /hotspots, /transparency   PUBLIC, and carry no identity
 *   everything else                            the citizen's own grievance
 *
 * The public endpoints are the ones worth being careful about. A civic map is
 * useful precisely because anyone can see it, and that is also how it leaks:
 * a complaint pinned to an exact address on a public map identifies the
 * household that made it. Coordinates are rounded and no text, name or docket
 * is ever returned. See services/civic.js.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireCitizen } from '../lib/auth.js';
import { query } from '../lib/db.js';
import {
  support, withdrawSupport, addComment, listComments, rate,
  publicMap, hotspots, transparency, findSimilar, PRIORITY_LABEL,
} from '../services/civic.js';
import { classify } from '../services/classifier.js';

export const civicRouter = Router();

const publicLimiter = rateLimit({
  windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited' },
});

/* ---------------- public ---------------- */

civicRouter.get('/map', publicLimiter, async (req, res, next) => {
  try {
    res.json({
      points: await publicMap({
        pincode: req.query.pincode,
        division: req.query.division,
        status: req.query.status,
        limit: req.query.limit,
      }),
      note: 'Coordinates are rounded to roughly 100 m and carry no identity.',
    });
  } catch (err) { next(err); }
});

civicRouter.get('/hotspots', publicLimiter, async (req, res, next) => {
  try {
    res.json({ hotspots: await hotspots({ limit: req.query.limit }) });
  } catch (err) { next(err); }
});

civicRouter.get('/transparency', publicLimiter, async (_req, res, next) => {
  try {
    res.json({
      divisions: await transparency(),
      explain: 'Averages cover resolved cases only. Satisfaction counts only where citizens have rated.',
    });
  } catch (err) { next(err); }
});

/* ---------------- citizen ---------------- */

civicRouter.use(requireCitizen);

/**
 * Complaints that look like the one being written.
 *
 * Offered before filing so a citizen can add their weight to an existing
 * report rather than making the forty-first copy. Always a suggestion: they
 * may know something the other reports do not.
 */
civicRouter.post('/similar', async (req, res, next) => {
  try {
    const { text, divisionId, pincode } = req.body || {};
    if (!text || !divisionId || !pincode) {
      return res.json({ similar: [], reason: 'need text, divisionId and pincode' });
    }
    const classification = classify([String(text)]);
    const similar = await findSimilar({
      divisionId, pincode, classification, excludeCitizenId: req.citizen.id,
    });
    return res.json({ similar, matchedOn: (classification.matched || []).map((m) => m.term) });
  } catch (err) { return next(err); }
});

/** Resolve a public reference to our row, scoped where it must be. */
async function grievanceByReference(reference, { ownedBy = null } = {}) {
  const params = [String(reference || '').trim().toUpperCase()];
  let sql = 'SELECT id, citizen_id, status FROM grievances WHERE reference_id = $1';
  if (ownedBy) { params.push(ownedBy); sql += ' AND citizen_id = $2'; }
  const r = await query(sql, params);
  return r.rows[0] || null;
}

/** Add my weight to someone else's complaint. */
civicRouter.post('/:reference/support', async (req, res, next) => {
  try {
    const g = await grievanceByReference(req.params.reference);
    if (!g) return res.status(404).json({ error: 'not_found' });

    const result = await support(g.id, req.citizen.id);
    if (!result.ok) {
      return res.status(result.reason === 'own_grievance' ? 409 : 404).json({
        error: result.reason,
        message: result.reason === 'own_grievance'
          ? 'This is your own grievance.'
          : 'No grievance with that reference.',
      });
    }
    return res.json(result);
  } catch (err) { return next(err); }
});

civicRouter.delete('/:reference/support', async (req, res, next) => {
  try {
    const g = await grievanceByReference(req.params.reference);
    if (!g) return res.status(404).json({ error: 'not_found' });
    return res.json(await withdrawSupport(g.id, req.citizen.id));
  } catch (err) { return next(err); }
});

/** The thread on my own grievance. */
civicRouter.get('/:reference/comments', async (req, res, next) => {
  try {
    const g = await grievanceByReference(req.params.reference, { ownedBy: req.citizen.id });
    if (!g) return res.status(404).json({ error: 'not_found' });
    return res.json({ comments: await listComments(g.id) });
  } catch (err) { return next(err); }
});

civicRouter.post('/:reference/comments', async (req, res, next) => {
  try {
    const g = await grievanceByReference(req.params.reference, { ownedBy: req.citizen.id });
    if (!g) return res.status(404).json({ error: 'not_found' });

    const result = await addComment(g.id, {
      authorKind: 'citizen',
      authorName: req.citizen.full_name,
      body: req.body?.body,
    });
    if (!result.ok) {
      return res.status(422).json({
        error: result.reason,
        message: result.reason === 'too_long' ? 'Keep it under 2000 characters.' : 'Write something first.',
      });
    }
    return res.status(201).json(result);
  } catch (err) { return next(err); }
});

/**
 * Rate the service, once the work is done.
 *
 * Refused before resolution, with a reason - rating work that has not
 * happened measures nothing, and letting it through would corrupt the only
 * satisfaction figure the transparency board has.
 */
civicRouter.post('/:reference/rating', async (req, res, next) => {
  try {
    const g = await grievanceByReference(req.params.reference, { ownedBy: req.citizen.id });
    if (!g) return res.status(404).json({ error: 'not_found' });

    const result = await rate(g.id, req.citizen.id, {
      rating: req.body?.rating,
      comment: req.body?.comment,
    });

    if (!result.ok) {
      const status = result.reason === 'not_resolved_yet' ? 409 : 422;
      return res.status(status).json({
        error: result.reason,
        message: result.reason === 'not_resolved_yet'
          ? 'You can rate this once the department has resolved it.'
          : 'Give a rating from 1 to 5.',
      });
    }
    return res.json({ ...result, priorityLabels: PRIORITY_LABEL });
  } catch (err) { return next(err); }
});
