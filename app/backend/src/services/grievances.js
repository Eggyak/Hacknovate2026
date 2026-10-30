/**
 * Creating, validating and tracking grievances.
 *
 * Implements section 1 of the data schema (the base fields every complaint
 * carries) and enforces section 2 (the dynamic details each division requires)
 * against divisions.js rather than against a hand-written list that would
 * drift from it.
 */

import { env } from '../lib/env.js';
import { query, transaction } from '../lib/db.js';
import { divisionById, fieldsFor } from '../data/divisions.js';
import { stateForPincode, isValidPincode } from '../data/states.js';

export class ValidationError extends Error {
  constructor(errors) {
    super('The grievance could not be accepted as submitted.');
    this.name = 'ValidationError';
    this.status = 422;
    this.code = 'validation_failed';
    this.errors = errors;
  }
}

/** Statuses a grievance moves through, in order. */
export const STATUSES = ['submitted', 'under_review', 'in_progress', 'resolved', 'closed', 'rejected'];

/**
 * Identifiers we are required to collect but must not keep in full.
 *
 * Aadhaar is the sharp case: the Disaster Management division needs it to
 * disburse relief, and the DPDP Act means we should not be sitting on a
 * readable copy. We keep the last four digits for the officer to match
 * against, and discard the rest. Bank accounts get the same treatment.
 */
function maskSensitiveValues(divisionId, details) {
  const fields = fieldsFor(divisionId);
  const out = { ...details };
  const masked = [];

  for (const field of fields) {
    if (!field.sensitive) continue;
    const raw = out[field.key];
    if (raw === undefined || raw === null || raw === '') continue;

    const digits = String(raw).replace(/\s/g, '');
    const last4 = digits.slice(-4);
    out[field.key] = `XXXX-XXXX-${last4}`;
    masked.push(field.key);
  }

  return { details: out, masked };
}

/** Validate the division-specific details against that division's schema. */
export function validateDynamicDetails(divisionId, details = {}) {
  const division = divisionById(divisionId);
  if (!division) return [{ field: 'division_id', message: 'Unknown division.' }];

  const errors = [];

  for (const field of division.fields) {
    const value = details[field.key];
    const empty = value === undefined || value === null || String(value).trim() === '';

    if (field.required && empty) {
      errors.push({ field: field.key, message: `${field.label} is required.` });
      continue;
    }
    if (empty) continue;

    const str = String(value).trim();

    if (field.pattern && !new RegExp(field.pattern).test(str.replace(/\s/g, ''))) {
      errors.push({ field: field.key, message: `${field.label} is not in the expected format.` });
    }
    if (field.type === 'currency') {
      const n = Number(str.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(n) || n <= 0) {
        errors.push({ field: field.key, message: `${field.label} must be an amount greater than zero.` });
      } else if (field.min && n < field.min) {
        errors.push({ field: field.key, message: `${field.label} must be at least ${field.min}.` });
      }
    }
    if (field.type === 'select' && field.options && !field.options.includes(str)) {
      errors.push({ field: field.key, message: `${field.label} must be one of: ${field.options.join(', ')}.` });
    }
  }

  // Keys the division does not define are dropped rather than stored, so a
  // crafted request cannot smuggle arbitrary JSON into the record.
  return errors;
}

