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
import * as mistral from './mistral.js';
import { byCode } from '../data/languages.js';

export const PROVIDER = 'azure-translator';

function languageName(code) {
  return byCode(code)?.name || null;
}

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
    // No dedicated translator, but an LLM may be available. It is second
    // choice on purpose - a translation model is better at this than a chat
    // model - but a faithful English rendering from Mistral is worth far more
    // than an empty column, and the provider is recorded either way so nobody
    // has to guess which produced a given record.
    if (mistral.configured()) {
      const viaLlm = await mistral.translateToEnglish(clean, languageName(from));
      if (viaLlm.ok) {
        return {
          text: viaLlm.text,
          provider: `mistral:${viaLlm.model}`,
          from,
          skipped: false,
          reason: null,
        };
      }
      return {
        text: null,
        provider: 'mistral',
        from,
        skipped: true,
        reason: `llm_${viaLlm.reason}`,
        detail: viaLlm.detail,
      };
    }

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

/*
 * Division names, in the citizen's language.
 *
 * "This looks like a matter for Cyber & Information Security" read out in
 * Punjabi with the division name still in English leaves the single most
 * important word in the sentence untranslated - the one the citizen has to
 * agree with. 
 *
 * All fifteen names for a language are fetched in ONE request the first time
 * that language is needed, then cached for the life of the process. Fifteen
 * short strings per language, once, is nothing; a call per turn would be
 * absurd. Lookup stays synchronous so the interview's prompt builder does not
 * have to become async, and an unwarmed cache simply yields English.
 */
const divisionNameCache = new Map(); // langCode -> { divisionId: name }
const warming = new Map();           // langCode -> in-flight promise

export function divisionNameIn(divisionId, langCode, fallback) {
  if (!langCode || langCode === 'en') return fallback;
  return divisionNameCache.get(langCode)?.[divisionId] || fallback;
}

export async function warmDivisionNames(langCode, divisions) {
  if (!langCode || langCode === 'en') return;
  if (divisionNameCache.has(langCode)) return;
  if (!configured()) return;
  if (warming.has(langCode)) return warming.get(langCode);

  const task = (async () => {
    const url = new URL('/translate', env.azureTranslator.endpoint);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('from', 'en');
    url.searchParams.set('to', langCode);

    const headers = {
      'Ocp-Apim-Subscription-Key': env.azureTranslator.key,
      'Content-Type': 'application/json',
    };
    if (env.azureTranslator.region) headers['Ocp-Apim-Subscription-Region'] = env.azureTranslator.region;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(divisions.map((d) => ({ Text: d.name }))),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return;
      const data = await res.json();
      const map = {};
      divisions.forEach((d, i) => {
        const t = data?.[i]?.translations?.[0]?.text;
        if (t) map[d.id] = t;
      });
      if (Object.keys(map).length > 0) divisionNameCache.set(langCode, map);
    } catch {
      // English remains perfectly usable.
    } finally {
      warming.delete(langCode);
    }
  })();

  warming.set(langCode, task);
  return task;
}

/** Live check for /api/health. */
export async function probe() {
  if (!configured() && !mistral.configured()) return { ok: false, reason: 'not_configured' };
  const r = await toEnglish('मेरे पैसे चोरी हो गए', { from: 'hi' });
  return r.text
    ? { ok: true, provider: r.provider }
    : { ok: false, reason: r.reason, detail: r.detail, provider: r.provider };
}
