/**
 * The grievance interview, as a state machine over a stored draft.
 *
 * The bot asks for exactly what the data schema requires and nothing else:
 * the base fields every complaint carries, then the dynamic details the chosen
 * division needs. Because state lives in the `conversations` row rather than
 * in memory, a citizen can lose signal mid-complaint, come back, and continue.
 *
 * There is no generative model in this loop and that is deliberate. Every
 * question is a known question from divisions.js, every reply is a reviewed
 * translation from phrases.js, and the only inference is language detection
 * and division routing - both of which hand back their evidence. A grievance
 * is a legal record; the machine that fills it should be inspectable.
 */

import { query } from '../lib/db.js';
import { detectLanguage } from './languageDetect.js';
import { classify } from './classifier.js';
import { toEnglish, warmDivisionNames, divisionNameIn } from './translate.js';
import * as mistral from './mistral.js';
import { env } from '../lib/env.js';
import { DIVISIONS, divisionById, fieldsFor } from '../data/divisions.js';
import { byCode, buildLidCandidates } from '../data/languages.js';
import { languagesForPincode, stateForPincode, isValidPincode } from '../data/states.js';
import { t } from '../data/phrases.js';

/**
 * What it takes to move a conversation into a different language.
 *
 * Confidence alone is not enough, and the case that proves it is a form
 * answer: "UTR123456789012" is 100% Latin by character share, so a
 * share-based score calls it English and the bot abandons the Punjabi the
 * citizen was speaking - mid-complaint, over a reference number they were
 * asked to type. Three letters is not a language sample.
 *
 * So a switch needs BOTH a confident reading and enough letters to have read.
 * Labelling a message is a weaker claim than redirecting a conversation, and
 * only the latter is gated this hard.
 */
const LANGUAGE_SWITCH_CONFIDENCE = 0.5;
const LANGUAGE_SWITCH_MIN_LETTERS = 8;

export const STEPS = [
  'narrative',
  'confirm_division',
  'details',
  'pincode',
  'district',
  'address',
  'location_pin',
  'name',
  'gender',
  'evidence',
  'declaration',
  'done',
];

function emptyDraft() {
  return {
    divisionId: null,
    originalText: '',
    translatedText: null,
    translationProvider: null,
    language: null,
    classification: null,
    details: {},
    suggestions: {},
    pincode: null,
    state: null,
    district: null,
    address: null,
    latitude: null,
    longitude: null,
    locationPinAnswered: false,
    fullName: null,
    gender: null,
    attachments: [],
    audioPath: null,
    declarationTruth: false,
    confirmedDivision: false,
  };
}

export async function startConversation(citizenId, language = 'en') {
  const r = await query(
    `INSERT INTO conversations (citizen_id, step, language, draft, transcript)
     VALUES ($1, 'narrative', $2, $3, '[]'::jsonb)
     RETURNING *`,
    [citizenId, language, JSON.stringify(emptyDraft())],
  );
  return r.rows[0];
}

export async function getConversation(citizenId, id) {
  const r = await query('SELECT * FROM conversations WHERE id = $1 AND citizen_id = $2', [id, citizenId]);
  return r.rows[0] || null;
}

async function save(conversation) {
  await query(
    `UPDATE conversations
        SET step = $2, language = $3, draft = $4, transcript = $5, updated_at = NOW()
      WHERE id = $1`,
    [
      conversation.id,
      conversation.step,
      conversation.language,
      JSON.stringify(conversation.draft),
      JSON.stringify(conversation.transcript),
    ],
  );
}

/** The first unfinished step, given what the draft already holds. */
export function nextStep(draft, citizen) {
  if (!draft.originalText) return 'narrative';
  if (!draft.divisionId || !draft.confirmedDivision) return 'confirm_division';

  const missing = fieldsFor(draft.divisionId).filter(
    (f) => f.required && !String(draft.details?.[f.key] ?? '').trim(),
  );
  if (missing.length > 0) return 'details';

  if (!draft.pincode) return 'pincode';
  if (!draft.district) return 'district';
  if (!draft.address) return 'address';
  // Offered once. A citizen who declines, or whose browser refuses, is not
  // asked again - a GPS fix must never be the thing that blocks a complaint.
  if (!draft.locationPinAnswered) return 'location_pin';
  if (!draft.fullName && !citizen?.full_name) return 'name';
  if (!draft.gender && !citizen?.gender) return 'gender';
  if (!draft.declarationTruth) return 'declaration';
  return 'done';
}

