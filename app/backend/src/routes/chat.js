/**
 * The conversational grievance interview.
 *
 * Every response carries a `pipeline` block describing what actually ran -
 * which component identified the language, whether a translation was produced
 * or skipped and why, which terms drove the routing decision. The UI renders
 * it. That is a deliberate answer to the fair question "is this a real NLP
 * pipeline or a script?": the system shows its working on every turn, and
 * when a stage does not run it says so rather than going quiet.
 */

import { Router } from 'express';
import { requireCitizen } from '../lib/auth.js';
import {
  startConversation,
  listConversations,
  getConversation,
  handleMessage,
  setDivision,
  setDeclaration,
  patchDraft,
  prompt,
  nextStep,
  lidCandidatesFor,
  linkGrievance,
} from '../services/conversation.js';
import { createGrievance, ValidationError, slaFor } from '../services/grievances.js';
import { DIVISIONS, divisionById } from '../data/divisions.js';
import { warmDivisionNames } from '../services/translate.js';
import { t } from '../data/phrases.js';
import { query } from '../lib/db.js';
import * as mistral from '../services/mistral.js';
import { forwardGrievance } from '../services/govtIntake.js';

export const chatRouter = Router();

chatRouter.use(requireCitizen);

function view(conversation, citizen, reply, pipeline) {
  return {
    conversationId: conversation.id,
    step: reply.step,
    language: conversation.language,
    bot: { text: reply.text, input: reply.input },
    draft: conversation.draft,
    division: conversation.draft.divisionId ? divisionById(conversation.draft.divisionId) : null,
    lidCandidates: lidCandidatesFor(conversation, citizen),
    // What language the bot is currently speaking, and how it knows. The
    // portal's own UI language is deliberately NOT this: a citizen reading
    // the site in Hindi may well speak to the bot in Punjabi, and the bot
    // follows the voice, not the chrome.
    detected: conversation.draft?.lastLanguage || conversation.draft?.language || null,
    pipeline: pipeline || null,
  };
}

/**
 * Open a new interview.
 *
 * The portal language is only a starting guess for the very first prompt,
 * before the citizen has said anything we could identify. From their first
 * utterance onward the conversation follows what they actually speak.
 */
chatRouter.post('/start', async (req, res, next) => {
  try {
    const language = req.body?.language || req.citizen.preferred_language || 'en';
    const conversation = await startConversation(req.citizen.id, language);
    // Warm this language's division names while the citizen types their
    // complaint, so the routing reply does not have to wait for them.
    warmDivisionNames(language, DIVISIONS).catch(() => {});
    const reply = prompt(conversation, req.citizen);
    return res.json(view(conversation, req.citizen, reply));
  } catch (err) {
    return next(err);
  }
});

/**
 * Past interviews.
 *
 * Declared before /:id or Express would read "history" as a conversation id.
 */
chatRouter.get('/history', async (req, res, next) => {
  try {
    return res.json({ conversations: await listConversations(req.citizen.id, req.query.limit) });
  } catch (err) {
    return next(err);
  }
});

/** Resume an interview. */
chatRouter.get('/:id', async (req, res, next) => {
  try {
    const conversation = await getConversation(req.citizen.id, Number(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'not_found' });
    const reply = prompt(conversation, req.citizen);
    return res.json({ ...view(conversation, req.citizen, reply), transcript: conversation.transcript });
  } catch (err) {
    return next(err);
  }
});

/** One citizen utterance, typed or spoken. */
chatRouter.post('/:id/message', async (req, res, next) => {
  try {
    const conversation = await getConversation(req.citizen.id, Number(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'not_found' });

    const { text, inputMode, spoken } = req.body || {};
    if (!String(text || '').trim()) {
      return res.status(400).json({ error: 'empty_message', message: 'Nothing was said or typed.' });
    }

    const { conversation: updated, reply, pipeline } = await handleMessage(conversation, req.citizen, {
      text,
      inputMode: inputMode === 'voice' ? 'voice' : 'text',
      spoken: spoken && spoken.locale ? spoken : null,
    });

    return res.json(view(updated, req.citizen, reply, pipeline));
  } catch (err) {
    return next(err);
  }
});

/** Accept the suggested division, or choose a different one. */
chatRouter.post('/:id/division', async (req, res, next) => {
  try {
    const conversation = await getConversation(req.citizen.id, Number(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'not_found' });

    const { conversation: updated, reply } = await setDivision(
      conversation,
      req.citizen,
      req.body?.divisionId,
    );
    return res.json(view(updated, req.citizen, reply));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    return next(err);
  }
});

