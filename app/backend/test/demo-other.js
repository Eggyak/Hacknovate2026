/**
 * Walk the unlisted-complaint path and print the conversation.
 *
 * The complaint below is deliberately outside all fifteen MHA divisions - it
 * is a consumer matter, not internal security - so the keyword classifier
 * should decline to guess, the citizen should be offered the catch-all, and
 * the questions that follow should be written for this complaint rather than
 * read from a form that does not apply.
 *
 *   docker exec mha-api node test/demo-other.js
 */

import jwt from 'jsonwebtoken';
import { pool, query } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';

const BASE = `http://127.0.0.1:${env.port}`;

const COMPLAINT =
  'A private coaching institute in our town took eighty thousand rupees in advance fees '
  + 'from forty students for a one year course, ran classes for three weeks, then locked '
  + 'the building and stopped answering calls. The owner has left the district. We have '
  + 'receipts but nobody will tell us which office is responsible.';

function say(who, text) {
  const label = who === 'bot' ? 'BOT     ' : 'CITIZEN ';
  console.log(`${label} ${text}`);
}

async function main() {
  const mobile = '9000000071';
  await query('DELETE FROM citizens WHERE mobile = $1', [mobile]);
  const citizen = (await query(
    'INSERT INTO citizens (mobile, mobile_verified, full_name, gender) VALUES ($1, TRUE, $2, $3) RETURNING *',
    [mobile, 'Demo Citizen', 'Male'],
  )).rows[0];
  const token = jwt.sign({ sub: String(citizen.id), mobile }, env.jwt.secret,
    { expiresIn: 900, issuer: 'mha-samadhan' });

  const api = async (path, opts = {}) => {
    const res = await fetch(`${BASE}/api${path}`, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const start = await api('/chat/start', { method: 'POST', body: { language: 'en' } });
  const id = start.data.conversationId;
  say('bot', start.data.bot.text);

  console.log('');
  say('citizen', COMPLAINT);
  const first = await api(`/chat/${id}/message`, {
    method: 'POST', body: { text: COMPLAINT, inputMode: 'text' },
  });
  say('bot', first.data.bot.text);

  const cls = (first.data.pipeline?.steps || []).find((s) => s.stage === 'classification');
  const llm = (first.data.pipeline?.steps || []).find((s) => s.stage === 'llm-adjudication');
  console.log('');
  console.log('  routing   :', cls?.detail?.divisionId ?? 'no match',
    cls?.detail?.confidence !== undefined ? `(keywords, confidence ${cls.detail.confidence})` : '');
  if (llm) {
    console.log('  llm       :', llm.detail?.ran
      ? `${llm.detail.divisionId ?? 'none'} — ${llm.detail.reason || ''}`
      : `not consulted (${llm.detail?.reason})`);
  }
  console.log('  asked to choose:', first.data.bot?.input?.kind === 'choose_division' ? 'yes' : 'no');

  console.log('\n--- citizen picks "Other / Not listed" ---\n');
  const chosen = await api(`/chat/${id}/division`, { method: 'POST', body: { divisionId: 'other' } });

  const plan = chosen.data.draft?.otherPlan || {};
  const questions = chosen.data.draft?.otherQuestions || [];
  console.log(`  questions written by: ${plan.source}${plan.model ? ` (${plan.model})` : ''}`);
  console.log(`  count               : ${questions.length}\n`);
  questions.forEach((q, i) => console.log(`   ${i + 1}. ${q.label}`));

  console.log('\n--- the interview continues ---\n');
  say('bot', chosen.data.bot.text);

  /*
   * The questions are written by the model and differ run to run, so a fixed
   * list of answers in a fixed order produces a transcript where nothing
   * lines up. Answer each question on what it actually asks for.
   */
  const answerFor = (label) => {
    const q = label.toLowerCase();
    if (/name of the (private )?(coaching )?institute|institute.*name/.test(q)) {
      return 'Vidya Path Coaching Institute';
    }
    if (/town|city|where|location|located|address of the/.test(q)) return 'Mukerian, Hoshiarpur district, Punjab';
    if (/owner|proprietor|who ran|director/.test(q)) return 'Rakesh Mehta, the proprietor';
    if (/when|date|period|how long/.test(q)) return 'Fees were collected between 2 and 10 August 2026';
    if (/how much|amount|fees paid|total|rupees|money/.test(q)) return 'Eighty thousand rupees across forty students';
    if (/how many|number of students|affected/.test(q)) return 'Forty students';
    if (/steps|reported|police|complaint|action taken|so far/.test(q)) {
      return 'We went to the local police station but no FIR was registered';
    }
    if (/evidence|receipt|proof|document/.test(q)) return 'Signed fee receipts and the building rental agreement';
    if (/outcome|want|expect|seeking|relief/.test(q)) return 'Refund of the fees and an investigation into the institute';
    return 'We do not have that information';
  };

  for (const [label, text] of [['pincode', '144211'], ['district', 'Hoshiarpur'],
    ['address', 'Main Bazaar, Mukerian, Punjab']]) {
    say('citizen', text);
    const r = await api(`/chat/${id}/message`, { method: 'POST', body: { text, inputMode: 'text' } });
    say('bot', r.data.bot.text);
    void label;
  }

  await api(`/chat/${id}/draft`, { method: 'PATCH', body: { skipLocationPin: true } });
  await api(`/chat/${id}/declaration`, { method: 'POST', body: { accepted: true } });

  const done = await api(`/chat/${id}/submit`, { method: 'POST', body: {} });
  console.log('');
  if (done.status !== 201) {
    console.log('  SUBMIT FAILED:', JSON.stringify(done.data).slice(0, 300));
  } else {
    console.log('  docket    :', done.data.reference);
    console.log('  division  :', done.data.division.name);
    console.log('  due by    :', new Date(done.data.sla.deadline).toDateString());

    const g = (await query('SELECT * FROM grievances WHERE reference_id = $1',
      [done.data.reference])).rows[0];
    console.log('  subject   :', g.subject);
    console.log('\n  stored, as an officer would read it:');
    for (const [k, v] of Object.entries(g.dynamic_details || {})) {
      console.log(`    ${g.dynamic_labels?.[k] || k}`);
      console.log(`      -> ${v}`);
    }
  }

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
