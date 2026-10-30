/**
 * One-time passcodes for citizen sign-in.
 *
 * We own generation, hashing, expiry, attempt limits and rate limiting.
 * n8n owns delivery to Twilio. The split matters: delivery is the part that
 * changes (SMS today, WhatsApp or voice tomorrow) and the part that belongs to
 * an operations tool. Everything security-relevant stays in the application,
 * where it can be tested.
 *
 * The code is never stored. A scrypt hash with a per-code salt is, so reading
 * the database does not hand anyone a working login.
 */

import { randomInt, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../lib/env.js';
import { query } from '../lib/db.js';

const scrypt = promisify(scryptCb);

export class OtpError extends Error {
  constructor(message, { code = 'otp_error', status = 400, retryAfter = null } = {}) {
    super(message);
    this.name = 'OtpError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Indian mobile numbers, normalised to bare 10 digits. */
export function normaliseMobile(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (!/^[6-9][0-9]{9}$/.test(local)) {
    throw new OtpError('Enter a valid 10-digit Indian mobile number.', { code: 'bad_mobile' });
  }
  return local;
}

function generateCode(length) {
  let code = '';
  for (let i = 0; i < length; i += 1) code += randomInt(0, 10);
  return code;
}

async function hashCode(code, salt) {
  const derived = await scrypt(code, salt, 32);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyHash(code, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const derived = await scrypt(code, salt, 32);
  const a = Buffer.from(expected, 'hex');
  const b = derived;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Hand the code to n8n for delivery.
 *
 * A delivery failure does NOT discard the code: the row stays valid so a
 * resend can reuse the window, and the caller is told delivery failed rather
 * than being shown a success screen for a message that never left.
 */
async function deliver({ mobile, code, purpose }) {
  if (!env.otp.webhookUrl) {
    return { delivered: false, channel: null, reason: 'otp_webhook_not_configured' };
  }

  try {
    const res = await fetch(env.otp.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.otp.apiKey ? { 'X-API-Key': env.otp.apiKey } : {}),
      },
      body: JSON.stringify({
        mobile,
        e164: `+91${mobile}`,
        code,
        purpose,
        ttlSeconds: env.otp.ttlSeconds,
        app: 'MHA Samadhan',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { delivered: false, channel: null, reason: `http_${res.status}`, detail: body.slice(0, 200) };
    }

    const data = await res.json().catch(() => ({}));
    return { delivered: data.delivered !== false, channel: data.channel || 'sms', providerId: data.sid || null };
  } catch (err) {
    return { delivered: false, channel: null, reason: `network_error: ${err.message}` };
  }
}

/**
 * Issue a passcode for `mobile`.
 *
 * Rate limited two ways: a cooldown between sends, and a ceiling on how many
 * codes one number may be issued in an hour. Both are enforced in the
 * database, so they survive a restart and apply across processes.
 */
export async function requestCode(mobileInput, { purpose = 'login' } = {}) {
  const mobile = normaliseMobile(mobileInput);

  const recent = await query(
    `SELECT created_at
       FROM otp_codes
      WHERE mobile = $1 AND created_at > NOW() - INTERVAL '1 hour'
      ORDER BY created_at DESC`,
    [mobile],
  );

  if (recent.rows.length >= 5) {
    throw new OtpError('Too many codes requested for this number. Try again in an hour.', {
      code: 'otp_hourly_limit',
      status: 429,
      retryAfter: 3600,
    });
  }

  if (recent.rows.length > 0) {
    const elapsed = (Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000;
    if (elapsed < env.otp.resendCooldownSeconds) {
      const wait = Math.ceil(env.otp.resendCooldownSeconds - elapsed);
      throw new OtpError(`Please wait ${wait} seconds before requesting another code.`, {
        code: 'otp_cooldown',
        status: 429,
        retryAfter: wait,
      });
    }
  }

  // Any earlier unused code for this number stops working the moment a new
  // one is issued, so two live codes never exist at once.
  await query(
    `UPDATE otp_codes SET consumed_at = NOW()
      WHERE mobile = $1 AND consumed_at IS NULL AND expires_at > NOW()`,
    [mobile],
  );

  const code = generateCode(env.otp.length);
  const codeHash = await hashCode(code, randomBytes(16).toString('hex'));
  const delivery = await deliver({ mobile, code, purpose });

  const inserted = await query(
    `INSERT INTO otp_codes (mobile, code_hash, purpose, expires_at, delivery)
     VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval, $5)
     RETURNING id, expires_at`,
    [mobile, codeHash, purpose, String(env.otp.ttlSeconds), JSON.stringify(delivery)],
  );

  return {
    mobile,
    expiresAt: inserted.rows[0].expires_at,
    ttlSeconds: env.otp.ttlSeconds,
    delivery,
    // Only ever populated when explicitly enabled outside production, for
    // bring-up before Twilio is wired. env.js refuses this in production.
    devCode: env.otp.echoForDev && env.nodeEnv !== 'production' ? code : undefined,
  };
}

/**
 * Check a submitted code. Consumes it on success so it cannot be replayed.
 * Counts attempts against the specific code, not the number, so an attacker
 * cannot lock a citizen out by guessing at their own request.
 */
export async function verifyCode(mobileInput, submitted, { purpose = 'login' } = {}) {
  const mobile = normaliseMobile(mobileInput);
  const code = String(submitted || '').replace(/\D/g, '');

  if (code.length !== env.otp.length) {
    throw new OtpError(`Enter the ${env.otp.length}-digit code.`, { code: 'otp_malformed' });
  }

  const found = await query(
    `SELECT id, code_hash, attempts, expires_at
       FROM otp_codes
      WHERE mobile = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [mobile, purpose],
  );

  if (found.rows.length === 0) {
    throw new OtpError('No active code for this number. Request a new one.', { code: 'otp_not_found' });
  }

  const row = found.rows[0];

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query('UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1', [row.id]);
    throw new OtpError('That code has expired. Request a new one.', { code: 'otp_expired' });
  }

  if (row.attempts >= env.otp.maxAttempts) {
    await query('UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1', [row.id]);
    throw new OtpError('Too many incorrect attempts. Request a new code.', {
      code: 'otp_attempts_exceeded',
      status: 429,
    });
  }

  const ok = await verifyHash(code, row.code_hash);

  if (!ok) {
    const updated = await query(
      'UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [row.id],
    );
    const left = Math.max(0, env.otp.maxAttempts - updated.rows[0].attempts);
    throw new OtpError(
      left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.` : 'Incorrect code.',
      { code: 'otp_incorrect' },
    );
  }

  await query('UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1', [row.id]);
  return { mobile, verified: true };
}

/** Housekeeping: drop codes that can no longer be used. */
export async function purgeExpired() {
  const r = await query(
    `DELETE FROM otp_codes
      WHERE created_at < NOW() - INTERVAL '24 hours'`,
  );
  return r.rowCount;
}