/** The next required field for the current division, or null. */
export function pendingField(draft) {
  if (!draft.divisionId) return null;
  return (
    fieldsFor(draft.divisionId).find(
      (f) => f.required && !String(draft.details?.[f.key] ?? '').trim(),
    ) || null
  );
}

/**
 * Compose what the bot says next, in the citizen's language, plus whatever
 * structured affordance the UI should render alongside it (a field, a list of
 * divisions to pick from, a yes/no).
 */
export function prompt(conversation, citizen) {
  const { draft, language } = conversation;
  const step = nextStep(draft, citizen);

  switch (step) {
    case 'narrative':
      return { step, text: t('greeting', language), input: { kind: 'narrative' } };

    case 'confirm_division': {
      const c = draft.classification;
      if (!c?.divisionId || c.needsConfirmation) {
        return {
          step,
          text: t('not_understood', language),
          input: {
            kind: 'choose_division',
            // Suggest the near misses first when there were any, else the
            // full list. Never pre-select.
            suggestions: (c?.alternatives || []).map((a) => a.divisionId).filter(Boolean),
          },
        };
      }
      const d = divisionById(c.divisionId);
      return {
        step,
        text: t('routed_to', language, { division: divisionNameIn(d.id, language, d.name) }),
        input: { kind: 'confirm_division', divisionId: d.id },
      };
    }

    case 'details': {
      const field = pendingField(draft);
      const suggestion = draft.suggestions?.[field.key] || null;
      return {
        step,
        text: t('ask_field', language, { label: field.label }),
        input: {
          kind: 'field',
          field,
          // Drawn from the citizen's own words. The UI must show it as
          // something to check, not as an answer already given.
          suggestion,
          suggestionSource: suggestion ? 'extracted-from-your-complaint' : null,
        },
      };
    }

    case 'pincode':
      return { step, text: t('ask_location', language), input: { kind: 'pincode' } };

    case 'district':
      return { step, text: t('ask_district', language), input: { kind: 'district' } };

    case 'address':
      return {
        step,
        text: t('ask_field', language, { label: 'Complete address' }),
        input: { kind: 'address' },
      };

    case 'location_pin':
      return { step, text: t('ask_location_pin', language), input: { kind: 'location_pin' } };

    case 'name':
      return { step, text: t('ask_field', language, { label: 'Your full name' }), input: { kind: 'name' } };

    case 'gender':
      return {
        step,
        text: t('ask_field', language, { label: 'Gender' }),
        input: { kind: 'gender', options: ['Male', 'Female', 'Other', 'Prefer not to say'] },
      };

    case 'declaration':
      return { step, text: t('ask_declaration', language), input: { kind: 'declaration' } };

    default:
      return { step: 'done', text: '', input: { kind: 'done' } };
  }
}

/**
 * Feed one citizen utterance into the interview.
 *
 * `spoken` carries what the browser's recogniser reported when the input came
 * from the microphone: Azure has already identified the language of the audio,
 * and that beats re-deriving it from the transcript, so we take it when it is
 * offered and fall back to local detection for typed text.
 */
