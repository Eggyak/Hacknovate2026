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
import { STATES, stateForPincode } from '../data/states.js';

// Re-exported so callers import one module, not two.
export { PRIORITY, PRIORITY_LABEL, scorePriority, clusterSignature };

/* ------------------------------------------------------------------ *
 * Duplicate detection (the parts that touch the database)
 * ------------------------------------------------------------------ */

/**
 * Attach a grievance to the cluster for its problem, creating one if needed.
 *
 * Returns { clusterId, memberCount, isNew } or null when the complaint is
 * not groupable. Runs inside the caller's transaction where there is one, so
 * two simultaneous reports of the same thing cannot create two clusters.
 */
export async function assignCluster(client, grievance, classification) {
  const signature = clusterSignature({
    divisionId: grievance.division_id,
    pincode: grievance.pincode,
    classification,
  });
  if (!signature || !grievance.pincode) return null;

  const division = divisionById(grievance.division_id);
  const title = `${division ? division.name : grievance.division_id} near ${grievance.pincode}`;

  const upserted = await client.query(
    `INSERT INTO grievance_clusters (division_id, pincode, signature, title, member_count)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (division_id, pincode, signature) DO UPDATE
       SET member_count = grievance_clusters.member_count + 1,
           last_seen = NOW()
     RETURNING id, member_count, (xmax = 0) AS inserted`,
    [grievance.division_id, grievance.pincode, signature, title],
  );
  /*
   * `member_count` here is a running tally for ordering and nothing more.
   * It is never decremented when a grievance is deleted, so it is an upper
   * bound rather than a fact, and anything shown to anybody counts the
   * rows instead - see hotspots() and findSimilar().
   */

  const row = upserted.rows[0];
  await client.query('UPDATE grievances SET cluster_id = $2 WHERE id = $1', [grievance.id, row.id]);

  return { clusterId: row.id, memberCount: row.member_count, isNew: row.inserted };
}

/**
 * Complaints that look like the one being written, before it is filed.
 *
 * Offered so a citizen can add their weight to an existing report instead of
 * creating the forty-first copy of it. Only ever a suggestion: the citizen
 * may know something the other reports do not, and must always be able to
 * file their own.
 */
export async function findSimilar({ divisionId, pincode, classification, excludeCitizenId }) {
  const signature = clusterSignature({ divisionId, pincode, classification });
  if (!signature || !pincode) return [];

  const r = await query(
    `SELECT g.reference_id, g.subject, g.status, g.submitted_at, g.priority_score,
            -- Live, for the same reason as hotspots: member_count drifts.
            (SELECT COUNT(*)::int FROM grievances m WHERE m.cluster_id = c.id) AS member_count,
            (SELECT COUNT(*)::int FROM grievance_supports s WHERE s.grievance_id = g.id) AS supporters
       FROM grievances g
       JOIN grievance_clusters c ON c.id = g.cluster_id
      WHERE c.division_id = $1 AND c.pincode = $2 AND c.signature = $3
        AND g.citizen_id <> $4
        AND g.status NOT IN ('closed','rejected')
      ORDER BY g.submitted_at DESC
      LIMIT 5`,
    [divisionId, pincode, signature, excludeCitizenId || 0],
  );
  return r.rows;
}


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
 *
 * Which is why a filing marked anonymous is left off this map entirely.
 * Rounding is enough for an ordinary complaint and not enough for one
 * somebody asked to keep quiet: a hundred metres in a village is one
 * street. It stays in the state-level heatmap, where a whole state is far
 * too coarse to point at anyone, and the handling department sees it in
 * full - an anonymous complaint is hidden from the public, not from the
 * officer who has to investigate it.
 */
