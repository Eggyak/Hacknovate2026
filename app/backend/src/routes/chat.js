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
import { divisionById } from '../data/divisions.js';
import { t } from '../data/phrases.js';
import { query } from '../lib/db.js';

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
    pipeline: pipeline || null,
  };
}

/** Open a new interview. */
chatRouter.post('/start', async (req, res, next) => {
  try {
    const language = req.body?.language || req.citizen.preferred_language || 'en';
    const conversation = await startConversation(req.citizen.id, language);
    const reply = prompt(conversation, req.citizen);
    return res.json(view(conversation, req.citizen, reply));
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

    const { grievance } = await createGrievance({
      citizenId: req.citizen.id,
      divisionId: d.divisionId,
      originalText: d.originalText,
      translatedText: d.translatedText,
      translationProvider: d.translationProvider,
      subject: String(d.originalText).slice(0, 120),
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
      declarationTruth: d.declarationTruth,
      attachments: d.attachments || [],
    });

    await linkGrievance(conversation.id, grievance.id);

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