export async function handleMessage(conversation, citizen, { text, inputMode = 'text', spoken = null }) {
  const value = String(text || '').trim();
  const draft = { ...conversation.draft };
  const pipeline = { steps: [] };

  if (!value) {
    return { conversation, reply: prompt(conversation, citizen), pipeline };
  }

  const step = nextStep(draft, citizen);

  // ---- Language identification, on every turn ----------------------------
  //
  // Not just the opening narrative. A citizen may describe the incident in
  // Punjabi and then answer a follow-up in English, or switch mid-interview
  // because a word comes more easily in another language, and the bot should
  // follow them rather than hold them to whatever they opened with.
  //
  // Two sources, in order of authority:
  //   spoken.locale  Azure's own identification of the AUDIO. It heard the
  //                  speech; we only ever see a transcript. It wins.
  //   local detector Unicode script plus marker lexicons, for typed text.
  //
  // Short answers are the trap. "50000", "Male" and "110001" carry no
  // language signal at all, and switching the conversation on the strength of
  // them would throw a citizen into a language they never chose. The local
  // detector reports confidence 0 for those, and the threshold below means
  // they are ignored.
  const previousLanguage = conversation.language;
  let language = previousLanguage;
  let identification = null;

  if (spoken?.locale) {
    const lang = byCode(String(spoken.locale).split('-')[0]);
    if (lang) {
      language = lang.code;
      identification = {
        code: lang.code,
        locale: spoken.locale,
        confidence: Number(spoken.confidence || 0),
        method: 'azure-speech-continuous-lid',
        evidence: [`Azure identified ${spoken.locale} from the audio itself`],
        candidatesEvaluated: spoken.candidates || [],
      };
    }
  } else {
    const detected = detectLanguage(value, { hint: previousLanguage });
    identification = detected;
    const sureEnough = detected.confidence >= LANGUAGE_SWITCH_CONFIDENCE;
    const enoughToRead = (detected.letters || 0) >= LANGUAGE_SWITCH_MIN_LETTERS;
    if (sureEnough && enoughToRead) {
      language = detected.code;
    } else if (detected.code !== previousLanguage) {
      // Say why it was ignored, so a reviewer is not left wondering whether
      // detection simply failed.
      identification = {
        ...detected,
        heldBack: enoughToRead ? 'confidence below threshold' : `only ${detected.letters || 0} letters`,
      };
    }
  }

  /*
   * Fetch this language's division names.
   *
   * On the turn where the language CHANGES this is awaited, because that is
   * precisely the reply that names a division - "this looks like a matter
   * for..." - and it is the citizen's first sight of the bot in their own
   * language. One request, once per language per process, is worth paying
   * for at that moment. Otherwise it runs in the background and the cache is
   * already warm by the next turn.
   */
  if (language && language !== 'en') {
    const warm = warmDivisionNames(language, DIVISIONS).catch(() => {});
    if (language !== previousLanguage) await warm;
  }

  if (identification) {
    const switched = language !== previousLanguage;
    pipeline.steps.push({
      stage: 'language-identification',
      provider: spoken?.locale ? 'azure-speech' : 'local-script-analysis',
      detail: { ...identification, switched, previous: switched ? previousLanguage : null },
    });
    // The narrative's language is the one recorded on the grievance; later
    // turns may differ without rewriting what the complaint was filed in.
    if (step === 'narrative' || !draft.language) draft.language = identification;
    // The most recent reading, kept so a resumed conversation can still show
    // what language it is currently being held in.
    draft.lastLanguage = { ...identification, switched, previous: switched ? previousLanguage : null };
  }

  // ---- Apply the utterance to the current step ----------------------------
  switch (step) {
    case 'narrative': {
      draft.originalText = value;

      const translation = await toEnglish(value, { from: language });
      draft.translatedText = translation.text;
      draft.translationProvider = translation.provider;
      pipeline.steps.push({
        stage: 'translation',
        provider: translation.provider || 'none',
        detail: {
          produced: Boolean(translation.text),
          reason: translation.reason || null,
        },
      });

      // Classify on the original AND any translation: the native lexicon fires
      // on one, the English lexicon on the other, and both count as evidence.
      const classification = classify([value, translation.text]);
      pipeline.steps.push({
        stage: 'classification',
        provider: classification.method,
        detail: {
          divisionId: classification.divisionId,
          confidence: classification.confidence,
          matched: classification.matched,
          alternatives: classification.alternatives,
          urgent: classification.urgent,
        },
      });

      // The lexicon is fast, free and explains itself, so it is always asked
      // first and its confident answers stand. Only where it is genuinely
      // undecided is the model consulted - which is also what keeps us inside
      // a free account's request budget, since most complaints never reach it.
      const resolved = await adjudicate(classification, {
        original: value,
        translated: translation.text,
        pipeline,
      });

      draft.classification = resolved;
      draft.divisionId = resolved.divisionId;
      draft.confirmedDivision = false;
      break;
    }

    case 'details': {
      const field = pendingField(draft);
      if (field) draft.details = { ...draft.details, [field.key]: value };
      break;
    }

    case 'pincode': {
      const pin = value.replace(/\D/g, '');
      if (isValidPincode(pin)) {
        draft.pincode = pin;
        const st = stateForPincode(pin);
        draft.state = st ? st.name : null;
        pipeline.steps.push({
          stage: 'location-resolution',
          provider: 'pincode-prefix-table',
          detail: { pincode: pin, state: draft.state, languages: languagesForPincode(pin) },
        });
      }
      break;
    }

    case 'district':
      draft.district = value;
      break;

    case 'address':
      draft.address = value;
      break;

    case 'name':
      draft.fullName = value;
      break;

    case 'gender':
      draft.gender = value;
      break;

    default:
      break;
  }

  const transcript = [
    ...(conversation.transcript || []),
    { role: 'citizen', text: value, inputMode, language, at: new Date().toISOString() },
  ];

  const updated = { ...conversation, draft, language, transcript, step: nextStep(draft, citizen) };
  const reply = prompt(updated, citizen);

  updated.transcript = [
    ...transcript,
    { role: 'bot', text: reply.text, language, at: new Date().toISOString() },
  ];

  await save(updated);
  return { conversation: updated, reply, pipeline };
}