export async function publicMap({ pincode, division, status, limit = 200 }) {
  const params = [];
  const where = ['g.latitude IS NOT NULL', 'g.longitude IS NOT NULL', 'g.anonymous = FALSE'];

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

/**
 * Hotspots: where the same kind of problem keeps being reported.
 *
 * Counted from the grievances themselves, not from `member_count`.
 *
 * That column only ever goes up - assignCluster increments it on conflict
 * and nothing decrements it - so when a grievance is deleted the cluster
 * keeps claiming a member it no longer has. Three rounds of end-to-end
 * tests, each filing two reports and then deleting its own citizens, left a
 * cluster insisting it held six. Every one of those would have been
 * published here as a report by a real person.
 *
 * A counter that can drift has no business being the number a public page
 * shows. Counting the rows costs one join and cannot be wrong.
 */
export async function hotspots({ limit = 50 } = {}) {
  const r = await query(
    `SELECT c.id, c.division_id, c.pincode, c.title, c.last_seen,
            COUNT(g.id)::int AS reports,
            COUNT(g.id) FILTER (WHERE g.status IN ('resolved','closed'))::int AS resolved
       FROM grievance_clusters c
       JOIN grievances g ON g.cluster_id = c.id
      GROUP BY c.id, c.division_id, c.pincode, c.title, c.last_seen
     HAVING COUNT(g.id) > 1
      ORDER BY COUNT(g.id) DESC, c.last_seen DESC
      LIMIT $1`,
    [Math.min(Number(limit) || 50, 200)],
  );

  return r.rows.map((row) => ({
    clusterId: row.id,
    division: divisionById(row.division_id)?.name || row.division_id,
    divisionId: row.division_id,
    pincode: row.pincode,
    title: row.title,
    reports: row.reports,
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

/**
 * Complaint density by state, for the heatmap.
 *
 * Grouped by state rather than by coordinate because that is the only
 * geography this data reliably has. A pincode resolves to a state for every
 * complaint; latitude and longitude are optional and most filings never pin
 * a location, so a coordinate heatmap would be drawn from the small subset
 * of people who happened to share their position - and would read as if the
 * rest of the country had no complaints.
 *
 * `state` on the row is the state's display name, which is what the
 * interview stored. It is mapped back to a code here so the client can
 * place each one without carrying its own copy of the table.
 */
export async function heatmap({ divisionId = null, days = null, pincode = null } = {}) {
  const where = ['state IS NOT NULL'];
  const params = [];

  if (divisionId) {
    params.push(divisionId);
    where.push(`division_id = $${params.length}`);
  }
  if (days) {
    params.push(Math.min(Number(days) || 365, 3650));
    where.push(`submitted_at > NOW() - ($${params.length} || ' days')::interval`);
  }

  const r = await query(
    `SELECT state,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
            COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed','rejected')
                               AND sla_deadline < NOW())::int AS overdue
       FROM grievances
      WHERE ${where.join(' AND ')}
      GROUP BY state`,
    params,
  );

  const byName = new Map(STATES.map((s) => [s.name, s]));

  const states = r.rows.map((row) => {
    const match = byName.get(row.state);
    return {
      code: match ? match.code : null,
      name: row.state,
      total: row.total,
      resolved: row.resolved,
      overdue: row.overdue,
      open: row.total - row.resolved,
    };
  });

  return {
    states,
    // The client scales its colour ramp against this rather than picking
    // its own ceiling, so two charts drawn minutes apart stay comparable.
    busiest: states.reduce((most, s) => Math.max(most, s.total), 0),
    total: states.reduce((sum, s) => sum + s.total, 0),
  };
}


/**
 * Complaint density by district, around one pincode.
 *
 * The state view answers "where in the country"; a citizen wants "where
 * near me", and a state is far too coarse for that - Punjab as one tile
 * tells somebody in Ludhiana nothing they did not know.
 *
 * The area is resolved from a pincode rather than from device
 * coordinates. Latitude and longitude would be the obvious input, but
 * turning them into a district needs a geocoding service we do not have,
 * and most filings carry no coordinates at all - so a radius query would
 * be drawn from the handful of people who shared a position and would
 * read as if nowhere else had complaints. Every complaint has a pincode,
 * and every pincode resolves to a state.
 *
 * Anonymous filings are included: a district is a large enough area that
 * a count cannot point at anyone, which is the same reason they stay in
 * the state figures while being kept off the coordinate map.
 */
export async function districtHeatmap({ pincode, divisionId = null, days = null }) {
  const home = stateForPincode(String(pincode || ''));
  if (!home) return { scope: 'district', area: null, districts: [], busiest: 0, total: 0 };

  const where = ['state = $1', 'district IS NOT NULL'];
  const params = [home.name];

  if (divisionId) {
    params.push(divisionId);
    where.push(`division_id = $${params.length}`);
  }
  if (days) {
    params.push(Math.min(Number(days) || 365, 3650));
    where.push(`submitted_at > NOW() - ($${params.length} || ' days')::interval`);
  }

  const r = await query(
    `SELECT district,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
            COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed','rejected')
                               AND sla_deadline < NOW())::int AS overdue
       FROM grievances
      WHERE ${where.join(' AND ')}
      GROUP BY district
      ORDER BY total DESC
      LIMIT 60`,
    params,
  );

  const districts = r.rows.map((row) => ({
    name: row.district,
    total: row.total,
    resolved: row.resolved,
    overdue: row.overdue,
    open: row.total - row.resolved,
  }));

  return {
    scope: 'district',
    area: home.name,
    stateCode: home.code,
    districts,
    busiest: districts.reduce((most, d) => Math.max(most, d.total), 0),
    total: districts.reduce((sum, d) => sum + d.total, 0),
  };
}
