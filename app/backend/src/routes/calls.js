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
  activeCall, cancelCall,
} from '../services/callback.js';
import { env } from '../lib/env.js';

export const callsRouter = Router();

/*
 * A runaway guard, not a quota.
 *
 * There is deliberately no per-citizen limit: somebody who cannot read
 * the dashboard may well need to hear it more than once, and metering
 * that is the wrong instinct for an accessibility feature.
 *
 * This ceiling is high enough that no person clicking a button can reach
 * it - ten a minute, sustained for an hour - and exists only so a stuck
 * script or a loop cannot run up a telephone bill unnoticed.
 */
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'rate_limited',
    message: 'That is far more calls than a person can ask for. Something is looping.',
  },
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
      // What is in flight, so the card can offer to stop it.
      active: await activeCall(req.citizen.id),
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

/**
 * Stop a call.
 *
 * Owned by the citizen it was placed for - a token on its own cannot
 * cancel somebody else's. With no token it stops whatever is currently in
 * flight, which is what the button on the dashboard means.
 */
callsRouter.post('/cancel', requireCitizen, async (req, res, next) => {
  try {
    const token = req.body?.token || (await activeCall(req.citizen.id))?.token;
    if (!token) {
      return res.status(404).json({ error: 'nothing_active', message: 'There is no call to stop.' });
    }

    const stopped = await cancelCall(req.citizen.id, token);
    if (!stopped) {
      return res.status(409).json({
        error: 'not_stoppable',
        message: 'That call has already finished.',
      });
    }

    return res.json({
      ok: true,
      message: 'Stopped. If the phone is already ringing it will end when answered.',
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

    /*
     * A cancelled call is answered with a hangup.
     *
     * This is what makes the stop button mean something: Twilio asks what
     * to say at the moment the call connects, and by then the citizen may
     * have changed their mind. Reading the status to somebody who just
     * pressed stop is worse than saying nothing.
     */
    if (call.status === 'cancelled') {
      return res.send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
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
 * What to dial, resolved from a token.
 *
 * The workflow is handed a token and nothing else, and asks here what to
 * do with it. That is the whole anti-abuse design: a dialler that accepts
 * a phone number from whoever calls its webhook is toll fraud waiting to
 * happen, and no amount of shared secrets fixes it as cleanly as simply
 * not accepting the number.
 *
 * So an attacker who reaches the webhook can only ask for a call that
 * this portal already queued, to the number this portal already chose,
 * for a citizen who already asked for it. A forged token resolves to
 * nothing.
 *
 * The token is the authorisation: 24 random bytes, single purpose,
 * expiring within the hour, and only ever sent to the dialler.
 */
callsRouter.get('/dispatch/:token', async (req, res, next) => {
  try {
    const call = await callByToken(req.params.token);
    if (!call) return res.status(404).json({ error: 'not_found' });

    /*
     * A cancelled call is never dialled.
     *
     * The TwiML route hangs up on one that has already connected, but
     * stopping it before the phone rings is the outcome somebody pressing
     * the button actually wants - and this is the last point where that
     * is still possible.
     */
    if (call.status === 'cancelled') {
      return res.status(409).json({ error: 'cancelled' });
    }

    if (!env.callbacks?.from) {
      return res.status(503).json({ error: 'no_caller_id' });
    }

    await markCall(call.token, 'placed');

    return res.json({
      to: `+91${call.mobile}`,
      from: env.callbacks.from,
      twimlUrl: `${env.publicUrl}/api/calls/twiml/${call.token}`,
      statusUrl: `${env.publicUrl}/api/calls/status`,
    });
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
