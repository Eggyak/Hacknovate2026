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
import { toEnglish } from './translate.js';
import { divisionById, fieldsFor } from '../data/divisions.js';
import { byCode, buildLidCandidates } from '../data/languages.js';
import { languagesForPincode, stateForPincode, isValidPincode } from '../data/states.js';
import { t } from '../data/phrases.js';

export const STEPS = [
  'narrative',
  'confirm_division',
  'details',
  'pincode',
  'address',
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
    pincode: null,
    state: null,
    district: null,
    address: null,
    latitude: null,
    longitude: null,
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
  if (!draft.address) return 'address';
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
        text: t('routed_to', language, { division: d.name }),
        input: { kind: 'confirm_division', divisionId: d.id },
      };
    }

    case 'details': {
      const field = pendingField(draft);
      return {
        step,
        text: t('ask_field', language, { label: field.label }),
        input: { kind: 'field', field },
      };
    }

    case 'pincode':
      return { step, text: t('ask_location', language), input: { kind: 'pincode' } };

    case 'address':
      return {
        step,
        text: t('ask_field', language, { label: 'Complete address' }),
        input: { kind: 'address' },
      };

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

  // ---- Language identification -------------------------------------------
  let language = conversation.language;

  if (step === 'narrative') {
    if (spoken?.locale) {
      const lang = byCode(String(spoken.locale).split('-')[0]);
      language = lang ? lang.code : language;
      draft.language = {
        code: language,
        locale: spoken.locale,
        confidence: Number(spoken.confidence || 0),
        method: 'azure-speech-continuous-lid',
        evidence: [`Azure identified ${spoken.locale} from the audio`],
        candidatesEvaluated: spoken.candidates || [],
      };
      pipeline.steps.push({
        stage: 'language-identification',
        provider: 'azure-speech',
        detail: draft.language,
      });
    } else {
      const detected = detectLanguage(value, { hint: conversation.language });
      language = detected.code;
      draft.language = detected;
      pipeline.steps.push({ stage: 'language-identification', provider: 'local-script-analysis', detail: detected });
    }
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
      draft.classification = classification;
      draft.divisionId = classification.divisionId;
      draft.confirmedDivision = false;
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
  }

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
