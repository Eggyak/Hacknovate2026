/**
 * Core Features, version 1.
 *
 * Everything here exists to make one filed complaint useful to more than one
 * reader: the citizen who filed it, the neighbours living with the same
 * problem, and the officer who has to decide what to work on first.
 *
 * The rule that shapes all of it: **grouping is never merging**. Forty people
 * reporting one burst water main should be one thing a department can see,
 * but each of those forty is separately entitled to an answer, their own
 * docket and their own clock. A cluster is a lens over complaints, never a
 * replacement for them.
 */

import { query, transaction } from '../lib/db.js';
import {
  PRIORITY, PRIORITY_LABEL, scorePriority, clusterSignature,
} from './civicRules.js';
import { env } from '../lib/env.js';
import { divisionById } from '../data/divisions.js';

// Re-exported so callers import one module, not two.
export { PRIORITY, PRIORITY_LABEL, scorePriority, clusterSignature };

/* ------------------------------------------------------------------ *
 * Support
 * ------------------------------------------------------------------ */

/**
 * Add this citizen's weight to someone else's complaint.
 *
 * Idempotent by primary key rather than by a check-then-insert, so a retried
 * request cannot inflate a count. A count that can be gamed by pressing a
 * button twice is not evidence of anything.
 */
export async function support(grievanceId, citizenId) {
  const owner = await query('SELECT citizen_id FROM grievances WHERE id = $1', [grievanceId]);
  if (owner.rows.length === 0) return { ok: false, reason: 'not_found' };
  if (Number(owner.rows[0].citizen_id) === Number(citizenId)) {
    return { ok: false, reason: 'own_grievance' };
  }

  await query(
    `INSERT INTO grievance_supports (grievance_id, citizen_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [grievanceId, citizenId],
  );

  const count = await query(
    'SELECT COUNT(*)::int AS n FROM grievance_supports WHERE grievance_id = $1',
    [grievanceId],
  );
  return { ok: true, supporters: count.rows[0].n };
}

export async function withdrawSupport(grievanceId, citizenId) {
  await query(
    'DELETE FROM grievance_supports WHERE grievance_id = $1 AND citizen_id = $2',
    [grievanceId, citizenId],
  );
  const count = await query(
    'SELECT COUNT(*)::int AS n FROM grievance_supports WHERE grievance_id = $1',
    [grievanceId],
  );
  return { ok: true, supporters: count.rows[0].n };
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

export async function addComment(grievanceId, { authorKind, authorName, body }) {
  const text = String(body || '').trim();
  if (text.length < 2) return { ok: false, reason: 'empty' };
  if (text.length > 2000) return { ok: false, reason: 'too_long' };

  const r = await query(
    `INSERT INTO grievance_comments (grievance_id, author_kind, author_name, body)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [grievanceId, authorKind, authorName || null, text],
  );
  return { ok: true, comment: r.rows[0] };
}

export async function listComments(grievanceId) {
  const r = await query(
    'SELECT id, author_kind, author_name, body, created_at FROM grievance_comments WHERE grievance_id = $1 ORDER BY created_at',
    [grievanceId],
  );
  return r.rows;
}

/* ------------------------------------------------------------------ *
 * Satisfaction
 * ------------------------------------------------------------------ */

/**
 * The citizen's verdict on the service, once the work is done.
 *
 * Only accepted on a resolved or closed case - rating work that has not
 * happened measures nothing - and stored apart from the status so a one-star
 * rating is never mistaken for the case reopening. They are different
 * claims: the status is what the department did, the rating is what the
 * citizen thought of it.
 */
