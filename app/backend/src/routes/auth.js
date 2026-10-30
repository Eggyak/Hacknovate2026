/**
 * Sign-in and sign-up, both over mobile OTP.
 *
 * There is no password anywhere in this system. The citizen proves they hold
 * the number by receiving a code on it, which is both the strongest factor we
 * can offer without Aadhaar integration and the only one that works for a
 * citizen who has never used the portal before.
 *
 * Sign-up and sign-in are therefore the same flow. /start reports whether the
 * number is already known so the UI can say "welcome back" rather than making
 * the citizen pick the right button before they have proved anything.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../lib/db.js';
import { issueSession, clearSession, requireCitizen } from '../lib/auth.js';
import { requestCode, verifyCode, normaliseMobile, OtpError } from '../services/otp.js';
import { byCode } from '../data/languages.js';

export const authRouter = Router();

// Per-IP ceiling, on top of the per-number limits inside the OTP service.
const startLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many requests from this device. Try again later.' },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts from this device. Try again later.' },
});

function handleOtpError(err, res) {
  if (err instanceof OtpError) {
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    return res.status(err.status).json({ error: err.code, message: err.message, retryAfter: err.retryAfter });
  }
  throw err;
}

/** Step 1: the citizen types their mobile number. */
authRouter.post('/start', startLimiter, async (req, res, next) => {
  try {
    const mobile = normaliseMobile(req.body?.mobile);

    const existing = await query('SELECT id, full_name FROM citizens WHERE mobile = $1', [mobile]);
    const result = await requestCode(mobile, { purpose: 'login' });

    return res.json({
      ok: true,
      mobile: `******${mobile.slice(-4)}`,
      isReturning: existing.rows.length > 0,
      name: existing.rows[0]?.full_name || null,
      expiresAt: result.expiresAt,
      ttlSeconds: result.ttlSeconds,
      delivered: result.delivery.delivered,
      // Present only when delivery failed, so the UI can say what went wrong
      // instead of showing a code-entry box for a message that never arrived.
      deliveryIssue: result.delivery.delivered ? null : result.delivery.reason,
      devCode: result.devCode,
    });
  } catch (err) {
    try {
      return handleOtpError(err, res);
    } catch (rethrown) {
      return next(rethrown);
    }
  }
});

/** Step 2: the citizen types the code. A session is issued on success. */
authRouter.post('/verify', verifyLimiter, async (req, res, next) => {
  try {
    const { mobile, code } = req.body || {};
    const normalised = normaliseMobile(mobile);
    await verifyCode(normalised, code, { purpose: 'login' });

    const language = byCode(req.body?.language)?.code || 'en';

    // First sight of this number creates the citizen. Repeat sign-ins update
    // nothing except the verification flag and the chosen language.
    const upserted = await query(
      `INSERT INTO citizens (mobile, mobile_verified, preferred_language)
       VALUES ($1, TRUE, $2)
       ON CONFLICT (mobile) DO UPDATE
         SET mobile_verified = TRUE,
             preferred_language = EXCLUDED.preferred_language,
             updated_at = NOW()
       RETURNING id, mobile, mobile_verified, full_name, gender, email, preferred_language, created_at`,
      [normalised, language],
    );

    const citizen = upserted.rows[0];
    issueSession(res, citizen);

    const isNew = new Date(citizen.created_at).getTime() > Date.now() - 5000;
    return res.json({ ok: true, citizen, isNew, profileComplete: Boolean(citizen.full_name) });
  } catch (err) {
    try {
      return handleOtpError(err, res);
    } catch (rethrown) {
      return next(rethrown);
    }
  }
});

/** Who am I. The UI calls this on load to decide what to render. */
authRouter.get('/me', (req, res) => {
  if (!req.citizen) return res.status(401).json({ error: 'sign_in_required' });
  return res.json({ citizen: req.citizen, profileComplete: Boolean(req.citizen.full_name) });
});

/**
 * Complete or update the profile. These are base fields from the schema -
 * name and gender are required on every complaint, so they are collected once
 * here instead of on every submission.
 */
authRouter.patch('/profile', requireCitizen, async (req, res, next) => {
  try {
    const { fullName, gender, email, preferredLanguage } = req.body || {};
    const errors = [];

    const name = String(fullName || '').trim();
    if (name && name.length < 2) errors.push({ field: 'fullName', message: 'Enter your full name.' });

    const mail = String(email || '').trim();
    if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) {
      errors.push({ field: 'email', message: 'Enter a valid email address, or leave it blank.' });
    }

    const genderValue = String(gender || '').trim();
    if (genderValue && !['Male', 'Female', 'Other', 'Prefer not to say'].includes(genderValue)) {
      errors.push({ field: 'gender', message: 'Choose one of the listed options.' });
    }

    if (errors.length > 0) {
      return res.status(422).json({ error: 'validation_failed', errors });
    }

    const r = await query(
      `UPDATE citizens
          SET full_name = COALESCE(NULLIF($2,''), full_name),
              gender = COALESCE(NULLIF($3,''), gender),
              email = CASE WHEN $4 = '' THEN email ELSE $4 END,
              preferred_language = COALESCE($5, preferred_language),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, mobile, mobile_verified, full_name, gender, email, preferred_language`,
      [req.citizen.id, name, genderValue, mail, byCode(preferredLanguage)?.code || null],
    );

    return res.json({ ok: true, citizen: r.rows[0], profileComplete: Boolean(r.rows[0].full_name) });
  } catch (err) {
    return next(err);
  }
});

authRouter.post('/signout', (req, res) => {
  clearSession(res);
  return res.json({ ok: true });
});