function pickKnownKeys(divisionId, details = {}) {
  const allowed = new Set(fieldsFor(divisionId).map((f) => f.key));
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Allocate the next docket number for the current year, inside the caller's
 * transaction. The row lock is what makes two simultaneous submissions get
 * different numbers.
 */
async function nextReference(client) {
  const year = new Date().getFullYear();
  const r = await client.query(
    `INSERT INTO reference_counters (year, last_value)
     VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_value = reference_counters.last_value + 1
     RETURNING last_value`,
    [year],
  );
  const n = r.rows[0].last_value;
  return `MHA-GRV-${year}-${String(n).padStart(6, '0')}`;
}

/**
 * Register a grievance.
 *
 * Everything the schema calls a base field is validated here, including the
 * declaration of truth - a complaint without it is not a complaint, it is a
 * draft, and the API refuses it rather than storing a false compliance flag.
 */
export async function createGrievance(input) {
  const {
    citizenId,
    divisionId,
    originalText,
    translatedText = null,
    translationProvider = null,
    subject = null,
    detectedLanguage = null,
    detectedLocale = null,
    languageConfidence = 0,
    languageMethod = null,
    inputMode = 'text',
    classification = {},
    pincode = null,
    district = null,
    address = null,
    latitude = null,
    longitude = null,
    dynamicDetails = {},
    declarationTruth = false,
    audioPath = null,
    attachments = [],
  } = input;

  const errors = [];

  if (!citizenId) errors.push({ field: 'citizen', message: 'Sign in before submitting.' });
  if (!String(originalText || '').trim()) {
    errors.push({ field: 'original_text', message: 'Describe your grievance.' });
  }
  if (!divisionId || !divisionById(divisionId)) {
    errors.push({ field: 'division_id', message: 'Choose the department this concerns.' });
  }
  if (declarationTruth !== true) {
    errors.push({
      field: 'declaration_truth',
      message: 'You must declare that the information given is true.',
    });
  }
  if (pincode && !isValidPincode(pincode)) {
    errors.push({ field: 'pincode', message: 'Enter a valid 6-digit PIN code.' });
  }

  if (divisionId && divisionById(divisionId)) {
    errors.push(...validateDynamicDetails(divisionId, dynamicDetails));
  }

  if (errors.length > 0) throw new ValidationError(errors);

  const known = pickKnownKeys(divisionId, dynamicDetails);
  const { details, masked } = maskSensitiveValues(divisionId, known);

  const resolvedState = pincode ? stateForPincode(pincode) : null;
  const priority = classification.urgent ? 'high' : 'normal';

  return transaction(async (client) => {
    const reference = await nextReference(client);

    const inserted = await client.query(
      `INSERT INTO grievances (
         reference_id, citizen_id, division_id,
         classification_confidence, classification_method, classification_evidence, priority,
         original_text, translated_text, translation_provider, audio_path, subject,
         detected_language, detected_locale, language_confidence, language_method, input_mode,
         pincode, state, district, address, latitude, longitude,
         dynamic_details, declaration_truth,
         status, submitted_at, sla_deadline
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         $18, $19, $20, $21, $22, $23,
         $24, $25,
         'submitted', NOW(), NOW() + ($26 || ' days')::interval
       )
       RETURNING *`,
      [
        reference,
        citizenId,
        divisionId,
        Number(classification.confidence || 0),
        classification.method || null,
        JSON.stringify(classification.matched || []),
        priority,
        String(originalText).trim(),
        translatedText,
        translationProvider,
        audioPath,
        subject,
        detectedLanguage,
        detectedLocale,
        Number(languageConfidence || 0),
        languageMethod,
        inputMode,
        pincode,
        resolvedState ? resolvedState.name : null,
        district,
        address,
        latitude,
        longitude,
        JSON.stringify(details),
        true,
        String(env.sla.days),
      ],
    );

    const grievance = inserted.rows[0];

    for (const a of attachments) {
      await client.query(
        `INSERT INTO grievance_attachments
           (grievance_id, kind, original_name, stored_name, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [grievance.id, a.kind || 'evidence', a.originalName, a.storedName, a.mimeType, a.sizeBytes],
      );
    }

    await client.query(
      `INSERT INTO grievance_events (grievance_id, status, note, actor)
       VALUES ($1, 'submitted', $2, 'system')`,
      [
        grievance.id,
        `Registered and routed to ${divisionById(divisionId).name}` +
          (classification.method ? ` by ${classification.method}` : '') +
          (classification.confidence ? ` (confidence ${classification.confidence})` : ''),
      ],
    );

    await client.query(
      `INSERT INTO notifications (citizen_id, grievance_id, title, body)
       VALUES ($1, $2, $3, $4)`,
      [
        citizenId,
        grievance.id,
        `Grievance ${reference} registered`,
        `Routed to ${divisionById(divisionId).name}. Resolution is due by ${new Date(
          grievance.sla_deadline,
        ).toDateString()}.`,
      ],
    );

    return { grievance, masked };
  });
}

export async function listForCitizen(citizenId, { status = null, limit = 50, offset = 0 } = {}) {
  const params = [citizenId];
  let where = 'citizen_id = $1';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 50, 100), Number(offset) || 0);

  const r = await query(
    `SELECT g.*,
            (SELECT COUNT(*) FROM grievance_attachments a WHERE a.grievance_id = g.id) AS attachment_count
       FROM grievances g
      WHERE ${where}
      ORDER BY submitted_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return r.rows;
}

export async function getForCitizen(citizenId, reference) {
  const r = await query(
    'SELECT * FROM grievances WHERE citizen_id = $1 AND reference_id = $2',
    [citizenId, reference],
  );
  if (r.rows.length === 0) return null;

  const grievance = r.rows[0];
  const [events, attachments] = await Promise.all([
    query('SELECT * FROM grievance_events WHERE grievance_id = $1 ORDER BY created_at', [grievance.id]),
    query('SELECT id, kind, original_name, mime_type, size_bytes, created_at FROM grievance_attachments WHERE grievance_id = $1', [grievance.id]),
  ]);

  return { ...grievance, events: events.rows, attachments: attachments.rows };
}

/**
 * Public tracking by docket number alone, for a citizen who has the reference
 * but is not signed in. Returns only what is safe to show without
 * authentication: status and dates, never the complaint text or any
 * identifier.
 */
export async function trackPublic(reference) {
  const r = await query(
    `SELECT reference_id, division_id, status, priority, submitted_at, sla_deadline, closed_at
       FROM grievances WHERE reference_id = $1`,
    [String(reference || '').trim().toUpperCase()],
  );
  if (r.rows.length === 0) return null;

  const g = r.rows[0];
  const events = await query(
    'SELECT status, note, created_at FROM grievance_events WHERE grievance_id = (SELECT id FROM grievances WHERE reference_id = $1) ORDER BY created_at',
    [g.reference_id],
  );

  const division = divisionById(g.division_id);
  return {
    reference_id: g.reference_id,
    division: division ? { id: division.id, name: division.name, native: division.native } : null,
    status: g.status,
    priority: g.priority,
    submitted_at: g.submitted_at,
    sla_deadline: g.sla_deadline,
    closed_at: g.closed_at,
    sla: slaFor(g),
    events: events.rows,
  };
}

/** Days remaining against the statutory deadline, and whether it has been missed. */
export function slaFor(grievance) {
  const deadline = new Date(grievance.sla_deadline).getTime();
  const reference = grievance.closed_at ? new Date(grievance.closed_at).getTime() : Date.now();
  const msLeft = deadline - reference;
  const daysLeft = Math.ceil(msLeft / 86_400_000);

  return {
    days: env.sla.days,
    deadline: grievance.sla_deadline,
    daysLeft,
    breached: msLeft < 0,
    met: Boolean(grievance.closed_at) && msLeft >= 0,
  };
}

export async function addEvent(grievanceId, { status, note, actor = 'system' }) {
  return transaction(async (client) => {
    if (status) {
      if (!STATUSES.includes(status)) throw new ValidationError([{ field: 'status', message: 'Unknown status.' }]);
      await client.query(
        `UPDATE grievances
            SET status = $2,
                updated_at = NOW(),
                closed_at = CASE WHEN $2 IN ('resolved','closed','rejected') THEN NOW() ELSE closed_at END
          WHERE id = $1`,
        [grievanceId, status],
      );
    }
    const r = await client.query(
      'INSERT INTO grievance_events (grievance_id, status, note, actor) VALUES ($1, $2, $3, $4) RETURNING *',
      [grievanceId, status || 'note', note || null, actor],
    );
    return r.rows[0];
  });
}

/** Dashboard counters for one citizen. Computed, never hard-coded. */
export async function statsForCitizen(citizenId) {
  const r = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('submitted','under_review','in_progress'))::int AS active,
       COUNT(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
       COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed','rejected') AND sla_deadline < NOW())::int AS breached
     FROM grievances WHERE citizen_id = $1`,
    [citizenId],
  );
  return r.rows[0];
}
