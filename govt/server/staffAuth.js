/**
 * Second and third factors for staff sign-in.
 *
 * The workspace shipped with email and password, which is the right thing for
 * a local prototype and not enough for a desk that can read every citizen's
 * complaint in a division. Two things are added:
 *
 *   A departmental access key, shared by the staff who are allowed in at all.
 *   It is checked BEFORE the password, so a stolen or guessed credential is
 *   not even tested against an account unless the person already holds
 *   something issued separately and out of band.
 *
 *   A one-time code, sent to the address on the staff record. This is what
 *   turns a leaked password into a dead end: the code goes where the account
 *   says, not where the person signing in asks it to.
 *
 * The code is never stored. A salted scrypt hash is, with a short expiry and
 * an attempt ceiling, so reading this database does not hand anyone a working
 * sign-in. Delivery is n8n's job, exactly as on the citizen side - this file
 * owns generation, expiry and verification, which are the parts that have to
 * be right.
 */

import { createHash, randomInt, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const CODE_LENGTH = 6;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const CHALLENGE_SWEEP_MS = 10 * 60 * 1000;

export function createChallengeTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS login_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
}

/** Is the departmental access key configured, and does this request carry it? */
export function accessKeyRequired() {
  return Boolean(process.env.MHA_STAFF_ACCESS_KEY);
}

export function accessKeyValid(given) {
  const expected = process.env.MHA_STAFF_ACCESS_KEY ?? '';
  if (!expected) return true; // Not configured: the extra factor is simply off.
  const a = createHash('sha256').update(String(given ?? '')).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function hashCode(code, salt) {
  return `${salt}:${scryptSync(code, salt, 32).toString('hex')}`;
}

function codeMatches(code, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const a = Buffer.from(expected, 'hex');
  const b = scryptSync(code, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Issue a challenge for a user who has already proved key and password. */
export function issueChallenge(db, userId) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += randomInt(0, 10);

  const id = randomBytes(18).toString('base64url');
  const now = Date.now();

  db.transaction(() => {
    // One live challenge per account: a new sign-in attempt invalidates any
    // code still in flight, so two codes are never valid at once.
    db.prepare('UPDATE login_challenges SET consumed=1 WHERE user_id=? AND consumed=0').run(userId);
    db.prepare('INSERT INTO login_challenges(id,user_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(id, userId, hashCode(code, randomBytes(16).toString('hex')), now + CODE_TTL_MS, now);
  })();

  return { challengeId: id, code, expiresInSeconds: Math.round(CODE_TTL_MS / 1000) };
}

/**
 * Check a submitted code.
 *
 * Returns { ok, userId } or { ok: false, error }. Consumes the challenge on
 * success so a code cannot be replayed, and on exhaustion so a burnt
 * challenge cannot be ground down further.
 */
export function verifyChallenge(db, challengeId, submitted) {
  const code = String(submitted ?? '').replace(/\D/g, '');
  if (code.length !== CODE_LENGTH) return { ok: false, error: `Enter the ${CODE_LENGTH}-digit code.` };

  const row = db.prepare('SELECT * FROM login_challenges WHERE id=? AND consumed=0').get(String(challengeId ?? ''));
  if (!row) return { ok: false, error: 'That sign-in request has expired. Start again.' };

  if (row.expires_at < Date.now()) {
    db.prepare('UPDATE login_challenges SET consumed=1 WHERE id=?').run(row.id);
    return { ok: false, error: 'That code has expired. Start again.' };
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    db.prepare('UPDATE login_challenges SET consumed=1 WHERE id=?').run(row.id);
    return { ok: false, error: 'Too many incorrect attempts. Start again.' };
  }

  if (!codeMatches(code, row.code_hash)) {
    db.prepare('UPDATE login_challenges SET attempts=attempts+1 WHERE id=?').run(row.id);
    const left = Math.max(0, MAX_ATTEMPTS - (row.attempts + 1));
    return {
      ok: false,
      error: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.` : 'Incorrect code.',
    };
  }

  db.prepare('UPDATE login_challenges SET consumed=1 WHERE id=?').run(row.id);
  return { ok: true, userId: row.user_id };
}

/** Housekeeping: a consumed or expired challenge is of no further use. */
export function sweepChallenges(db) {
  db.prepare('DELETE FROM login_challenges WHERE consumed=1 OR expires_at < ?').run(Date.now() - CHALLENGE_SWEEP_MS);
}

/**
 * Hand the code to n8n for delivery, exactly as the citizen side does.
 *
 * Never throws. A delivery failure is reported to the caller so the sign-in
 * screen can say the code did not go out, rather than showing a code box for
 * a message that never left.
 */
export async function deliverCode({ code, email, mobile, name }) {
  const url = process.env.N8N_OTP_WEBHOOK_URL ?? '';
  if (!url) return { delivered: false, reason: 'otp_webhook_not_configured' };

  const digits = String(mobile ?? '').replace(/\D/g, '');
  const e164 = digits.length >= 10 ? `+91${digits.slice(-10)}` : '';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_OTP_API_KEY ? { 'X-API-Key': process.env.N8N_OTP_API_KEY } : {}),
      },
      body: JSON.stringify({
        e164,
        email: String(email ?? ''),
        code,
        purpose: 'staff-login',
        ttlSeconds: Math.round(CODE_TTL_MS / 1000),
        app: 'MHA Samadhan — Department Workspace',
        name: String(name ?? ''),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return { delivered: false, reason: `http_${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { delivered: data.delivered !== false, channel: data.channel ?? 'email' };
  } catch (error) {
    return { delivered: false, reason: `network_error: ${error.message}` };
  }
}
