/**
 * Spoken status callbacks.
 *
 * Two audiences, two kinds of protection. A citizen asking for a call is
 * signed in and rate-limited. Twilio fetching the words to say has no
 * session and never will - it is a third party calling in over the public
 * internet - so those routes are gated on an unguessable, expiring,
 * single-purpose token and expose nothing but synthesised audio.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireCitizen } from '../lib/auth.js';
import { LANGUAGES } from '../data/languages.js';
import {
  configured, requestCallback, callByToken, markCall, speakCall, dispatch, recentCalls,
} from '../services/callback.js';
import { env } from '../lib/env.js';

export const callsRouter = Router();

/*
 * Tight, and per IP rather than per account.
 *
 * The per-citizen ceiling lives in the service because that is the limit
 * that matters - three calls an hour to one number. This one is here to
 * stop a single machine queueing calls across many accounts.
 */
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many call requests. Try again later.' },
});

/** Which languages the call can be taken in, and whether it is available. */
callsRouter.get('/options', requireCitizen, async (req, res, next) => {
  try {
    res.json({
      available: configured(),
      // Said plainly rather than left as a disabled button with no reason.
      unavailableReason: configured()
        ? null
        : 'Telephone callbacks are not switched on for this deployment.',
      languages: LANGUAGES.map((l) => ({
        code: l.code, name: l.name, native: l.native,
      })),
      // The number that will be rung, masked. Nobody can type another one.
      callsTo: req.citizen.mobile
        ? `+91 ${req.citizen.mobile.slice(0, 2)}••• ••${req.citizen.mobile.slice(-2)}`
        : null,
      recent: await recentCalls(req.citizen.id),
    });
  } catch (err) {
    next(err);
  }
});

/** Ask to be called back. */
callsRouter.post('/request', requireCitizen, requestLimiter, async (req, res, next) => {
  try {
    if (!configured()) {
      return res.status(503).json({
        error: 'not_configured',
        message: 'Telephone callbacks are not switched on for this deployment.',
      });
    }

    const result = await requestCallback(req.citizen, req.body?.language);
    if (!result.ok) {
      return res.status(result.reason === 'rate_limited' ? 429 : 422).json({
        error: result.reason,
        message: result.message,
      });
    }

    /*
     * Handed to the dialler immediately, but a dispatch failure is not a
     * failed request. The row is queued and can be retried; telling the
     * citizen "that did not work" when the call is still owed to them
     * would be wrong.
     */
    const sent = await dispatch({ ...result.call, mobile: req.citizen.mobile });

    /*
     * Say which of the two happened.
     *
     * "Queued, the call will be placed as soon as the line is free" reads
     * as a promise, and it is only true when something is going to pick
     * the job up. If the dialler refused - no credential attached yet, no
     * Twilio account reachable - then nobody is coming, and telling
     * somebody their phone is about to ring when it is not is worse than
     * telling them it did not work.
     */
    return res.status(sent.ok ? 201 : 503).json({
      ok: sent.ok,
      queued: true,
      placed: sent.ok,
      language: result.language.native || result.language.name,
      reference: result.call.reference,
      message: sent.ok
        ? 'Your phone will ring shortly.'
        : 'The telephone line is not answering right now, so no call was placed. '
          + 'Your request is on record and nothing else about your grievance is affected.',
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Telephony side. No session, token only.
 * ------------------------------------------------------------------ */

/**
 * What Twilio should say, as TwiML.
 *
 * `<Play>` rather than `<Say>`: Twilio's own voices do not cover these
 * fourteen languages, and the ones they do cover they read with an accent
 * that makes an Indian docket number hard to follow. The audio is Azure
 * neural speech in the citizen's chosen language, fetched from the route
 * below.
 */
callsRouter.all('/twiml/:token', async (req, res, next) => {
  try {
    const call = await callByToken(req.params.token);

    res.set('Content-Type', 'text/xml; charset=utf-8');

    if (!call) {
      // A spoken refusal, not a 404: Twilio reads the body to the caller,
      // and an error page played down the line is silence.
      return res.send(
        '<?xml version="1.0" encoding="UTF-8"?>'
        + '<Response><Say language="en-IN">Sorry, this update has expired.'
        + ' Please request a new call from the portal.</Say></Response>',
      );
    }

    await markCall(call.token, 'answered');

    const audio = `${env.publicUrl}/api/calls/audio/${encodeURIComponent(call.token)}`;
    return res.send(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Response>'
      // A beat before speaking: the first second of a call is lost to the
      // handset connecting, and a greeting spoken into that is missed.
      + '<Pause length="1"/>'
      + `<Play>${audio}</Play>`
      + `<Pause length="1"/><Play>${audio}</Play>`
      + '</Response>',
    );
  } catch (err) {
    next(err);
  }
});

/**
 * The spoken words themselves.
 *
 * Public by necessity and safe by construction: the token is unguessable
 * and expires within the hour, and what it yields is a status reading with
 * no complaint text, no name and no number in it.
 */
callsRouter.get('/audio/:token', async (req, res, next) => {
  try {
    const call = await callByToken(req.params.token);
    if (!call) return res.status(404).json({ error: 'not_found' });

    const { audio, mime, voice } = await speakCall(call);

    res.set('Content-Type', mime);
    // Twilio may fetch this twice for the repeat; let it reuse the first.
    res.set('Cache-Control', 'private, max-age=120');
    res.set('X-Voice', voice);
    return res.send(audio);
  } catch (err) {
    next(err);
  }
});

/**
 * How the call went, reported by the workflow once Twilio is done.
 *
 * Guarded by the shared secret rather than a session, because the caller
 * is the workflow engine and not a person.
 */
callsRouter.post('/status', async (req, res, next) => {
  try {
    const secret = env.callbacks?.secret;
    if (secret && req.get('x-callback-secret') !== secret) {
      return res.status(401).json({ error: 'unauthorised' });
    }

    const { token, status, sid, failure } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token_required' });

    const allowed = ['placed', 'answered', 'failed'];
    if (!allowed.includes(status)) return res.status(422).json({ error: 'bad_status' });

    await markCall(token, status, { sid, failure });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
