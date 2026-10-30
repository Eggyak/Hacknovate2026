/**
 * Handing a filed complaint to the department workspace.
 *
 * The two systems were built separately and name everything differently: our
 * division is `cyber`, theirs is CYBER_INFORMATION_SECURITY + CYBERCRIME; our
 * field is `transaction_id`, theirs is `transactionId`; our location is a PIN
 * code, theirs is a ward id that must already exist in their table. This
 * module is the whole of that translation, in one place, so neither side has
 * to know about the other's vocabulary.
 *
 * Two rules shape it:
 *
 *   A complaint is accepted before it is forwarded. The citizen's docket is
 *   issued by us, from our database, the moment they declare it true. If the
 *   department workspace is down, slow, or rejects the payload, that is our
 *   problem to retry - not a reason to tell someone their grievance failed.
 *
 *   Nothing is invented to satisfy their validator. Where we genuinely do not
 *   have a value their API wants, the complaint is held unsynced and the
 *   reason recorded, rather than padded with a plausible-looking default that
 *   would put a Punjab complaint on a Delhi desk.
 */

import { env } from '../lib/env.js';
import { query } from '../lib/db.js';
import { stateForPincode } from '../data/states.js';

/** Our division id -> their { divisionId, category }, from the integration guide. */
export const DIVISION_MAP = {
  cyber: { divisionId: 'CYBER_INFORMATION_SECURITY', category: 'CYBERCRIME' },
  foreigners: { divisionId: 'FOREIGNERS', category: 'IMMIGRATION' },
  disaster: { divisionId: 'DISASTER_MANAGEMENT', category: 'DISASTER_RELIEF' },
  freedom_fighters: { divisionId: 'FREEDOM_FIGHTERS_REHABILITATION', category: 'FREEDOM_FIGHTERS_REHABILITATION' },
  capf: { divisionId: 'CENTRAL_ARMED_POLICE_FORCES', category: 'CAPF_MISCONDUCT' },
  fcra: { divisionId: 'NGO_FCRA', category: 'FCRA_NGO' },
  ut: { divisionId: 'UT_ADMINISTRATION', category: 'UT_ADMIN' },
  internal_security: { divisionId: 'INTERNAL_SECURITY', category: 'INTERNAL_SECURITY' },
  counter_terror: { divisionId: 'COUNTER_TERRORISM', category: 'COUNTER_TERRORISM' },
  lwe_ne: { divisionId: 'LWE_NORTH_EAST', category: 'LWE_NORTH_EAST' },
  border: { divisionId: 'BORDER_MANAGEMENT', category: 'BORDER_MANAGEMENT' },
  judicial: { divisionId: 'JUDICIAL', category: 'JUDICIAL' },
  police: { divisionId: 'POLICE', category: 'POLICE' },
  centre_state: { divisionId: 'CENTRE_STATE', category: 'CENTRE_STATE' },
  internal_admin: { divisionId: 'INTERNAL_ADMINISTRATION', category: 'INTERNAL_DIVISIONS' },
  // Their triage desk. The guide is explicit that intake discards details for
  // OTHER, so the questions we asked travel in the narrative instead.
  other: { divisionId: 'OTHER_TRIAGE', category: 'OTHER' },
};

/**
 * Our field keys -> their detail keys.
 *
 * The guide warns against sending both an alias and its normalised name, so
 * each of ours maps to exactly one of theirs. `amountLost` is typed as a
 * number on their side; everything else is a string.
 */
