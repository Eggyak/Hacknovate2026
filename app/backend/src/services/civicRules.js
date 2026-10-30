/**
 * The rules behind Core Features: how urgent a complaint is, and whether two
 * complaints are the same problem.
 *
 * Deliberately separated from civic.js, which talks to the database. These
 * are the decisions most worth testing - a wrong priority band or a wrong
 * grouping is a judgement about someone's complaint - and a test for them
 * should not need a Postgres connection to run.
 */

import { divisionById } from '../data/divisions.js';

/* ------------------------------------------------------------------ *
 * Priority
 * ------------------------------------------------------------------ */

export const PRIORITY = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

export const PRIORITY_LABEL = { 4: 'Critical', 3: 'High', 2: 'Medium', 1: 'Low' };

/**
 * Score a complaint's urgency from what the classifier already found.
 *
 * Deliberately not a second model. The classifier detects threats to life
 * while routing, and a separate judgement here could disagree with the one
 * the citizen was shown - which is worse than being slightly coarse.
 *
 *   critical  someone is in danger now
 *   high      money gone, or a statutory deadline at stake
 *   medium    a service failure
 *   low       information, status, feedback
 */
export function scorePriority({ classification = {}, divisionId, details = {} }) {
  if (classification.urgent) return PRIORITY.CRITICAL;

  // A fraud with a real sum attached outranks a general complaint.
  const amount = Number(String(details.amount_lost ?? '').replace(/[^0-9.]/g, ''));
  if (Number.isFinite(amount) && amount >= 10_000) return PRIORITY.HIGH;

  if (['counter_terror', 'internal_security', 'disaster', 'judicial'].includes(divisionId)) {
    return PRIORITY.HIGH;
  }
  if (divisionId === 'internal_admin') return PRIORITY.LOW;

  return PRIORITY.MEDIUM;
}

/* ------------------------------------------------------------------ *
 * Duplicate detection
 * ------------------------------------------------------------------ */

/**
 * A signature for "the same problem, in the same place".
 *
 * Built from the division, the PIN code and the distinctive terms the
 * classifier already matched - not from the free text, which two people
 * describing one pothole will never write the same way. Using the matched
 * terms means the signature is derived from the same evidence that routed
 * the complaint, so a cluster can always be explained.
 */
export function clusterSignature({ divisionId, pincode, classification = {} }) {
  const terms = (classification.matched || [])
    .filter((m) => m.weight >= 2)
    .map((m) => String(m.term).toLowerCase())
    .sort()
    .slice(0, 6);

  if (terms.length === 0) return null; // Nothing distinctive: do not group.
  return terms.join('|');
}

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
            c.member_count,
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
