/**
 * Language identification for TYPED text, done locally.
 *
 * Azure identifies the language of SPOKEN audio (see azureSpeech.js). Typed
 * text needs its own answer, and buying a second cloud dependency just to tell
 * Tamil from Telugu would be silly: nine of our fourteen languages own a
 * Unicode block outright, so the script alone settles them.
 *
 * That leaves exactly two genuinely ambiguous groups, which marker lexicons
 * resolve:
 *
 *   Devanagari  Hindi / Marathi / Nepali
 *   Bengali     Bengali / Assamese
 *
 * The Bengali case has a decisive shortcut: Assamese writes ra and wa as
 * U+09F0 and U+09F1, which Bengali never uses. One of those characters is
 * worth more than any amount of word evidence.
 *
 * Every result carries the evidence that produced it, because a grievance
 * routed on a guess should be auditable - and because a reviewer asking
 * "how did you know that was Marathi?" deserves a real answer.
 */

import { byCode } from '../data/languages.js';

const BLOCKS = [
  { script: 'Devanagari', re: /[ऀ-ॿ]/g },
  { script: 'Bengali', re: /[ঀ-৿]/g },
  { script: 'Gurmukhi', re: /[਀-੿]/g },
  { script: 'Gujarati', re: /[઀-૿]/g },
  { script: 'Odia', re: /[଀-୿]/g },
  { script: 'Tamil', re: /[஀-௿]/g },
  { script: 'Telugu', re: /[ఀ-౿]/g },
  { script: 'Kannada', re: /[ಀ-೿]/g },
  { script: 'Malayalam', re: /[ഀ-ൿ]/g },
  { script: 'Arabic', re: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g },
  { script: 'Latin', re: /[A-Za-z]/g },
];

/** Scripts owned by exactly one of our languages. */
const UNAMBIGUOUS = {
  Gurmukhi: 'pa',
  Gujarati: 'gu',
  Odia: 'or',
  Tamil: 'ta',
  Telugu: 'te',
  Kannada: 'kn',
  Malayalam: 'ml',
  Arabic: 'ur',
  Latin: 'en',
};

/**
 * Function words and inflections that are common in one language and rare or
 * absent in its script-mates. Chosen to be frequent in ordinary complaint
 * prose, not literary vocabulary.
 */
const MARKERS = {
  hi: ['है', 'हैं', 'नहीं', 'किया', 'मेरा', 'मेरी', 'गया', 'रहा', 'कर', 'लिए', 'हुआ', 'आपका', 'कृपया', 'और', 'का', 'की', 'को', 'से', 'में', 'पर'],
  mr: ['आहे', 'आहेत', 'नाही', 'माझ्या', 'मला', 'त्यांनी', 'झाले', 'केली', 'तुम्ही', 'याची', 'आणि', 'च्या', 'ची', 'वर', 'कृपया', 'सांगा'],
  ne: ['छ', 'छन्', 'हो', 'गरेको', 'भएको', 'तपाईं', 'मैले', 'लाई', 'रहेको', 'गर्न', 'मेरो', 'भयो', 'पनि', 'गर्नु'],
  bn: ['হয়েছে', 'আমার', 'এবং', 'আছে', 'করা', 'হয়', 'না', 'করে', 'থেকে', 'জন্য', 'টাকা', 'দয়া', 'আমি', 'এই'],
  as: ['হৈছে', 'কৰা', 'মোৰ', 'আৰু', 'নাই', 'কৰি', 'হয়', 'মই', 'কৰিব', 'পৰা', 'বাবে', 'এই', 'হোৱা'],
};

/** Assamese-only letters: ra (U+09F0) and wa (U+09F1). */
const ASSAMESE_LETTERS = /[ৰৱ]/;

function scriptProfile(text) {
  const counts = {};
  let total = 0;
  for (const { script, re } of BLOCKS) {
    const n = (text.match(re) || []).length;
    if (n > 0) {
      counts[script] = n;
      total += n;
    }
  }
  return { counts, total };
}

function countMarkers(text, codes) {
  const scores = {};
  for (const code of codes) {
    let hits = 0;
    const matched = [];
    for (const m of MARKERS[code] || []) {
      // Whitespace- or boundary-delimited so "है" does not fire inside "हैदराबाद".
      const re = new RegExp(`(^|[\\s।,.!?;:"'()\\[\\]])${m}($|[\\s।,.!?;:"'()\\[\\]])`, 'gu');
      const n = (text.match(re) || []).length;
      if (n > 0) {
        hits += n;
        matched.push(m);
      }
    }
    scores[code] = { hits, matched };
  }
  return scores;
}