/**
 * Settle a routing decision the lexicon could not.
 *
 * Called only when the keyword pass is undecided. The model is asked to pick
 * from the fixed list, and its answer is folded in rather than swallowing the
 * lexicon's:
 *
 *   - they agree      confidence rises and the bot stops asking
 *   - they disagree   the model's answer is used, because the lexicon already
 *                     said it was unsure, but the citizen is still asked to
 *                     confirm it
 *   - model fails     the lexicon's answer stands, unchanged
 *
 * `method` always records who actually decided. A grievance routed by a model
 * must not claim to have been routed by keywords, and vice versa.
 */
async function adjudicate(classification, { original, translated, pipeline }) {
  if (!classification.needsConfirmation) return classification;
  if (!mistral.configured()) return classification;

  const verdict = await mistral.adjudicateDivision({
    original,
    translated,
    lexicon: classification,
  });

  if (!verdict.ok) {
    pipeline.steps.push({
      stage: 'llm-adjudication',
      provider: `mistral:${env.mistral.model}`,
      detail: { ran: false, reason: verdict.reason, detail: verdict.detail },
    });
    return classification;
  }

  const agrees = verdict.divisionId && verdict.divisionId === classification.divisionId;
  const divisionId = verdict.divisionId || classification.divisionId;

  // Agreement between two independent methods is worth more than either
  // alone; a lone model answer is not, so it still goes to the citizen.
  const confidence = agrees
    ? Math.min(0.95, Math.max(classification.confidence, verdict.confidence) + 0.2)
    : Math.min(0.9, verdict.confidence);

  pipeline.steps.push({
    stage: 'llm-adjudication',
    provider: `mistral:${verdict.model}`,
    detail: {
      ran: true,
      divisionId: verdict.divisionId,
      confidence: verdict.confidence,
      reason: verdict.reason,
      agreedWithLexicon: Boolean(agrees),
      lexiconSaid: classification.divisionId,
    },
  });

  return {
    ...classification,
    divisionId,
    confidence: Math.round(confidence * 100) / 100,
    needsConfirmation: !agrees || confidence < 0.7,
    method: agrees
      ? 'lexicon-and-llm-agreed'
      : (classification.divisionId ? 'llm-overrode-uncertain-lexicon' : 'llm-resolved-no-lexicon-match'),
    llm: {
      model: verdict.model,
      divisionId: verdict.divisionId,
      confidence: verdict.confidence,
      reason: verdict.reason,
    },
  };
}

