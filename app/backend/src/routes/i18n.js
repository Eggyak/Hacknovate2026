/**
 * Interface translation.
 *
 * The portal's own text - labels, buttons, headings, help - translated into
 * whichever of the 14 languages the citizen picked in the masthead.
 *
 * This is a batching cache in front of Azure Translator, and the cache is the
 * whole point. The interface is a closed set of a few hundred strings: the
 * first citizen to choose Odia pays for the translation, everyone after them
 * is served from memory. Without it the portal would re-translate the word
 * "Dashboard" on every navigation, which is both slow and a waste of a quota
 * that exists to translate grievances.
 *
 * Deliberately NOT the same path as grievance translation. A complaint is a
 * legal record and its translation is stored with it; this is chrome, cached
 * in memory, and if it fails the citizen sees English - which is a degraded
 * interface, not a damaged record.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../lib/env.js';
import { byCode } from '../data/languages.js';

export const i18nRouter = Router();

/**
 * Cache key is `lang|source`. Capped so a hostile caller cannot grow it
 * without bound; eviction is oldest-first, which suits a UI vocabulary that
 * is stable in practice.
 */
const cache = new Map();
const CACHE_MAX = 20_000;

function cacheGet(lang, text) {
  return cache.get(`${lang}|${text}`);
}

function cacheSet(lang, text, value) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(`${lang}|${text}`, value);
}

/** Azure accepts 100 items or 50k characters per request; stay well inside. */
function chunk(items, maxItems = 90, maxChars = 40_000) {
  const out = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    if (current.length >= maxItems || chars + item.length > maxChars) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function translateBatch(texts, to) {
  const url = new URL('/translate', env.azureTranslator.endpoint);
  url.searchParams.set('api-version', '3.0');
  url.searchParams.set('from', 'en');
  url.searchParams.set('to', to);
  // The interface contains markup-free strings, but a label may legitimately
  // contain an ampersand or a quote; textType=plain is correct for those.
  url.searchParams.set('textType', 'plain');

  const headers = {
    'Ocp-Apim-Subscription-Key': env.azureTranslator.key,
    'Content-Type': 'application/json',
  };
  if (env.azureTranslator.region) headers['Ocp-Apim-Subscription-Region'] = env.azureTranslator.region;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(texts.map((t) => ({ Text: t }))),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`Translator returned ${res.status}. ${body.slice(0, 160)}`), {
      status: res.status === 429 ? 429 : 502,
      code: res.status === 429 ? 'translator_rate_limited' : 'translator_failed',
    });
  }

  const data = await res.json();
  return texts.map((_, i) => data?.[i]?.translations?.[0]?.text || null);
}

const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

/**
 * POST { to, texts: [...] } -> { translations: { source: translated } }
 *
 * Only strings not already cached reach Azure. Untranslatable entries come
 * back absent rather than echoed, so the client can leave the English in
 * place and the difference stays visible.
 */
i18nRouter.post('/', limiter, async (req, res, next) => {
  try {
    const to = String(req.body?.to || '').trim();
    const lang = byCode(to);

    if (!lang) {
      return res.status(400).json({ error: 'unsupported_language', message: 'Not a portal language.' });
    }
    if (lang.code === 'en') {
      return res.json({ translations: {}, language: 'en', note: 'source language' });
    }
    if (!env.azureTranslator.key) {
      return res.status(503).json({
        error: 'translator_not_configured',
        message: 'Interface translation is unavailable on this server.',
      });
    }

    const texts = Array.isArray(req.body?.texts) ? req.body.texts : [];
    const wanted = [...new Set(
      texts
        .map((t) => String(t == null ? '' : t).trim())
        .filter((t) => t.length > 0 && t.length <= 400),
    )].slice(0, 600);

    const translations = {};
    const missing = [];

    for (const text of wanted) {
      const hit = cacheGet(lang.code, text);
      if (hit !== undefined) {
        if (hit !== null) translations[text] = hit;
      } else {
        missing.push(text);
      }
    }

    let fetched = 0;
    for (const group of chunk(missing)) {
      const results = await translateBatch(group, lang.code);
      group.forEach((text, i) => {
        const value = results[i];
        cacheSet(lang.code, text, value);
        if (value) translations[text] = value;
      });
      fetched += group.length;
    }

    return res.json({
      language: lang.code,
      translations,
      cached: wanted.length - fetched,
      fetched,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    return next(err);
  }
});

/** Cache state, for /api/health and for knowing whether a demo will be instant. */
export function i18nStats() {
  const byLang = {};
  for (const key of cache.keys()) {
    const lang = key.slice(0, key.indexOf('|'));
    byLang[lang] = (byLang[lang] || 0) + 1;
  }
  return { entries: cache.size, byLanguage: byLang };
}
