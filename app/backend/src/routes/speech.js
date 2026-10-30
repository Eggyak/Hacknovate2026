/**
 * Speech endpoints.
 *
 * /token   mints a short-lived Azure token for the browser recogniser. The
 *          subscription key never leaves this container.
 * /speak   synthesises a bot reply. Proxied rather than done in the browser so
 *          the key stays here and so replies can be cached.
 * /transcribe  server-side fallback for an uploaded audio file.
 */

import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireCitizen } from '../lib/auth.js';
import { issueToken, synthesize, transcribeBuffer, SpeechUnavailable } from '../services/azureSpeech.js';
import { getConversation, lidCandidatesFor } from '../services/conversation.js';
import { LANGUAGES, byCode, buildLidCandidates } from '../data/languages.js';
import { languagesForPincode } from '../data/states.js';
import { env } from '../lib/env.js';

export const speechRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function fail(res, err) {
  if (err instanceof SpeechUnavailable) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  throw err;
}

/**
 * A recognition token plus the candidate locales the browser should ask Azure
 * to identify between. Ten at most - see data/languages.js for how they are
 * chosen and why that is honest rather than a shortcut.
 */
speechRouter.get('/token', requireCitizen, async (req, res, next) => {
  try {
    const { token, region } = await issueToken();

    let candidates;
    if (req.query.conversationId) {
      const conversation = await getConversation(req.citizen.id, Number(req.query.conversationId));
      candidates = conversation
        ? lidCandidatesFor(conversation, req.citizen)
        : buildLidCandidates({ preferred: req.citizen.preferred_language });
    } else {
      candidates = buildLidCandidates({
        preferred: req.query.language || req.citizen.preferred_language,
        stateLanguages: req.query.pincode ? languagesForPincode(String(req.query.pincode)) : [],
      });
    }

    return res.json({
      token,
      region,
      candidates,
      supported: LANGUAGES.length,
      note: `Azure evaluates up to ${candidates.length} candidate locales per utterance; ${LANGUAGES.length} languages are supported overall.`,
    });
  } catch (err) {
    try {
      return fail(res, err);
    } catch (rethrown) {
      return next(rethrown);
    }
  }
});

const speakLimiter = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false });

/** Speak a line of text. Returns audio/mpeg. */
speechRouter.post('/speak', requireCitizen, speakLimiter, async (req, res, next) => {
  try {
    const { text, language = 'en', gender = 'female' } = req.body || {};
    const lang = byCode(language) || byCode('en');
    const { audio, voice, locale, mime } = await synthesize(text, lang.code, {
      gender: gender === 'male' ? 'male' : 'female',
    });

    res.set('Content-Type', mime);
    res.set('Cache-Control', 'private, max-age=600');
    res.set('X-Voice', voice);
    res.set('X-Locale', locale);
    return res.send(audio);
  } catch (err) {
    try {
      return fail(res, err);
    } catch (rethrown) {
      return next(rethrown);
    }
  }
});

/**
 * Transcribe an uploaded recording.
 *
 * The live browser path is preferred and this is the fallback, so a quota
 * failure here is reported as exactly that - with the advice that the
 * microphone path uses a different quota - rather than as a generic error.
 */
speechRouter.post('/transcribe', requireCitizen, upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'no_audio', message: 'Attach an audio file.' });
    }

    const candidates = req.body?.conversationId
      ? lidCandidatesFor(
          await getConversation(req.citizen.id, Number(req.body.conversationId)),
          req.citizen,
        )
      : buildLidCandidates({ preferred: req.citizen.preferred_language });

    const result = await transcribeBuffer(req.file.buffer, {
      candidates,
      filename: req.file.originalname || 'audio.wav',
    });

    return res.json(result);
  } catch (err) {
    try {
      return fail(res, err);
    } catch (rethrown) {
      return next(rethrown);
    }
  }
});

/** The languages this portal speaks, for the picker. */
speechRouter.get('/languages', (_req, res) => {
  res.json({
    languages: LANGUAGES.map((l) => ({
      code: l.code,
      locale: l.locale,
      name: l.name,
      native: l.native,
      script: l.script,
      dir: l.dir,
      voice: l.voice.female,
    })),
    speechEnabled: Boolean(env.azureSpeech.key),
  });
});