/** The citizen accepted, corrected or chose the division. */
export async function setDivision(conversation, citizen, divisionId) {
  const division = divisionById(divisionId);
  if (!division) throw Object.assign(new Error('Unknown division.'), { status: 400, code: 'unknown_division' });

  const draft = { ...conversation.draft, divisionId, confirmedDivision: true };

  // Record that the human, not the classifier, settled this - the stored
  // record must not claim the lexicon chose a division the citizen picked.
  if (conversation.draft.classification?.divisionId !== divisionId) {
    draft.classification = {
      ...(conversation.draft.classification || {}),
      divisionId,
      confidence: 1,
      method: 'citizen-selected',
      matched: [],
    };
  }

  // With the division known, re-read the narrative for answers the citizen has
  // already given. These are suggestions the citizen sees and accepts in the
  // field - never values written straight into the record.
  if (mistral.configured() && draft.originalText) {
    const extracted = await mistral.extractFields(division, {
      original: draft.originalText,
      translated: draft.translatedText,
    });
    if (extracted.ok) {
      draft.suggestions = extracted.suggestions;
      draft.extraction = {
        model: extracted.model,
        suggested: Object.keys(extracted.suggestions),
        rejected: extracted.rejected,
      };
    } else {
      draft.extraction = { ran: false, reason: extracted.reason };
    }
  }

  const updated = { ...conversation, draft, step: nextStep(draft, citizen) };
  await save(updated);
  return { conversation: updated, reply: prompt(updated, citizen) };
}

/** Attach uploaded evidence to the draft. */
export async function attachEvidence(conversation, citizen, files) {
  const draft = {
    ...conversation.draft,
    attachments: [...(conversation.draft.attachments || []), ...files],
  };
  const updated = { ...conversation, draft, step: nextStep(draft, citizen) };
  await save(updated);
  return { conversation: updated, reply: prompt(updated, citizen) };
}

/**
 * Keep the recording the citizen's narrative came from.
 *
 * The data schema requires a raw audio file path on every complaint, and the
 * reason is sound: the transcript is a machine's reading of what someone said,
 * and when a complaint turns on exactly what was said, the recording is the
 * evidence and the transcript is only a convenience. Recognition streams
 * straight from the browser to Azure, so the audio would otherwise never
 * reach us - the client captures it in parallel and posts it here.
 */
export async function attachAudio(conversation, citizen, storedName) {
  const draft = { ...conversation.draft, audioPath: storedName };
  const updated = { ...conversation, draft, step: nextStep(draft, citizen) };
  await save(updated);
  return { conversation: updated };
}

/** Record the declaration of truth. Only `true` counts. */
export async function setDeclaration(conversation, citizen, accepted) {
  const draft = { ...conversation.draft, declarationTruth: accepted === true };
  const updated = { ...conversation, draft, step: nextStep(draft, citizen) };
  await save(updated);
  return { conversation: updated, reply: prompt(updated, citizen) };
}

/** Patch any part of the draft the citizen edits directly in the review panel. */
export async function patchDraft(conversation, citizen, patch = {}) {
  const draft = { ...conversation.draft };

  if (patch.details && typeof patch.details === 'object') {
    draft.details = { ...draft.details, ...patch.details };
  }
  for (const key of ['address', 'district', 'fullName', 'gender', 'originalText']) {
    if (typeof patch[key] === 'string' && patch[key].trim()) draft[key] = patch[key].trim();
  }
  if (patch.pincode && isValidPincode(String(patch.pincode))) {
    draft.pincode = String(patch.pincode);
    const st = stateForPincode(draft.pincode);
    draft.state = st ? st.name : null;
  }
  if (Number.isFinite(Number(patch.latitude)) && Number.isFinite(Number(patch.longitude))) {
    draft.latitude = Number(patch.latitude);
    draft.longitude = Number(patch.longitude);
    draft.locationPinAnswered = true;
  }
  if (patch.skipLocationPin === true) draft.locationPinAnswered = true;

  const updated = { ...conversation, draft, step: nextStep(draft, citizen) };
  await save(updated);
  return { conversation: updated, reply: prompt(updated, citizen) };
}

/**
 * Candidate locales for the browser recogniser.
 *
 * Azure evaluates at most ten at a time; this picks which ten, using the
 * citizen's chosen language and the languages spoken where their PIN code is.
 */
export function lidCandidatesFor(conversation, citizen) {
  const pincode = conversation?.draft?.pincode || null;
  return buildLidCandidates({
    preferred: conversation?.language || citizen?.preferred_language || null,
    stateLanguages: pincode ? languagesForPincode(pincode) : [],
  });
}

export async function linkGrievance(conversationId, grievanceId) {
  await query('UPDATE conversations SET grievance_id = $2, step = $3, updated_at = NOW() WHERE id = $1', [
    conversationId,
    grievanceId,
    'done',
  ]);
}
