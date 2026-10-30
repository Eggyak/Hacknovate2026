/**
 * Mistral: a second opinion, never the only one.
 *
 * Where this sits matters more than what it does. The lexicon classifier in
 * classifier.js is deterministic, free, instant, works offline and hands back
 * the exact terms behind every decision. Replacing it with a model would trade
 * all of that for a rate-limited network call that cannot explain itself - so
 * the model does not replace it. It is consulted only where the lexicon is
 * genuinely unsure, and it is asked to choose from a fixed list rather than to
 * invent anything.
 *
 * Three jobs:
 *   adjudicateDivision  break a tie the lexicon could not
 *   translateToEnglish  the English rendering the schema asks for, when no
 *                       Azure Translator key is configured
 *   summarise           a short English subject line for the docket
 *
 * The hard-won part is the throttling. On a free Mistral account the limit is
 * about one request every six seconds, and exceeding it returns 429s that
 * surface to a citizen as a generic failure. So:
 *
 *   - a local token bucket keeps us under the ceiling by construction, rather
 *     than discovering it from the server's 429s
 *   - a circuit breaker opens after repeated failures and fails fast, so one
 *     bad minute does not become a hundred queued requests
 *   - every entry point returns a skip reason instead of throwing
 *
 * Nothing here is allowed to block a grievance. Every caller already has a
 * working answer before it asks, and keeps that answer if this is unavailable.
 */

import { env } from '../lib/env.js';
import { DIVISIONS, divisionById } from '../data/divisions.js';

const ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';

/** Keep a margin under the published ceiling; bursts are what trigger 429s. */
const MAX_PER_WINDOW = 8;
const WINDOW_MS = 60_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

const recent = [];
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

const stats = { calls: 0, ok: 0, rateLimited: 0, failed: 0, skipped: 0 };

export function configured() {
  return Boolean(env.mistral.apiKey);
}

function breakerOpen() {
  return Date.now() < breakerOpenUntil;
}

function noteFailure(rateLimited) {
  consecutiveFailures += 1;
  if (rateLimited) stats.rateLimited += 1;
  else stats.failed += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.warn(`[mistral] breaker open for ${BREAKER_COOLDOWN_MS / 1000}s after ${consecutiveFailures} failures`);
  }
}

function noteSuccess() {
  consecutiveFailures = 0;
  stats.ok += 1;
}

/** True when a slot is free; records the call when it is. */
function takeSlot() {
  const now = Date.now();
  while (recent.length > 0 && now - recent[0] > WINDOW_MS) recent.shift();
  if (recent.length >= MAX_PER_WINDOW) return false;
  recent.push(now);
  return true;
}

/** Models sometimes wrap JSON in a code fence despite being asked not to. */
function parseJson(text) {
  const cleaned = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: the first balanced-looking object in the reply.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/**
 * One chat completion returning JSON.
 *
 * Never throws. Returns { ok, data, reason } so callers can carry on with
 * whatever they already had.
 */
async function chatJson(messages, { maxTokens = 400, temperature = 0 } = {}) {
  if (!configured()) return { ok: false, reason: 'mistral_not_configured' };
  if (breakerOpen()) {
    stats.skipped += 1;
    return { ok: false, reason: 'circuit_open' };
  }
  if (!takeSlot()) {
    stats.skipped += 1;
    return { ok: false, reason: 'local_rate_limit' };
  }

  stats.calls += 1;
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.mistral.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.mistral.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(env.mistral.timeoutMs),
    });
  } catch (err) {
    noteFailure(false);
    return { ok: false, reason: `network_error: ${err.message}` };
  }

  if (res.status === 429) {
    noteFailure(true);
    return { ok: false, reason: 'rate_limited' };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    noteFailure(false);
    // A model-specific zero quota reads like any other 4xx, so keep the detail.
    return { ok: false, reason: `http_${res.status}`, detail: body.slice(0, 200) };
  }

  const payload = await res.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
  const data = parseJson(content);

  if (!data) {
    noteFailure(false);
    return { ok: false, reason: 'unparseable_response' };
  }

  noteSuccess();
  return { ok: true, data };
}

/**
 * Choose a division when the lexicon could not.
 *
 * The model is given the fixed list and told to answer with an id from it, or
 * with null. Its answer is validated against the real ids before use: a model
 * naming a division that does not exist is discarded, not coerced.
 *
 * `lexicon` is passed in so the model can see what the deterministic pass
 * already found. It is context, not an instruction to agree.
 */
