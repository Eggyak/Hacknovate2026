/**
 * Spoken status callbacks.
 *
 * A citizen who cannot read the dashboard asks to be told instead. They
 * pick one of the fourteen languages, the system rings the number on their
 * own record, and a synthesised voice reads back where their most recent
 * grievance has got to.
 *
 * Three deliberate limits, because a system that telephones people is one
 * worth being careful with:
 *
 *   It rings only the number already on the account. There is no field to
 *   type a number into, so this cannot be pointed at anyone else.
 *
 *   It reads status and nothing else - reference, division, state, due
 *   date. Not the complaint text, which is the citizen's own account of
 *   something that may be sensitive and does not need reciting down a line
 *   that could be on speakerphone.
 *
 *   The script is fixed when the call is requested. A status that changes
 *   in the minutes before the phone rings should not change what was
 *   promised; the call reports what was true when it was asked for.
 */

import { randomBytes } from 'node:crypto';
import { query } from '../lib/db.js';
import { env } from '../lib/env.js';
import { byCode } from '../data/languages.js';
import { divisionById } from '../data/divisions.js';
import { fromEnglish } from './translate.js';
import { synthesize } from './azureSpeech.js';

/** How many callbacks one citizen may ask for in an hour. */
const HOURLY_LIMIT = 3;

export function configured() {
  return Boolean(env.callbacks?.webhookUrl);
}

/**
 * The sentence the call will read, in English.
 *
 * Composed here rather than translated per clause so the translator sees a
 * whole sentence and can order it properly - Hindi and Tamil do not put the
 * verb where English does, and feeding a translator fragments produces
 * something that is words in the right language and not a sentence.
 */
function scriptFor(citizen, grievance) {
  const name = citizen.full_name ? citizen.full_name.split(' ')[0] : null;
  const greeting = name
    ? `Namaste ${name}. This is an automated update from M H A Samadhan.`
    : 'Namaste. This is an automated update from M H A Samadhan.';

  if (!grievance) {
    return `${greeting} You have no grievances on record yet. `
      + 'You can register one on the portal or in the app. Thank you.';
  }

  const division = divisionById(grievance.division_id);
  const status = String(grievance.status || 'submitted').replace(/_/g, ' ');

  /*
   * The reference is spelled out with spaces between the digits.
   *
   * A docket number read as "two thousand and twenty-six" is useless to
   * somebody writing it down, and every speech engine will do exactly that
   * to a bare numeral.
   */
  const spoken = String(grievance.reference_id || '')
    .split('')
    .join(' ')
    .replace(/- /g, 'dash ');

  const parts = [
    greeting,
    `Your grievance, reference ${spoken}, is currently ${status}.`,
  ];

  if (division) parts.push(`It is with the ${division.name} division.`);

  if (grievance.sla_deadline && !['resolved', 'closed'].includes(grievance.status)) {
    const due = new Date(grievance.sla_deadline).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    parts.push(`A reply is due by ${due}.`);
  }

  if (['resolved', 'closed'].includes(grievance.status)) {
    parts.push('This case has been closed. You can rate how it was handled on the portal.');
  }

  parts.push('Thank you.');
  return parts.join(' ');
}

/**
 * Queues a callback for this citizen.
 *
 * Returns the row, or a refusal with a reason the UI can show. Nothing is
 * dialled here - placing the call is the workflow's job, and this only
 * decides that one is owed and what it should say.
 */
