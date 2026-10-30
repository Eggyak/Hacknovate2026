/**
 * Routes a complaint to the MHA division that owns it.
 *
 * This is a weighted multilingual lexicon classifier, and it is deliberately
 * not a neural model. Three reasons, all of which matter more than accuracy on
 * a benchmark nobody will run:
 *
 *   - It works in the citizen's own script with no translation step, so a
 *     Malayalam complaint routes correctly even when no translation key is
 *     configured. Routing must never depend on an optional service.
 *   - It is deterministic and auditable. Every routing decision carries the
 *     exact terms that produced it, which is the difference between an
 *     administrative decision a citizen can appeal and an oracle.
 *   - It fails loudly. When nothing matches it says so and the bot asks,
 *     rather than quietly dropping the complaint into whichever division
 *     happened to score 0.1 highest.
 *
 * Scoring: each lexicon term carries weight 3 (near-decisive), 2 (strong) or
 * 1 (supporting). A division's raw score is the sum of the weights of its
 * distinct matched terms. Confidence is derived from the winner's score AND
 * its margin over the runner-up, so "matched a lot but so did someone else"
 * reports as uncertain.
 */

import { DIVISIONS, divisionById } from '../data/divisions.js';

/**
 * Terms that mean a complaint cannot wait for the ordinary queue. Kept
 * separate from routing: urgency changes priority and alerting, never which
 * division owns the file.
 */
const URGENT_TERMS = [
  'suicide', 'kill', 'murder', 'death threat', 'bomb', 'kidnap', 'abduct', 'rape', 'trafficking', 'hostage',
  'आत्महत्या', 'जान से मारने', 'हत्या', 'बम', 'अपहरण', 'धमकी', 'बलात्कार',
  'আত্মহত্যা', 'খুন', 'বোমা', 'অপহরণ', 'হুমকি',
  'தற்கொலை', 'கொலை', 'குண்டு', 'கடத்தல்', 'மிரட்டல்',
  'ఆత్మహత్య', 'హత్య', 'బాంబు', 'కిడ్నాప్', 'బెదిరింపు',
  'ಆತ್ಮಹತ್ಯೆ', 'ಕೊಲೆ', 'ಬಾಂಬ್', 'ಬೆದರಿಕೆ',
  'ആത്മഹത്യ', 'കൊലപാതകം', 'ബോംബ്', 'ഭീഷണി',
  'આત્મહત્યા', 'હત્યા', 'બોમ્બ', 'ધમકી',
  'ਖੁਦਕੁਸ਼ੀ', 'ਕਤਲ', 'ਬੰਬ', 'ਧਮਕੀ',
  'ଆତ୍ମହତ୍ୟା', 'ହତ୍ୟା', 'ବୋମା', 'ଧମକ',
  'خودکشی', 'قتل', 'بم', 'دھمکی',
];

const LATIN = /^[\x20-\x7E]+$/;

/**
 * Indic scripts inflect heavily and compound freely, so a substring match is
 * the right test there. Latin needs a word boundary or "otp" fires inside
 * "adopted".
 */
function occurrences(haystackLower, haystackRaw, term) {
  if (LATIN.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'g');
    return (haystackLower.match(re) || []).length;
  }
  let count = 0;
  let idx = haystackRaw.indexOf(term);
  while (idx !== -1) {
    count += 1;
    idx = haystackRaw.indexOf(term, idx + term.length);
  }
  return count;
}

/**
 * Classify a complaint.
 *
 * `texts` may hold several renderings of the same complaint - the original
 * regional text and an English translation, say. All are searched, because the
 * English lexicon fires on the translation while the native lexicon fires on
 * the original, and both are evidence.
 *
 * Returns:
 *   { divisionId, division, confidence, needsConfirmation, matched,
 *     alternatives, urgent, urgentTerms, method }
 *
 * `divisionId` is null when nothing matched. That is a legitimate outcome and
 * the caller must ask the citizen rather than inventing a route.
 */
export function classify(texts, { preferDivision = null } = {}) {
  const parts = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).map(String);
  const raw = parts.join('\n');
  const lower = raw.toLowerCase();

  if (!raw.trim()) {
    return empty('no-text');
  }

  const scored = DIVISIONS.map((division) => {
    const matched = [];
    let score = 0;

    for (const [weightKey, terms] of Object.entries(division.lexicon)) {
      const weight = Number(weightKey);
      for (const term of terms) {
        const hits = occurrences(lower, raw, LATIN.test(term) ? term.toLowerCase() : term);
        if (hits > 0) {
          // Repeated terms add a little, but one word said five times must not
          // outweigh five different signals.
          const contribution = weight * (1 + Math.min(hits - 1, 2) * 0.25);
          score += contribution;
          matched.push({ term, weight, hits });
        }
      }
    }

    return { divisionId: division.id, score, matched };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.matched.length - a.matched.length);

  const urgentTerms = URGENT_TERMS.filter((t) => occurrences(lower, raw, LATIN.test(t) ? t.toLowerCase() : t) > 0);

  if (scored.length === 0) {
    return { ...empty('no-lexicon-match'), urgent: urgentTerms.length > 0, urgentTerms };
  }

  const best = scored[0];
  const runnerUp = scored[1] || { score: 0 };
  const margin = best.score - runnerUp.score;

  // Confidence rises with absolute evidence and with the gap to second place.
  // A score of 3 with nothing behind it is a confident single decisive term;
  // a score of 6 that is tied is not confident at all.
  const evidenceComponent = Math.min(best.score / 9, 1) * 0.55;
  const marginComponent = Math.min(margin / 5, 1) * 0.4;
  let confidence = round(Math.min(0.97, 0.05 + evidenceComponent + marginComponent));

  // An explicit choice by the citizen outranks anything the lexicon thinks.
  if (preferDivision && divisionById(preferDivision)) {
    return {
      divisionId: preferDivision,
      division: divisionById(preferDivision),
      confidence: 1,
      needsConfirmation: false,
      matched: [],
      alternatives: scored.slice(0, 3).map(toAlternative),
      urgent: urgentTerms.length > 0,
      urgentTerms,
      method: 'citizen-selected',
    };
  }

  return {
    divisionId: best.divisionId,
    division: divisionById(best.divisionId),
    confidence,
    // Below this the bot shows the top choices and asks instead of assuming.
    needsConfirmation: confidence < 0.55,
    matched: best.matched.sort((a, b) => b.weight - a.weight).slice(0, 8),
    alternatives: scored.slice(1, 4).map(toAlternative),
    urgent: urgentTerms.length > 0,
    urgentTerms,
    method: 'weighted-multilingual-lexicon',
  };
}

function toAlternative(s) {
  const d = divisionById(s.divisionId);
  return {
    divisionId: s.divisionId,
    name: d ? d.name : s.divisionId,
    score: round(s.score),
    matched: s.matched.slice(0, 3).map((m) => m.term),
  };
}

function empty(method) {
  return {
    divisionId: null,
    division: null,
    confidence: 0,
    needsConfirmation: true,
    matched: [],
    alternatives: [],
    urgent: false,
    urgentTerms: [],
    method,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
