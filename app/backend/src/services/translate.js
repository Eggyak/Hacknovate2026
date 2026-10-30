/**
 * Regional text to English, for the "Translated English Text" field the data
 * schema requires on every complaint.
 *
 * Translation is an ENRICHMENT here, never a dependency. Routing runs on the
 * citizen's own words (see classifier.js) and succeeds with this module
 * switched off entirely. When no translator is configured the complaint is
 * still accepted, still routed, still tracked - it simply carries no English
 * rendering, and says so rather than storing the original text twice and
 * calling the second copy a translation.
 *
 * Azure Translator is a SEPARATE resource from Azure Speech with its own key.
 * A Speech key will authenticate against the Speech endpoints and return 401
 * against this one; that is expected, not a bug, and `configured` reflects it.
 */

import { env } from '../lib/env.js';

export const PROVIDER = 'azure-translator';

export function configured() {
  return Boolean(env.azureTranslator.key);
}

/**
 * Translate `text` into English.
 *
 * Returns { text, provider, from, skipped, reason }. `text` is null when no
 * translation could be produced - callers must treat that as "no English
 * rendering available" and never substitute the original.
 */
export async function toEnglish(text, { from = null } = {}) {
  const clean = String(text || '').trim();

  if (!clean) {
    return { text: null, provider: null, from, skipped: true, reason: 'empty_input' };
  }

  if (from === 'en') {
    return { text: clean, provider: 'passthrough', from: 'en', skipped: false, reason: 'already_english' };
  }

  if (!configured()) {
    return {
      text: null,
      provider: null,
      from,
      skipped: true,
      reason: 'translator_not_configured',
    };
  }

  const url = new URL('/translate', env.azureTranslator.endpoint);
  url.searchParams.set('api-version', '3.0');
  url.searchParams.set('to', 'en');
  if (from) url.searchParams.set('from', from);

  const headers = {
    'Ocp-Apim-Subscription-Key': env.azureTranslator.key,
    'Content-Type': 'application/json',
  };
  if (env.azureTranslator.region) {
    headers['Ocp-Apim-Subscription-Region'] = env.azureTranslator.region;
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ Text: clean.slice(0, 5000) }]),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { text: null, provider: PROVIDER, from, skipped: true, reason: `network_error: ${err.message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      text: null,
      provider: PROVIDER,
      from,
      skipped: true,
      reason: `http_${res.status}`,
      detail: body.slice(0, 200),
    };
  }

  const data = await res.json().catch(() => null);
  const translation = data?.[0]?.translations?.[0]?.text || null;
  const detected = data?.[0]?.detectedLanguage?.language || from;

  return {
    text: translation,
    provider: PROVIDER,
    from: detected,
    skipped: translation === null,
    reason: translation === null ? 'no_translation_returned' : null,
  };
}

/**
 * Translate English into the citizen's language, for bot replies.
 *
 * The bot's own prompts are pre-translated into all 14 languages (see
 * data/phrases.js), so this is only used for text that cannot be known in
 * advance. Returns the English unchanged when unavailable - acceptable here,
 * because an English prompt is still a usable prompt, whereas a fake
 * "translation" of a citizen's complaint would be a falsified record.
 */
export async function fromEnglish(text, to) {
  const clean = String(text || '').trim();
  if (!clean || !to || to === 'en' || !configured()) {
    return { text: clean, provider: null, skipped: true };
  }

  const url = new URL('/translate', env.azureTranslator.endpoint);
  url.searchParams.set('api-version', '3.0');
  url.searchParams.set('from', 'en');
  url.searchParams.set('to', to);

  const headers = {
    'Ocp-Apim-Subscription-Key': env.azureTranslator.key,
    'Content-Type': 'application/json',
  };
  if (env.azureTranslator.region) {
    headers['Ocp-Apim-Subscription-Region'] = env.azureTranslator.region;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ Text: clean.slice(0, 5000) }]),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { text: clean, provider: PROVIDER, skipped: true, reason: `http_${res.status}` };
    const data = await res.json();
    return {
      text: data?.[0]?.translations?.[0]?.text || clean,
      provider: PROVIDER,
      skipped: false,
    };
  } catch (err) {
    return { text: clean, provider: PROVIDER, skipped: true, reason: err.message };
  }
}

/** Live check for /api/health. */
export async function probe() {
  if (!configured()) return { ok: false, reason: 'not_configured' };
  const r = await toEnglish('नमस्ते', { from: 'hi' });
  return r.text ? { ok: true } : { ok: false, reason: r.reason, detail: r.detail };
}