/**
 * Identify the language of a piece of text.
 *
 * Returns { code, locale, confidence, script, method, evidence, alternatives }.
 * `confidence` is 0-1 and deliberately conservative: a one-word message in a
 * shared script will report low confidence rather than pretend.
 */
export function detectLanguage(text, { hint = null } = {}) {
  const raw = String(text || '');
  const trimmed = raw.trim();

  if (!trimmed) {
    return {
      code: hint || 'en',
      locale: (byCode(hint) || byCode('en')).locale,
      confidence: 0,
      script: null,
      method: 'empty-input',
      evidence: [],
      alternatives: [],
    };
  }

  const { counts, total } = scriptProfile(trimmed);

  if (total === 0) {
    // Digits, punctuation or emoji only - nothing to go on.
    return {
      code: hint || 'en',
      locale: (byCode(hint) || byCode('en')).locale,
      confidence: 0,
      script: null,
      method: 'no-letters',
      evidence: [],
      alternatives: [],
    };
  }

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topScript, topCount] = ranked[0];
  const scriptShare = topCount / total;

  // A script that owns itself needs no further argument.
  if (UNAMBIGUOUS[topScript]) {
    const code = UNAMBIGUOUS[topScript];
    const lang = byCode(code);
    return {
      code,
      locale: lang.locale,
      confidence: round(Math.min(0.99, 0.6 + scriptShare * 0.39)),
      script: topScript,
      method: 'script-exclusive',
      evidence: [`${topCount}/${total} characters in ${topScript}`],
      alternatives: ranked.slice(1, 3).map(([s, n]) => ({ script: s, chars: n })),
    };
  }

  if (topScript === 'Bengali') {
    if (ASSAMESE_LETTERS.test(trimmed)) {
      const hits = (trimmed.match(/[ৰৱ]/g) || []).length;
      return {
        code: 'as',
        locale: byCode('as').locale,
        confidence: round(Math.min(0.97, 0.82 + hits * 0.03)),
        script: 'Bengali',
        method: 'assamese-exclusive-letter',
        evidence: [`${hits} occurrence(s) of Assamese-only letters U+09F0/U+09F1`],
        alternatives: [{ code: 'bn', reason: 'same script' }],
      };
    }
    return resolveByMarkers(trimmed, ['bn', 'as'], 'Bengali', scriptShare, hint, 'bn');
  }

  if (topScript === 'Devanagari') {
    return resolveByMarkers(trimmed, ['hi', 'mr', 'ne'], 'Devanagari', scriptShare, hint, 'hi');
  }

  // Should be unreachable, but never guess silently.
  const lang = byCode(hint) || byCode('en');
  return {
    code: lang.code,
    locale: lang.locale,
    confidence: 0.1,
    script: topScript,
    method: 'unrecognised-script',
    evidence: [`dominant script ${topScript} is not mapped`],
    alternatives: [],
  };
}

function resolveByMarkers(text, candidates, script, scriptShare, hint, fallback) {
  const scores = countMarkers(text, candidates);
  const ordered = candidates
    .map((code) => ({ code, ...scores[code] }))
    .sort((a, b) => b.hits - a.hits);

  const best = ordered[0];
  const runnerUp = ordered[1] || { hits: 0 };

  // No marker fired at all: fall back to the citizen's stated language if it
  // is one of the candidates, otherwise the most widely spoken candidate.
  if (best.hits === 0) {
    const code = candidates.includes(hint) ? hint : fallback;
    const lang = byCode(code);
    return {
      code,
      locale: lang.locale,
      confidence: 0.25,
      script,
      method: candidates.includes(hint) ? 'script-plus-stated-language' : 'script-plus-default',
      evidence: [`${script} script, but no distinguishing markers found`],
      alternatives: candidates.filter((c) => c !== code).map((c) => ({ code: c })),
    };
  }

  const margin = best.hits - runnerUp.hits;
  const confidence = round(
    Math.min(0.96, 0.45 + scriptShare * 0.2 + Math.min(margin, 5) * 0.06 + Math.min(best.hits, 6) * 0.02),
  );
  const lang = byCode(best.code);

  return {
    code: best.code,
    locale: lang.locale,
    confidence,
    script,
    method: 'script-plus-markers',
    evidence: [
      `${script} script`,
      `matched ${best.hits} ${lang.name} marker(s): ${best.matched.slice(0, 6).join(', ')}`,
      margin > 0 ? `ahead of next candidate by ${margin}` : 'tied with next candidate',
    ],
    alternatives: ordered.slice(1).map((o) => ({ code: o.code, hits: o.hits })),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