export async function requestCallback(citizen, languageCode) {
  const lang = byCode(languageCode) || byCode('en');

  if (!citizen.mobile) {
    return { ok: false, reason: 'no_number', message: 'Your account has no mobile number.' };
  }

  const recent = await query(
    `SELECT COUNT(*)::int AS n FROM call_requests
      WHERE citizen_id = $1 AND requested_at > NOW() - INTERVAL '1 hour'`,
    [citizen.id],
  );
  if (recent.rows[0].n >= HOURLY_LIMIT) {
    return {
      ok: false,
      reason: 'rate_limited',
      message: `You can ask for ${HOURLY_LIMIT} calls an hour. Please try again later.`,
    };
  }

  const latest = await query(
    `SELECT reference_id, status, division_id, sla_deadline
       FROM grievances WHERE citizen_id = $1
      ORDER BY submitted_at DESC LIMIT 1`,
    [citizen.id],
  );
  const grievance = latest.rows[0] || null;

  const token = randomBytes(24).toString('base64url');
  const script = scriptFor(citizen, grievance);

  const saved = await query(
    `INSERT INTO call_requests (citizen_id, token, language, mobile, reference, script_en)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, token, language, status, requested_at, expires_at, reference`,
    [citizen.id, token, lang.code, citizen.mobile, grievance?.reference_id || null, script],
  );

  return { ok: true, call: saved.rows[0], language: lang };
}

/** A queued call, by its token. Expired ones are not resolvable. */
export async function callByToken(token) {
  const r = await query(
    `SELECT * FROM call_requests
      WHERE token = $1 AND expires_at > NOW() AND status <> 'expired'`,
    [String(token || '')],
  );
  return r.rows[0] || null;
}

export async function markCall(token, status, { sid = null, failure = null } = {}) {
  await query(
    `UPDATE call_requests
        SET status = $2,
            provider_sid = COALESCE($3, provider_sid),
            failure = $4,
            answered_at = CASE WHEN $2 = 'answered' THEN NOW() ELSE answered_at END
      WHERE token = $1`,
    [token, status, sid, failure],
  );
}

/**
 * The audio for one call, synthesised on demand.
 *
 * Not cached. The script is already fixed on the row, so the only thing
 * caching would save is one Azure call per callback - and storing
 * generated speech about somebody's grievance on disk is a liability for
 * no benefit worth having.
 */
export async function speakCall(call) {
  const lang = byCode(call.language) || byCode('en');

  let text = call.script_en;
  if (lang.code !== 'en') {
    const translated = await fromEnglish(call.script_en, lang.code);
    /*
     * `skipped` is how this translator reports every failure - a bad
     * status, a thrown request, or simply not being configured - and in
     * all three cases it hands back the English unchanged. So the test is
     * "did it actually translate", not "was there an error".
     *
     * A translator outage must not become silence on the line. English
     * read aloud is worse than the citizen's own language and far better
     * than a call that says nothing.
     */
    if (!translated?.skipped && translated?.text) text = translated.text;
  }

  return synthesize(text, lang.code, { gender: 'female' });
}

/**
 * Hands the queued call to whatever actually dials.
 *
 * A webhook rather than the Twilio SDK, for the same reason the OTP path
 * is a webhook: the credentials for the telephony account live in the
 * workflow engine, not in this process, and this service should not be
 * able to place a call on its own.
 */
export async function dispatch(call) {
  if (!configured()) {
    return { ok: false, reason: 'not_configured' };
  }

  try {
    const res = await fetch(env.callbacks.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.callbacks.secret ? { 'x-callback-secret': env.callbacks.secret } : {}),
      },
      body: JSON.stringify({
        token: call.token,
        to: `+91${call.mobile}`,
        language: call.language,
        // Where the dialler should fetch the spoken words from.
        twimlUrl: `${env.publicUrl}/api/calls/twiml/${call.token}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      await markCall(call.token, 'failed', { failure: `dispatch_http_${res.status}` });
      return { ok: false, reason: `http_${res.status}` };
    }

    const body = await res.json().catch(() => ({}));
    await markCall(call.token, 'placed', { sid: body.sid || null });
    return { ok: true, sid: body.sid || null };
  } catch (err) {
    await markCall(call.token, 'failed', { failure: err.message });
    return { ok: false, reason: err.message };
  }
}

/** Recent callbacks for this citizen, for the dashboard card. */
export async function recentCalls(citizenId, limit = 5) {
  const r = await query(
    `SELECT token, language, status, reference, requested_at, answered_at, failure
       FROM call_requests WHERE citizen_id = $1
      ORDER BY requested_at DESC LIMIT $2`,
    [citizenId, Math.min(Number(limit) || 5, 20)],
  );
  return r.rows;
}
