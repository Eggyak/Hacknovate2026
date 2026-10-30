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
import { env } from '../lib/env.js';

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

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GENDERS = ['Male', 'Female', 'Third Gender / Transgender', 'Prefer not to say'];

/**
 * Step 1, for both doors.
 *
 * `signup` collects the identity fields the data schema needs - name, gender,
 * email - and parks them on the OTP row. They become an account only in
 * /verify, on proof the citizen holds the number. Creating the record here
 * would let anyone squat on someone else's mobile number by starting a
 * sign-up they never finish.
 *
 * `signin` asks for the number and the email together. Where an account
 * already carries an email, the one typed must match it: the OTP proves
 * possession of the handset, and this is a second thing the holder of a
 * borrowed or recycled SIM would not know.
 */
authRouter.post('/start', startLimiter, async (req, res, next) => {
  try {
    const mode = req.body?.mode === 'signup' ? 'signup' : 'signin';
    const mobile = normaliseMobile(req.body?.mobile);
    const email = String(req.body?.email || '').trim();

    const found = await query(
      'SELECT id, full_name, email FROM citizens WHERE mobile = $1',
      [mobile],
    );
    const existing = found.rows[0] || null;
    const errors = [];
    let profile = {};

    if (mode === 'signup') {
      const fullName = String(req.body?.fullName || '').trim();
      const gender = String(req.body?.gender || '').trim();

      if (existing) {
        return res.status(409).json({
          error: 'already_registered',
          message: 'This mobile number already has an account. Sign in instead.',
        });
      }
      if (fullName.length < 2) errors.push({ field: 'fullName', message: 'Enter your full name.' });
      if (!GENDERS.includes(gender)) errors.push({ field: 'gender', message: 'Select your gender.' });
      // Email is optional at sign-up, per the data schema, but must be valid
      // if it is given at all.
      if (email && !EMAIL_RE.test(email)) {
        errors.push({ field: 'email', message: 'Enter a valid email address, or leave it blank.' });
      }
      if (req.body?.consent !== true) {
        errors.push({ field: 'consent', message: 'Confirm your particulars to continue.' });
      }

      if (errors.length > 0) return res.status(422).json({ error: 'validation_failed', errors });
      profile = { fullName, gender, email: email.toLowerCase() };
    } else {
      if (!existing) {
        return res.status(404).json({
          error: 'no_account',
          message: 'No account for this mobile number. Create one first.',
        });
      }
      if (!email || !EMAIL_RE.test(email)) {
        errors.push({ field: 'email', message: 'Enter the email address on your account.' });
      } else if (existing.email && existing.email.toLowerCase() !== email.toLowerCase()) {
        // Deliberately the same wording as a bad email, so this cannot be
        // used to discover which address an account holds.
        errors.push({ field: 'email', message: 'That email does not match this mobile number.' });
      }

      if (errors.length > 0) return res.status(422).json({ error: 'validation_failed', errors });
      // An older account with no address on file adopts the one just given.
      profile = existing.email ? {} : { email: email.toLowerCase() };
    }

    const result = await requestCode(mobile, { purpose: 'login', profile, email });

    return res.json({
      ok: true,
      mode,
      mobile: `+91 ${mobile.slice(0, 2)}••• ••${mobile.slice(-2)}`,
      isReturning: Boolean(existing),
      name: existing?.full_name || profile.fullName || null,
      expiresAt: result.expiresAt,
      ttlSeconds: result.ttlSeconds,
      resendAfter: 60,
      delivered: result.delivery.delivered,
      channel: result.delivery.channel || null,
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

/** The genders offered at sign-up, so the form and the server cannot drift. */
authRouter.get('/genders', (_req, res) => res.json({ genders: GENDERS }));

/** Step 2: the citizen types the code. A session is issued on success. */
authRouter.post('/verify', verifyLimiter, async (req, res, next) => {
  try {
    const { mobile, code } = req.body || {};
    const normalised = normaliseMobile(mobile);
    const { profile } = await verifyCode(normalised, code, { purpose: 'login' });

    const language = byCode(req.body?.language)?.code || 'en';

    // The number is proven, so the details given at sign-up become an account.
    // COALESCE on update rather than overwrite: signing in again must not
    // blank a name the citizen has since corrected on their profile.
    const upserted = await query(
      `INSERT INTO citizens (mobile, mobile_verified, preferred_language, full_name, gender, email)
       VALUES ($1, TRUE, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''))
       ON CONFLICT (mobile) DO UPDATE
         SET mobile_verified = TRUE,
             preferred_language = EXCLUDED.preferred_language,
             full_name = COALESCE(citizens.full_name, EXCLUDED.full_name),
             gender = COALESCE(citizens.gender, EXCLUDED.gender),
             email = COALESCE(citizens.email, EXCLUDED.email),
             updated_at = NOW()
       RETURNING id, mobile, mobile_verified, full_name, gender, email, preferred_language, created_at`,
      [normalised, language, profile?.fullName || '', profile?.gender || '', profile?.email || ''],
    );

    const citizen = upserted.rows[0];
    /*
     * The cookie is for the browser; the token is for everything else.
     *
     * A native client has no cookie jar worth relying on and would otherwise
     * have to scrape Set-Cookie, so the token is returned in the body too and
     * sent back as `Authorization: Bearer`. Both carry the same claims and the
     * same expiry - this is one session described two ways, not two sessions.
     */
    const token = issueSession(res, citizen);

    const isNew = new Date(citizen.created_at).getTime() > Date.now() - 5000;
    return res.json({
      ok: true,
      citizen,
      isNew,
      profileComplete: Boolean(citizen.full_name),
      token,
      expiresInSeconds: env.jwt.ttlSeconds,
    });
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
    if (genderValue && !GENDERS.includes(genderValue)) {
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