/** Edit anything in the draft from the review panel. */
chatRouter.patch('/:id/draft', async (req, res, next) => {
  try {
    const conversation = await getConversation(req.citizen.id, Number(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'not_found' });
    const { conversation: updated, reply } = await patchDraft(conversation, req.citizen, req.body || {});
    return res.json(view(updated, req.citizen, reply));
  } catch (err) {
    return next(err);
  }
});

/** The declaration of truth. */
chatRouter.post('/:id/declaration', async (req, res, next) => {
  try {
    const conversation = await getConversation(req.citizen.id, Number(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'not_found' });
    const { conversation: updated, reply } = await setDeclaration(
      conversation,
      req.citizen,
      req.body?.accepted === true,
    );
    return res.json(view(updated, req.citizen, reply));
  } catch (err) {
    return next(err);
  }
});

/**
 * Register the complaint.
 *
 * Refuses unless the interview is actually complete, so a client cannot post
 * a half-filled draft and create a record that fails the division's own
 * evidence requirements.
 */
chatRouter.post('/:id/submit', async (req, res, next) => {
  try {
    const conversation = await getConversation(req.citizen.id, Number(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'not_found' });

    if (conversation.grievance_id) {
      return res.status(409).json({ error: 'already_submitted', message: 'This complaint is already registered.' });
    }

    const step = nextStep(conversation.draft, req.citizen);
    if (step !== 'done') {
      return res.status(400).json({
        error: 'incomplete',
        message: 'The interview is not finished.',
        step,
        bot: prompt(conversation, req.citizen),
      });
    }

    const d = conversation.draft;

    // Name and gender are base fields: persist them on the citizen so the next
    // complaint does not ask again.
    if ((d.fullName && !req.citizen.full_name) || (d.gender && !req.citizen.gender)) {
      await query(
        `UPDATE citizens
            SET full_name = COALESCE(full_name, NULLIF($2,'')),
                gender = COALESCE(gender, NULLIF($3,'')),
                updated_at = NOW()
          WHERE id = $1`,
        [req.citizen.id, d.fullName || '', d.gender || ''],
      );
    }

    // A readable case heading for the docket list. One request, at the single
    // natural pause in the flow, and the first 120 characters of the complaint
    // remain a perfectly serviceable fallback.
    let subject = String(d.originalText).slice(0, 120);
    if (mistral.configured()) {
      const s = await mistral.summarise(d.originalText, d.translatedText);
      if (s.ok) subject = s.subject;
    }

    const { grievance } = await createGrievance({
      citizenId: req.citizen.id,
      divisionId: d.divisionId,
      originalText: d.originalText,
      translatedText: d.translatedText,
      translationProvider: d.translationProvider,
      subject,
      detectedLanguage: d.language?.code || conversation.language,
      detectedLocale: d.language?.locale || null,
      languageConfidence: d.language?.confidence || 0,
      languageMethod: d.language?.method || null,
      inputMode: (conversation.transcript || []).some((m) => m.inputMode === 'voice') ? 'voice' : 'text',
      classification: d.classification || {},
      pincode: d.pincode,
      district: d.district,
      address: d.address,
      latitude: d.latitude,
      longitude: d.longitude,
      dynamicDetails: d.details,
      /*
       * For an unlisted complaint the questions were written for it, so they
       * travel with the answers or the record cannot be read back.
       *
       * An ARRAY, not an object: JSONB normalises key order, so an object
       * loses the sequence the citizen was actually asked in and the record
       * reads as a jumble.
       */
      dynamicLabels: (d.otherQuestions || []).map((q) => ({ key: q.key, label: q.label })),
      declarationTruth: d.declarationTruth,
      audioPath: d.audioPath || null,
      attachments: d.attachments || [],
    });

    await linkGrievance(conversation.id, grievance.id);

    /*
     * Hand it to the department, without making the citizen wait for it.
     *
     * The docket above is already theirs: issued by us, from our database,
     * the moment they declared the complaint true. Whether the department
     * workspace accepts it in the next second or in five minutes when the
     * retry sweep runs is our problem, not something to hold a reply on - and
     * certainly not a reason to tell someone their grievance failed.
     */
    forwardGrievance(grievance.id).catch((err) =>
      console.error('[govt] forward failed', err.message));

    const sla = slaFor(grievance);
    const deadline = new Date(grievance.sla_deadline).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    return res.status(201).json({
      ok: true,
      reference: grievance.reference_id,
      division: divisionById(grievance.division_id),
      sla,
      spoken: t('submitted', conversation.language, { ref: grievance.reference_id, deadline }),
      grievance: {
        reference_id: grievance.reference_id,
        status: grievance.status,
        priority: grievance.priority,
        submitted_at: grievance.submitted_at,
        sla_deadline: grievance.sla_deadline,
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(422).json({ error: err.code, message: err.message, errors: err.errors });
    }
    return next(err);
  }
});