const FIELD_MAP = {
  cyber: {
    transaction_id: 'transactionId',
    amount_lost: { key: 'amountLost', numeric: true },
    fraud_at: 'fraudDateTime',
    platform_used: 'platformUsed',
    suspect_details: 'suspectDetails',
  },
  foreigners: {
    passport_number: 'passportNumber',
    file_reference: 'applicationReferenceNumber',
    nationality: 'nationality',
    visa_type: 'visaType',
    issue_expiry: 'issueDate',
  },
  disaster: {
    aadhaar_number: 'aadhaarNumber',
    disaster_name: 'disasterName',
    damage_category: 'damageCategory',
    // bankAccountDetails is an object on their side; assembled below.
  },
  freedom_fighters: {
    ppo_number: 'ppoNumber',
    bank_branch: 'bankBranch',
    bank_ifsc: 'ifsc',
    fighter_name: 'freedomFighterName',
    sanction_date: 'sanctionDate',
  },
  capf: {
    force_name: 'forceName',
    officer_details: 'officerName',
    incident_at: 'incidentDate',
    misconduct_type: 'misconductType',
  },
  fcra: {
    ngo_name: 'ngoName',
    fcra_number: 'fcraRegistrationNumber',
    registration_state: 'registrationState',
    violation_nature: 'violationNature',
  },
  ut: {
    specific_ut: 'specificUt',
    civic_department: 'civicDepartment',
    ward_zone: 'wardOrZoneNumber',
    property_id: 'propertyId',
  },
  internal_security: {
    complaint_nature: 'complaintNature',
    target_location: 'targetLocation',
    suspect_org: 'suspectOrOrganization',
  },
  counter_terror: {
    radicalization_platform: 'radicalizationPlatform',
    threat_type: 'threatType',
    threat_target: 'threatLocationOrSubject',
  },
  lwe_ne: {
    region_village: 'regionOrVillage',
    complaint_nature: 'complaintNature',
    police_station: 'policeStationJurisdiction',
  },
  border: {
    border_name: 'borderNameOrState',
    village_post: 'villageOrPost',
    issue_category: 'issueCategory',
  },
  judicial: {
    prisoner_details: 'prisonerName',
    prison_name: 'prisonName',
    case_number: 'courtCaseOrFirNumber',
    petition_nature: 'petitionNature',
  },
  police: {
    officer_name: 'officerOrNomineeName',
    state_cadre: 'stateCadre',
    request_nature: 'requestNature',
  },
  centre_state: {
    states_involved: { key: 'statesInvolved', list: true },
    dispute_nature: 'disputeNature',
  },
  internal_admin: {
    query_type: 'queryType',
    reference_number: 'referenceNumberOrDate',
  },
};

/** Their gender allow-list. */
function mapGender(gender) {
  const g = String(gender || '').toLowerCase();
  if (g.startsWith('male')) return 'MALE';
  if (g.startsWith('female')) return 'FEMALE';
  if (g.includes('third') || g.includes('transgender')) return 'NON_BINARY';
  return 'NOT_SPECIFIED';
}

/** Translate our dynamic details into their per-category shape. */
export function mapDetails(divisionId, details = {}) {
  if (divisionId === 'other') return {};
  const map = FIELD_MAP[divisionId];
  if (!map) return {};

  const out = {};
  for (const [ours, spec] of Object.entries(map)) {
    const raw = details[ours];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;

    if (typeof spec === 'string') {
      out[spec] = String(raw);
      continue;
    }
    if (spec.numeric) {
      const n = Number(String(raw).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n)) out[spec.key] = n;
      continue;
    }
    if (spec.list) {
      out[spec.key] = String(raw).split(/\s*,\s*/).filter(Boolean);
    }
  }

  // Their disaster category nests the bank details, ours are two flat fields.
  if (divisionId === 'disaster') {
    const accountNumber = details.bank_account;
    const ifsc = details.bank_ifsc;
    if (accountNumber || ifsc) {
      out.bankAccountDetails = {
        accountNumber: String(accountNumber || ''),
        ifsc: String(ifsc || ''),
      };
    }
  }

  return out;
}

/**
 * Choose the ward their API will accept.
 *
 * A city ward wins whenever the PIN code reaches one, because it is the more
 * precise answer; otherwise the state desk takes it. Returns null rather than
 * guessing when neither matches - a complaint on the wrong desk is harder to
 * find than one that was never forwarded.
 */
export function pickWard(wards, pincode, stateName) {
  const pin = String(pincode || '').trim();

  if (/^\d{6}$/.test(pin)) {
    const byPrefix = wards
      .filter((w) => w.pincodePrefix && pin.startsWith(String(w.pincodePrefix)))
      .sort((a, b) => String(b.pincodePrefix).length - String(a.pincodePrefix).length);
    if (byPrefix.length > 0) return byPrefix[0].id;
  }

  const state = stateName || (stateForPincode(pin) || {}).name;
  if (state) {
    const byState = wards.find((w) => String(w.state).toLowerCase() === String(state).toLowerCase());
    if (byState) return byState.id;
  }

  return null;
}

let wardCache = null;
let wardCachedAt = 0;
const WARD_TTL_MS = 10 * 60 * 1000;

/**
 * Their ward list, cached - it changes about never.
 *
 * A stale copy is served when the refresh fails. The list is effectively
 * static reference data, and letting a momentary hiccup fetching it block a
 * citizen's complaint from reaching a desk would be the wrong way round.
 * Only a cold cache with no fetch is a real failure.
 */