export async function adjudicateDivision({ original, translated, lexicon }) {
  const catalogue = DIVISIONS.map((d) => `- ${d.id}: ${d.name} — ${d.blurb}`).join('\n');

  const shortlist = (lexicon?.alternatives || [])
    .map((a) => `${a.divisionId} (score ${a.score})`)
    .join(', ');

  const messages = [
    {
      role: 'system',
      content:
        'You route citizen grievances to the correct division of the Indian Ministry of Home Affairs. '
        + 'You will be given the complaint in the citizen\'s own language, and sometimes an English '
        + 'rendering. Choose exactly one division id from the list, or null if genuinely none fit.\n\n'
        + `Divisions:\n${catalogue}\n\n`
        + 'Reply with JSON only: {"division_id": string|null, "confidence": number between 0 and 1, '
        + '"reason": short English phrase naming the words that decided it}. '
        + 'Do not invent a division id. Do not explain outside the JSON.',
    },
    {
      role: 'user',
      content:
        `Complaint (original): ${String(original || '').slice(0, 1500)}\n`
        + (translated ? `Complaint (English): ${String(translated).slice(0, 1500)}\n` : '')
        + (shortlist ? `Keyword matching was undecided between: ${shortlist}\n` : 'Keyword matching found nothing.\n'),
    },
  ];

  const r = await chatJson(messages, { maxTokens: 220 });
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };

  const id = r.data.division_id;
  if (id !== null && !divisionById(id)) {
    return { ok: false, reason: 'hallucinated_division', detail: String(id).slice(0, 60) };
  }

  const confidence = Number(r.data.confidence);
  return {
    ok: true,
    divisionId: id || null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    reason: String(r.data.reason || '').slice(0, 200),
    model: env.mistral.model,
  };
}

/**
 * Translate a complaint into English.
 *
 * Used only when no Azure Translator key is configured. The prompt is explicit
 * that this is a legal record: the model must translate, not summarise, and
 * must not soften anything.
 */
export async function translateToEnglish(text, fromLanguageName) {
  const messages = [
    {
      role: 'system',
      content:
        'You translate citizen grievances into English for an official record. '
        + 'Translate faithfully and completely. Do not summarise, soften, editorialise, '
        + 'or add anything that is not in the original. Preserve names, numbers, dates and '
        + 'identifiers exactly as written. '
        + 'Reply with JSON only: {"english": string}.',
    },
    {
      role: 'user',
      content: `Language: ${fromLanguageName || 'unknown'}\n\nText:\n${String(text || '').slice(0, 3000)}`,
    },
  ];

  const r = await chatJson(messages, { maxTokens: 900 });
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };

  const english = String(r.data.english || '').trim();
  if (!english) return { ok: false, reason: 'empty_translation' };
  return { ok: true, text: english, model: env.mistral.model };
}

/** A short English subject line for the docket list. */
export async function summarise(text, translated) {
  const messages = [
    {
      role: 'system',
      content:
        'Write a factual English subject line of at most 12 words for a citizen grievance, '
        + 'as a case file heading. No pleasantries, no opinion, no invented detail. '
        + 'Reply with JSON only: {"subject": string}.',
    },
    { role: 'user', content: String(translated || text || '').slice(0, 1500) },
  ];

  const r = await chatJson(messages, { maxTokens: 80 });
  if (!r.ok) return { ok: false, reason: r.reason };

  const subject = String(r.data.subject || '').trim();
  return subject ? { ok: true, subject: subject.slice(0, 160) } : { ok: false, reason: 'empty_subject' };
}

/** Counters for /api/health, so throttling is visible rather than mysterious. */
export function snapshot() {
  const now = Date.now();
  while (recent.length > 0 && now - recent[0] > WINDOW_MS) recent.shift();
  return {
    configured: configured(),
    model: env.mistral.model,
    inWindow: recent.length,
    windowLimit: MAX_PER_WINDOW,
    breakerOpen: breakerOpen(),
    breakerOpensFor: breakerOpen() ? Math.ceil((breakerOpenUntil - now) / 1000) : 0,
    ...stats,
  };
}

/**
 * Live check. Deliberately cheap, and it reports a model-level quota refusal
 * distinctly - on a free account one model can be capped at zero while another
 * works, and "the key is bad" is the wrong conclusion to draw from that.
 */
export async function probe() {
  if (!configured()) return { ok: false, reason: 'not_configured' };
  const r = await chatJson(
    [{ role: 'user', content: 'Reply with JSON: {"ok": true}' }],
    { maxTokens: 20 },
  );
  if (r.ok) return { ok: true, model: env.mistral.model };
  return {
    ok: false,
    reason: r.reason,
    detail: r.detail,
    model: env.mistral.model,
    hint: /http_(401|403)/.test(r.reason || '')
      ? 'key rejected'
      : /http_4/.test(r.reason || '')
        ? 'this model may have zero quota on this account - try another model'
        : undefined,
  };
}
