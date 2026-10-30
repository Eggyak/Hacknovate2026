/**
 * Azure Speech: tokens for the browser, text-to-speech, and a server-side
 * transcription fallback.
 *
 * Division of labour, and why:
 *
 *   Recognition happens in the BROWSER, over a websocket, using a short-lived
 *   token this module mints. That keeps the subscription key on the server,
 *   gives the citizen live partial transcripts while they are still speaking,
 *   and - the reason that actually decided it - uses the real-time quota
 *   rather than the Fast Transcription quota, which on a free-tier resource is
 *   small enough to exhaust during a demo.
 *
 *   Synthesis happens HERE, because the reply text originates here and
 *   proxying it lets us cache and keeps the key server-side.
 *
 *   `transcribeBuffer` exists for uploaded audio files, where there is no live
 *   session to attach to. It is a fallback, not the main path, and it reports
 *   quota exhaustion as a distinct, recognisable failure instead of an opaque
 *   500 - see the note on `locales` below, which is the single most important
 *   thing in this file.
 */

import { env } from '../lib/env.js';
import { byCode, byLocale, LANGUAGES } from '../data/languages.js';

const TOKEN_TTL_MS = 9 * 60 * 1000; // Azure tokens last 10 minutes; refresh at 9.
let cachedToken = null;
let cachedAt = 0;

export class SpeechUnavailable extends Error {
  constructor(message, { code = 'speech_unavailable', status = 503 } = {}) {
    super(message);
    this.name = 'SpeechUnavailable';
    this.code = code;
    this.status = status;
  }
}

function requireKey() {
  if (!env.azureSpeech.key) {
    throw new SpeechUnavailable('Azure Speech is not configured on this server.', {
      code: 'speech_not_configured',
    });
  }
}

function resourceEndpoint() {
  if (env.azureSpeech.endpoint) return env.azureSpeech.endpoint.replace(/\/+$/, '');
  return `https://${env.azureSpeech.region}.api.cognitive.microsoft.com`;
}

/**
 * Mint a recognition token for the browser. Cached, because every page load
 * would otherwise spend a round trip on one.
 */
export async function issueToken() {
  requireKey();
  const now = Date.now();
  if (cachedToken && now - cachedAt < TOKEN_TTL_MS) {
    return { token: cachedToken, region: env.azureSpeech.region, cached: true };
  }

  const res = await fetch(`${resourceEndpoint()}/sts/v1.0/issueToken`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.azureSpeech.key,
      'Content-Length': '0',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SpeechUnavailable(
      `Azure refused to issue a speech token (HTTP ${res.status}). ${body.slice(0, 200)}`,
      { code: res.status === 401 ? 'speech_bad_key' : 'speech_token_failed' },
    );
  }

  cachedToken = await res.text();
  cachedAt = now;
  return { token: cachedToken, region: env.azureSpeech.region, cached: false };
}

/** XML-escape, so a complaint containing "&" or "<" cannot break the SSML. */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function voiceFor(languageCode, gender = 'female') {
  const lang = byCode(languageCode) || byCode('en');
  return lang.voice[gender] || lang.voice.female;
}

/**
 * Speak `text` in `languageCode`. Returns an mp3 buffer.
 *
 * `rate` is slowed slightly by default: this is read aloud to people who may
 * be distressed, elderly, or hearing a second language.
 */
export async function synthesize(text, languageCode = 'en', { gender = 'female', rate = '-8%' } = {}) {
  requireKey();
  const clean = String(text || '').trim();
  if (!clean) throw new SpeechUnavailable('Nothing to speak.', { code: 'empty_text', status: 400 });
  if (clean.length > 3000) {
    throw new SpeechUnavailable('Text too long to synthesise in one request.', {
      code: 'text_too_long',
      status: 400,
    });
  }

  const lang = byCode(languageCode) || byCode('en');
  const voice = voiceFor(lang.code, gender);

  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang.locale}'>` +
    `<voice name='${voice}'><prosody rate='${rate}'>${escapeXml(clean)}</prosody></voice>` +
    `</speak>`;

  const res = await fetch(`https://${env.azureSpeech.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.azureSpeech.key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'mha-samadhan',
    },
    body: ssml,
  });

  if (res.status === 429) {
    throw new SpeechUnavailable('Azure Speech synthesis quota is exhausted. Try again shortly.', {
      code: 'speech_rate_limited',
      status: 429,
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SpeechUnavailable(`Speech synthesis failed (HTTP ${res.status}). ${body.slice(0, 200)}`, {
      code: 'tts_failed',
    });
  }

  return { audio: Buffer.from(await res.arrayBuffer()), voice, locale: lang.locale, mime: 'audio/mpeg' };
}

/**
 * Transcribe an uploaded audio file, identifying the language.
 *
 * On `locales`, which is subtle and worth stating plainly:
 *
 *   Passing an EMPTY list makes Azure use its general multilingual model. That
 *   sounds like the obvious choice for a 14-language portal, and it is wrong
 *   here - tested against Hindi audio it returned romanised Latin text tagged
 *   en-US at 0.38 confidence. For Indic languages the candidate list is what
 *   makes identification work.
 *
 *   So we always pass candidates. Azure's continuous identification evaluates
 *   at most 10, and we support 14, so buildLidCandidates() narrows the field
 *   using what we already know about this citizen - the language they chose,
 *   and the languages spoken where their PIN code is. English and Hindi are
 *   always retained as link languages.
 */
export async function transcribeBuffer(buffer, { candidates = [], filename = 'audio.wav' } = {}) {
  requireKey();

  const locales = candidates.length > 0 ? candidates : LANGUAGES.slice(0, 10).map((l) => l.locale);

  const form = new FormData();
  form.append('audio', new Blob([buffer]), filename);
  form.append('definition', JSON.stringify({ locales }));

  const res = await fetch(
    `${resourceEndpoint()}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`,
    {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': env.azureSpeech.key },
      body: form,
    },
  );

  if (res.status === 429) {
    throw new SpeechUnavailable(
      'Azure Fast Transcription quota is exhausted on this resource. Live microphone capture still works - it uses a separate quota.',
      { code: 'stt_rate_limited', status: 429 },
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SpeechUnavailable(`Transcription failed (HTTP ${res.status}). ${body.slice(0, 200)}`, {
      code: 'stt_failed',
    });
  }

  const data = await res.json();
  const text = (data.combinedPhrases || []).map((p) => p.text).join(' ').trim();
  const first = (data.phrases || [])[0] || {};
  const locale = first.locale || null;
  const lang = locale ? byLocale(locale) : null;

  return {
    text,
    locale,
    languageCode: lang ? lang.code : null,
    confidence: typeof first.confidence === 'number' ? Math.round(first.confidence * 100) / 100 : 0,
    durationMs: data.durationMilliseconds || 0,
    candidatesEvaluated: locales,
    provider: 'azure-fast-transcription',
  };
}

/** Live check used by /api/health. Cheap: one token request. */
export async function probe() {
  if (!env.azureSpeech.key) return { ok: false, reason: 'not_configured' };
  try {
    await issueToken();
    return { ok: true, region: env.azureSpeech.region };
  } catch (err) {
    return { ok: false, reason: err.code || 'unknown', message: err.message };
  }
}
