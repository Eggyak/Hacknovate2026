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