export async function fetchWards() {
  const now = Date.now();
  if (wardCache && now - wardCachedAt < WARD_TTL_MS) return wardCache;

  try {
    const res = await fetch(`${env.govt.baseUrl}/api/intake/wards`, {
      headers: serviceHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ward list unavailable (HTTP ${res.status})`);

    const data = await res.json();
    const wards = Array.isArray(data.wards) ? data.wards : [];
    if (wards.length === 0) throw new Error('ward list came back empty');

    wardCache = wards;
    wardCachedAt = now;
    return wardCache;
  } catch (err) {
    if (wardCache) {
      console.warn(`[govt] ward list refresh failed (${err.message}); using the cached copy`);
      return wardCache;
    }
    throw err;
  }
}

function serviceHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(env.govt.serviceKey ? { 'X-Service-Key': env.govt.serviceKey } : {}),
  };
}

export function configured() {
  return Boolean(env.govt.baseUrl);
}

/**
 * Build the intake payload for a grievance row of ours.
 *
 * Returns { ok, payload } or { ok: false, reason } when something their API
 * requires is genuinely missing on our side.
 */
export async function buildPayload(grievance, citizen) {
  const mapping = DIVISION_MAP[grievance.division_id];
  if (!mapping) return { ok: false, reason: `no mapping for division ${grievance.division_id}` };

  if (!grievance.translated_text) {
    // Their API requires both texts. Ours is optional until a translator is
    // configured, so say which it is rather than sending the original twice
    // and labelling it a translation.
    return { ok: false, reason: 'no English rendering available to send' };
  }

  let wards;
  try {
    wards = await fetchWards();
  } catch (err) {
    return { ok: false, reason: `ward list: ${err.message}` };
  }

  const wardId = pickWard(wards, grievance.pincode, grievance.state);
  if (!wardId) return { ok: false, reason: `no ward matches PIN ${grievance.pincode || '(none)'}` };

  const details = mapDetails(grievance.division_id, grievance.dynamic_details || {});

  /*
   * For their triage desk the details are discarded by design, so the
   * questions we asked and the answers given are folded into the English
   * narrative. Otherwise a triage officer sees a complaint with every
   * follow-up answer stripped out.
   */
  let translated = grievance.translated_text;
  if (grievance.division_id === 'other') {
    const asked = Array.isArray(grievance.dynamic_labels) ? grievance.dynamic_labels : [];
    const answers = grievance.dynamic_details || {};
    const extra = asked
      .map((q) => (answers[q.key] ? `${q.label}\n  ${answers[q.key]}` : null))
      .filter(Boolean);
    if (extra.length > 0) {
      translated = `${translated}\n\n--- Follow-up questions asked by the assistant ---\n${extra.join('\n')}`;
    }
  }

  return {
    ok: true,
    payload: {
      complainantName: citizen.full_name || 'Citizen',
      mobileNumber: `+91${citizen.mobile}`,
      wardId,
      divisionId: mapping.divisionId,
      category: mapping.category,
      detectedLanguage: grievance.detected_language || 'Hindi',
      originalRegionalText: String(grievance.original_text).slice(0, 10_000),
      translatedEnglishText: String(translated).slice(0, 10_000),
      location: {
        state: grievance.state || '',
        district: grievance.district || '',
        pincode: grievance.pincode || '',
        completeAddress: grievance.address || '',
        coordinates: {
          latitude: Number(grievance.latitude) || 0,
          longitude: Number(grievance.longitude) || 0,
        },
      },
      details,
      complainantProfile: {
        otpVerified: Boolean(citizen.mobile_verified),
        gender: mapGender(citizen.gender),
        ...(citizen.email ? { email: citizen.email } : {}),
      },
      declarationOfTruth: Boolean(grievance.declaration_truth),
      audioFileUrl: grievance.audio_path ? `${env.publicUrl}/api/grievances/audio/${grievance.audio_path}` : '',
      evidence: [],
      // Our docket, so a case can be matched across the two systems without
      // relying on name and timestamp.
      citizenReference: grievance.reference_id,
    },
  };
}

/**
 * Forward one grievance. Records the outcome on our row either way.
 *
 * Never throws: a failure here must not reach the citizen, who has already
 * been given a docket by us and told their complaint is filed.
 */
export async function forwardGrievance(grievanceId) {
  if (!configured()) {
    await recordFailure(grievanceId, 'department workspace not configured');
    return { ok: false, reason: 'not_configured' };
  }

  const r = await query(
    `SELECT g.*, c.full_name, c.mobile, c.mobile_verified, c.gender, c.email
       FROM grievances g JOIN citizens c ON c.id = g.citizen_id
      WHERE g.id = $1`,
    [grievanceId],
  );
  if (r.rows.length === 0) return { ok: false, reason: 'not_found' };

  const row = r.rows[0];
  const citizen = {
    full_name: row.full_name,
    mobile: row.mobile,
    mobile_verified: row.mobile_verified,
    gender: row.gender,
    email: row.email,
  };

  const built = await buildPayload(row, citizen);
  if (!built.ok) {
    await recordFailure(grievanceId, built.reason);
    return { ok: false, reason: built.reason };
  }

  let res;
  try {
    res = await fetch(`${env.govt.baseUrl}/api/intake/grievances`, {
      method: 'POST',
      headers: serviceHeaders(),
      body: JSON.stringify(built.payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    await recordFailure(grievanceId, `network: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const reason = `HTTP ${res.status} ${body.slice(0, 200)}`;
    await recordFailure(grievanceId, reason);
    return { ok: false, reason };
  }

  const data = await res.json().catch(() => ({}));
  const ticket = data.ticket || {};

  await query(
    `UPDATE grievances
        SET govt_ticket_id = $2, govt_grievance_id = $3,
            govt_synced_at = NOW(), govt_sync_error = NULL, updated_at = NOW()
      WHERE id = $1`,
    [grievanceId, ticket.id || null, ticket.grievanceId || null],
  );

  await query(
    `INSERT INTO grievance_events (grievance_id, status, note, actor)
     VALUES ($1, 'under_review', $2, 'system')`,
    [grievanceId, `Forwarded to the department workspace as ${ticket.grievanceId || 'a new case'}.`],
  );

  return { ok: true, ticketId: ticket.id, grievanceId: ticket.grievanceId };
}

async function recordFailure(grievanceId, reason) {
  await query(
    'UPDATE grievances SET govt_sync_error = $2, updated_at = NOW() WHERE id = $1',
    [grievanceId, String(reason).slice(0, 500)],
  );
  console.warn(`[govt] grievance ${grievanceId} not forwarded: ${reason}`);
}

/**
 * Retry whatever has not reached the department yet.
 *
 * Runs on a timer. A complaint that could not be forwarded when it was filed
 * - the workspace restarting, a translator that had not finished - must not
 * sit unsent forever because nothing ever looks at it again.
 */
export async function retryPending(limit = 10) {
  if (!configured()) return { attempted: 0 };

  const r = await query(
    `SELECT id FROM grievances
      WHERE govt_synced_at IS NULL
        AND submitted_at > NOW() - INTERVAL '7 days'
      ORDER BY submitted_at
      LIMIT $1`,
    [limit],
  );

  let ok = 0;
  for (const row of r.rows) {
    const result = await forwardGrievance(row.id);
    if (result.ok) ok += 1;
  }
  return { attempted: r.rows.length, forwarded: ok };
}

/**
 * Map their status onto ours.
 *
 * Their workspace owns the lifecycle once a case reaches it, so this is a
 * one-way translation: we never push a status back, we only reflect theirs.
 */
const STATUS_MAP = {
  PENDING: 'submitted',
  UNDER_INVESTIGATION: 'in_progress',
  RESOLVED: 'resolved',
};

/**
 * Refresh what the department has done with cases we forwarded.
 *
 * This is what makes the citizen's tracking page true rather than a record of
 * the moment they filed. Only cases that actually reached a desk are polled,
 * oldest-updated first, and a status change is written to the timeline so the
 * citizen can see when it moved and what was said.
 */
export async function refreshStatuses(limit = 25) {
  if (!configured()) return { checked: 0 };

  const r = await query(
    `SELECT id, reference_id, govt_grievance_id, status, govt_status
       FROM grievances
      WHERE govt_grievance_id IS NOT NULL
        AND status NOT IN ('closed','rejected')
      ORDER BY COALESCE(govt_status_at, submitted_at)
      LIMIT $1`,
    [limit],
  );

  let changed = 0;
  for (const row of r.rows) {
    const remote = await fetchStatus(row.govt_grievance_id);
    if (!remote) continue;

    const mapped = STATUS_MAP[remote.status] || row.status;
    const movedStatus = mapped !== row.status;
    const movedRemote = remote.status !== row.govt_status;
    if (!movedStatus && !movedRemote) continue;

    await query(
      /*
       * $2 is cast at every use. It appears both as a column value and
       * inside a CASE comparison, and without the casts Postgres infers a
       * different type for each and refuses the statement outright with
       * "inconsistent types deduced for parameter $2".
       */
      `UPDATE grievances
          SET status = $2::text,
              govt_status = $3::text,
              govt_report = $4::text,
              govt_status_at = NOW(),
              closed_at = CASE WHEN $2::text IN ('resolved','closed')
                               THEN COALESCE(closed_at, NOW()) ELSE closed_at END,
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, mapped, remote.status, remote.actionTakenReport || null],
    );

    if (movedStatus) {
      await query(
        `INSERT INTO grievance_events (grievance_id, status, note, actor)
         VALUES ($1, $2, $3, 'department')`,
        [
          row.id,
          mapped,
          remote.actionTakenReport
            ? `Department update: ${String(remote.actionTakenReport).slice(0, 400)}`
            : `The department marked this ${String(remote.status).toLowerCase().replace(/_/g, ' ')}.`,
        ],
      );

      await query(
        // Cast explicitly: in a SELECT list Postgres has nothing to infer a
        // bare parameter's type from, and deduces "inconsistent types".
        `INSERT INTO notifications (citizen_id, grievance_id, title, body)
         SELECT citizen_id, id, $2::text, $3::text FROM grievances WHERE id = $1`,
        [
          row.id,
          `${row.reference_id} is now ${mapped.replace(/_/g, ' ')}`,
          remote.actionTakenReport || 'The handling department has updated your grievance.',
        ],
      );
    }
    changed += 1;
  }

  return { checked: r.rows.length, changed };
}

/**
 * Collect officer replies and put them in the citizen's thread.
 *
 * Pulled, then acknowledged, rather than the department pushing: a portal
 * that was down for an hour catches up by itself instead of an officer's
 * reply being lost to a failed webhook. Acknowledging only after the insert
 * succeeds means a crash in between repeats a reply rather than dropping it,
 * and a duplicate the citizen can see beats an answer they never got.
 */
export async function collectReplies() {
  if (!configured()) return { collected: 0 };

  let payload;
  try {
    const res = await fetch(`${env.govt.baseUrl}/api/intake/replies`, {
      headers: serviceHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { collected: 0, reason: `http_${res.status}` };
    payload = await res.json();
  } catch (err) {
    return { collected: 0, reason: err.message };
  }

  const replies = Array.isArray(payload.replies) ? payload.replies : [];
  if (replies.length === 0) return { collected: 0 };

  const done = [];
  for (const reply of replies) {
    const g = await query(
      'SELECT id, citizen_id, reference_id FROM grievances WHERE govt_grievance_id = $1',
      [reply.grievance_id],
    );
    if (g.rows.length === 0) {
      // Not ours - acknowledge so it does not block the queue for ever.
      done.push(reply.id);
      continue;
    }

    const row = g.rows[0];
    await query(
      `INSERT INTO grievance_comments (grievance_id, author_kind, author_name, body)
       VALUES ($1, 'department', $2, $3)`,
      [row.id, reply.author_name || 'Handling officer', String(reply.body).slice(0, 2000)],
    );
    await query(
      `INSERT INTO notifications (citizen_id, grievance_id, title, body)
       VALUES ($1, $2, $3::text, $4::text)`,
      [
        row.citizen_id, row.id,
        `The department replied on ${row.reference_id}`,
        String(reply.body).slice(0, 300),
      ],
    );
    done.push(reply.id);
  }

  if (done.length > 0) {
    try {
      await fetch(`${env.govt.baseUrl}/api/intake/replies/ack`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify({ ids: done }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // They stay pending and arrive again next sweep. A repeated reply is
      // recoverable; a lost one is not.
    }
  }

  return { collected: done.length };
}

/** Ask the department what has happened to a case since. */
export async function fetchStatus(govtGrievanceId) {
  if (!configured() || !govtGrievanceId) return null;
  try {
    const res = await fetch(
      `${env.govt.baseUrl}/api/intake/status/${encodeURIComponent(govtGrievanceId)}`,
      { headers: serviceHeaders(), signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