export async function rate(grievanceId, citizenId, { rating, comment }) {
  const stars = Number(rating);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return { ok: false, reason: 'rating_out_of_range' };
  }

  const r = await query(
    'SELECT status, satisfaction_rating FROM grievances WHERE id = $1 AND citizen_id = $2',
    [grievanceId, citizenId],
  );
  if (r.rows.length === 0) return { ok: false, reason: 'not_found' };
  if (!['resolved', 'closed'].includes(r.rows[0].status)) {
    return { ok: false, reason: 'not_resolved_yet' };
  }

  await query(
    `UPDATE grievances
        SET satisfaction_rating = $2,
            satisfaction_comment = NULLIF($3, ''),
            satisfaction_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [grievanceId, stars, String(comment || '').trim().slice(0, 1000)],
  );

  await query(
    `INSERT INTO grievance_events (grievance_id, status, note, actor)
     VALUES ($1, 'note', $2, 'citizen')`,
    [grievanceId, `Citizen rated the service ${stars} out of 5.`],
  );

  return { ok: true, rating: stars, previous: r.rows[0].satisfaction_rating };
}

/* ------------------------------------------------------------------ *
 * Escalation
 * ------------------------------------------------------------------ */

/**
 * Raise anything past its statutory deadline.
 *
 * A dashboard turning a row red is not accountability. Escalation writes to
 * the timeline the citizen can see and notifies them, so a missed deadline
 * is something that happened rather than a colour.
 *
 * One level per overdue week, capped - a case cannot be escalated for ever,
 * and an endlessly climbing number stops meaning anything.
 */
export async function escalateOverdue(limit = 50) {
  const r = await query(
    `SELECT id, reference_id, citizen_id, escalation_level,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - sla_deadline)) / 604800)::int + 1 AS due_level
       FROM grievances
      WHERE status NOT IN ('resolved','closed','rejected')
        AND sla_deadline < NOW()
      ORDER BY sla_deadline
      LIMIT $1`,
    [limit],
  );

  let raised = 0;
  for (const row of r.rows) {
    const next = Math.min(3, row.due_level);
    if (next <= row.escalation_level) continue;

    await transaction(async (client) => {
      await client.query(
        'UPDATE grievances SET escalation_level = $2, escalated_at = NOW(), updated_at = NOW() WHERE id = $1',
        [row.id, next],
      );
      await client.query(
        `INSERT INTO grievance_events (grievance_id, status, note, actor)
         VALUES ($1, 'note', $2, 'system')`,
        [row.id, `Escalated to level ${next}: past the ${env.sla.days}-day deadline.`],
      );
      await client.query(
        `INSERT INTO notifications (citizen_id, grievance_id, title, body)
         VALUES ($1, $2, $3::text, $4::text)`,
        [
          row.citizen_id, row.id,
          `${row.reference_id} has been escalated`,
          'Your grievance passed its statutory deadline and has been raised to a higher level for review.',
        ],
      );
    });
    raised += 1;
  }

  return { checked: r.rows.length, escalated: raised };
}

/* ------------------------------------------------------------------ *
 * Response time
 * ------------------------------------------------------------------ */

/** Record the first time anyone acted, and how long resolution took. */
export async function noteResponse(grievanceId, { resolved = false } = {}) {
  await query(
    `UPDATE grievances
        SET first_response_at = COALESCE(first_response_at, NOW()),
            resolution_seconds = CASE
              WHEN $2 THEN EXTRACT(EPOCH FROM (NOW() - submitted_at))::int
              ELSE resolution_seconds END,
            updated_at = NOW()
      WHERE id = $1`,
    [grievanceId, resolved],
  );
}

/* ------------------------------------------------------------------ *
 * Public map
 * ------------------------------------------------------------------ */

/**
 * Complaints near a point, for the map.
 *
 * Public, and therefore carries no identity at all: no name, no mobile, no
 * docket, no complaint text. Only what a neighbour needs to know that a
 * problem has already been reported - where, what kind, how far along, and
 * how many people are behind it.
 *
 * Coordinates are rounded to about 100 metres. A complaint about a specific
 * house, pinned exactly on a public map, identifies the household that made
 * it - which is the opposite of what an anonymous filing option is for.
 */
export async function publicMap({ pincode, division, status, limit = 200 }) {
  const params = [];
  const where = ['g.latitude IS NOT NULL', 'g.longitude IS NOT NULL'];

  if (pincode) { params.push(String(pincode)); where.push(`g.pincode = $${params.length}`); }
  if (division) { params.push(String(division)); where.push(`g.division_id = $${params.length}`); }
  if (status) { params.push(String(status)); where.push(`g.status = $${params.length}`); }
  params.push(Math.min(Number(limit) || 200, 500));

  const r = await query(
    `SELECT ROUND(g.latitude::numeric, 3)  AS lat,
            ROUND(g.longitude::numeric, 3) AS lng,
            g.division_id, g.status, g.priority_score, g.submitted_at,
            g.cluster_id,
            (SELECT COUNT(*)::int FROM grievance_supports s WHERE s.grievance_id = g.id) AS supporters
       FROM grievances g
      WHERE ${where.join(' AND ')}
      ORDER BY g.submitted_at DESC
      LIMIT $${params.length}`,
    params,
  );

  return r.rows.map((row) => ({
    lat: Number(row.lat),
    lng: Number(row.lng),
    division: divisionById(row.division_id)?.name || row.division_id,
    divisionId: row.division_id,
    status: row.status,
    priority: PRIORITY_LABEL[row.priority_score] || 'Medium',
    supporters: row.supporters,
    clusterId: row.cluster_id,
    filedOn: row.submitted_at,
  }));
}

/** Hotspots: where the same kind of problem keeps being reported. */
export async function hotspots({ limit = 50 } = {}) {
  const r = await query(
    `SELECT c.id, c.division_id, c.pincode, c.title, c.member_count, c.last_seen,
            (SELECT COUNT(*)::int FROM grievances g
              WHERE g.cluster_id = c.id AND g.status IN ('resolved','closed')) AS resolved
       FROM grievance_clusters c
      WHERE c.member_count > 1
      ORDER BY c.member_count DESC, c.last_seen DESC
      LIMIT $1`,
    [Math.min(Number(limit) || 50, 200)],
  );

  return r.rows.map((row) => ({
    clusterId: row.id,
    division: divisionById(row.division_id)?.name || row.division_id,
    divisionId: row.division_id,
    pincode: row.pincode,
    title: row.title,
    reports: row.member_count,
    resolved: row.resolved,
    lastReported: row.last_seen,
  }));
}

/* ------------------------------------------------------------------ *
 * Transparency
 * ------------------------------------------------------------------ */

/**
 * How each division is actually doing.
 *
 * Public and aggregate. Averages are over resolved cases only, because
 * including open ones would flatter a division that simply has not finished
 * anything yet - which is exactly the number a transparency score must not
 * be allowed to hide behind.
 */
export async function transparency() {
  const r = await query(
    `SELECT division_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
            COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed','rejected')
                               AND sla_deadline < NOW())::int AS overdue,
            ROUND(AVG(resolution_seconds) FILTER (WHERE resolution_seconds IS NOT NULL) / 86400.0, 1) AS avg_days,
            ROUND(AVG(satisfaction_rating) FILTER (WHERE satisfaction_rating IS NOT NULL), 2) AS avg_rating,
            COUNT(*) FILTER (WHERE satisfaction_rating IS NOT NULL)::int AS ratings
       FROM grievances
      WHERE division_id IS NOT NULL
      GROUP BY division_id
      ORDER BY total DESC`,
  );

  return r.rows.map((row) => {
    const resolutionRate = row.total > 0 ? row.resolved / row.total : 0;
    const onTime = row.total > 0 ? 1 - row.overdue / row.total : 1;
    const satisfaction = row.avg_rating ? Number(row.avg_rating) / 5 : null;

    /*
     * A single score, weighted toward whether the work actually got done.
     * Satisfaction only counts once somebody has rated something - a
     * division with no ratings is not thereby perfect, so it is left out of
     * the average rather than scored as zero or as full marks.
     */
    const parts = [resolutionRate * 0.45, onTime * 0.35];
    const score = satisfaction === null
      ? Math.round(((parts[0] + parts[1]) / 0.8) * 100)
      : Math.round((parts[0] + parts[1] + satisfaction * 0.2) * 100);

    return {
      divisionId: row.division_id,
      division: divisionById(row.division_id)?.name || row.division_id,
      total: row.total,
      resolved: row.resolved,
      overdue: row.overdue,
      averageDaysToResolve: row.avg_days === null ? null : Number(row.avg_days),
      averageRating: row.avg_rating === null ? null : Number(row.avg_rating),
      ratingsReceived: row.ratings,
      transparencyScore: Math.max(0, Math.min(100, score)),
    };
  });
}
