/**
 * Grievance records: listing, detail, evidence upload, public tracking.
 */

import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { requireCitizen } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { query } from '../lib/db.js';
import {
  listForCitizen,
  getForCitizen,
  trackPublic,
  statsForCitizen,
  slaFor,
} from '../services/grievances.js';
import { getConversation, attachEvidence, attachAudio } from '../services/conversation.js';
import { divisionById, DIVISIONS } from '../data/divisions.js';

export const grievanceRouter = Router();

/** Evidence we are willing to store. Anything else is refused by extension AND mime. */
const ALLOWED = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/heic', '.heic'],
]);

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await mkdir(env.uploads.dir, { recursive: true });
      cb(null, env.uploads.dir);
    } catch (err) {
      cb(err);
    }
  },
  // Never trust the submitted filename for the stored name: a crafted one is
  // a path-traversal attempt waiting to happen.
  filename: (_req, file, cb) => {
    const ext = ALLOWED.get(file.mimetype) || extname(file.originalname).toLowerCase().slice(0, 8);
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: env.uploads.maxBytes, files: env.uploads.maxFiles },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(
        Object.assign(new Error('Only PDF, JPEG, PNG, WebP and HEIC files are accepted.'), {
          status: 415,
          code: 'unsupported_file_type',
        }),
      );
    }
    return cb(null, true);
  },
});

/** The divisions and their required fields, for the picker and the forms. */
grievanceRouter.get('/divisions', (_req, res) => {
  res.json({
    divisions: DIVISIONS.map((d) => ({
      id: d.id,
      name: d.name,
      native: d.native,
      blurb: d.blurb,
      helpline: d.helpline || null,
      fields: d.fields,
    })),
  });
});

/** Public docket lookup. No session needed; returns no personal data. */
grievanceRouter.get('/track/:reference', async (req, res, next) => {
  try {
    const found = await trackPublic(req.params.reference);
    if (!found) {
      return res.status(404).json({ error: 'not_found', message: 'No grievance with that docket number.' });
    }
    return res.json(found);
  } catch (err) {
    return next(err);
  }
});

grievanceRouter.use(requireCitizen);

grievanceRouter.get('/', async (req, res, next) => {
  try {
    const rows = await listForCitizen(req.citizen.id, {
      status: req.query.status || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      grievances: rows.map((g) => ({
        ...g,
        division: divisionById(g.division_id),
        sla: slaFor(g),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

grievanceRouter.get('/stats', async (req, res, next) => {
  try {
    return res.json(await statsForCitizen(req.citizen.id));
  } catch (err) {
    return next(err);
  }
});

grievanceRouter.get('/:reference', async (req, res, next) => {
  try {
    const g = await getForCitizen(req.citizen.id, req.params.reference);
    if (!g) return res.status(404).json({ error: 'not_found' });
    return res.json({ ...g, division: divisionById(g.division_id), sla: slaFor(g) });
  } catch (err) {
    return next(err);
  }
});

/** Attach evidence to an in-progress interview. */
grievanceRouter.post('/conversation/:id/evidence', upload.array('files', env.uploads.maxFiles), async (req, res, next) => {
  try {
    const conversation = await getConversation(req.citizen.id, Number(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'not_found' });

    const files = (req.files || []).map((f) => ({
      kind: 'evidence',
      originalName: f.originalname,
      storedName: f.filename,
      mimeType: f.mimetype,
      sizeBytes: f.size,
    }));

    const { conversation: updated } = await attachEvidence(conversation, req.citizen, files);

    return res.json({
      ok: true,
      attachments: updated.draft.attachments,
      count: updated.draft.attachments.length,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Store the recording the narrative was spoken into.
 *
 * Separate from evidence: this is the citizen's own voice, captured by the
 * browser while Azure transcribed it, and the schema treats it as part of the
 * core payload rather than as an attachment.
 */
const audioUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!/^audio\//.test(file.mimetype) && !/^video\/webm/.test(file.mimetype)) {
      return cb(Object.assign(new Error('Expected an audio recording.'), {
        status: 415, code: 'not_audio',
      }));
    }
    return cb(null, true);
  },
});

grievanceRouter.post('/conversation/:id/audio', audioUpload.single('audio'), async (req, res, next) => {
  try {
    const conversation = await getConversation(req.citizen.id, Number(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'not_found' });
    if (!req.file) return res.status(400).json({ error: 'no_audio' });

    await attachAudio(conversation, req.citizen, req.file.filename);
    return res.json({ ok: true, stored: req.file.filename, bytes: req.file.size });
  } catch (err) {
    return next(err);
  }
});

/** Stream one attachment back, but only to the citizen who filed it. */
grievanceRouter.get('/:reference/attachment/:id', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT a.stored_name, a.original_name, a.mime_type
         FROM grievance_attachments a
         JOIN grievances g ON g.id = a.grievance_id
        WHERE a.id = $1 AND g.reference_id = $2 AND g.citizen_id = $3`,
      [Number(req.params.id), req.params.reference, req.citizen.id],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    const file = r.rows[0];
    res.set('Content-Type', file.mime_type);
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(file.original_name)}"`);
    return res.sendFile(join(env.uploads.dir, file.stored_name));
  } catch (err) {
    return next(err);
  }
});

/** Notifications for the bell. Real rows, never a hard-coded badge count. */
grievanceRouter.get('/me/notifications', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT n.id, n.title, n.body, n.read_at, n.created_at, g.reference_id
         FROM notifications n
         LEFT JOIN grievances g ON g.id = n.grievance_id
        WHERE n.citizen_id = $1
        ORDER BY n.created_at DESC
        LIMIT 50`,
      [req.citizen.id],
    );
    const unread = r.rows.filter((n) => !n.read_at).length;
    return res.json({ notifications: r.rows, unread });
  } catch (err) {
    return next(err);
  }
});

grievanceRouter.post('/me/notifications/read', async (req, res, next) => {
  try {
    await query('UPDATE notifications SET read_at = NOW() WHERE citizen_id = $1 AND read_at IS NULL', [
      req.citizen.id,
    ]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
