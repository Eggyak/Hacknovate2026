/**
 * End-to-end check against a running instance.
 *
 * Walks the whole interview the way a citizen does - in Hindi, then Tamil -
 * and asserts on what comes back out of the database at the end: the docket
 * number, the routing decision, the SLA deadline, and that Aadhaar was masked
 * before storage.
 *
 * It creates its own citizens and deletes them afterwards, so it is safe to
 * run against the deployed stack.
 *
 *   docker exec mha-api node test/e2e.js
 */

import jwt from 'jsonwebtoken';
import { pool, query } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';

const BASE = `http://127.0.0.1:${env.port}`;
const results = [];
let failed = 0;

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function makeCitizen(mobile) {
  await query('DELETE FROM citizens WHERE mobile = $1', [mobile]);
  const r = await query(
    `INSERT INTO citizens (mobile, mobile_verified, preferred_language)
     VALUES ($1, TRUE, 'hi') RETURNING *`,
    [mobile],
  );
  const citizen = r.rows[0];
  const token = jwt.sign({ sub: String(citizen.id), mobile }, env.jwt.secret, {
    expiresIn: 3600,
    issuer: 'mha-samadhan',
  });
  return { citizen, token };
}

function client(token) {
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}

async function runCyberHindi() {
  console.log('\n--- Hindi cyber-fraud complaint ---');
  const { citizen, token } = await makeCitizen('9000000001');
  const api = client(token);

  const start = await api('/chat/start', { method: 'POST', body: { language: 'hi' } });
  check('interview opens', start.status === 200 && start.data.conversationId);
  const id = start.data.conversationId;

  const complaint =
    'मेरे बैंक खाते से ओटीपी के जरिए पचास हजार रुपये की धोखाधड़ी हुई है। किसी ने फर्जी वेबसाइट बनाकर यूपीआई से पैसे निकाल लिए।';
  const said = await api(`/chat/${id}/message`, {
    method: 'POST',
    body: { text: complaint, inputMode: 'text' },
  });

  const pipe = said.data.pipeline?.steps || [];
  const lid = pipe.find((s) => s.stage === 'language-identification');
  const cls = pipe.find((s) => s.stage === 'classification');

  check('language identified as Hindi', lid?.detail?.code === 'hi', `got ${lid?.detail?.code}`);
  check('language detection explains itself', (lid?.detail?.evidence || []).length > 0);
  check('routed to Cyber division', cls?.detail?.divisionId === 'cyber', `got ${cls?.detail?.divisionId}`);
  check('routing cites matched terms', (cls?.detail?.matched || []).length > 0,
    (cls?.detail?.matched || []).map((m) => m.term).join(' '));

  const translation = pipe.find((s) => s.stage === 'translation');
  check('translation stage reports its own state', Boolean(translation),
    translation?.detail?.produced ? 'produced' : `skipped: ${translation?.detail?.reason}`);

  await api(`/chat/${id}/division`, { method: 'POST', body: { divisionId: 'cyber' } });

  // The division's required fields, answered one at a time.
  const answers = ['UTR123456789012', '50000', '2026-10-28 14:30', 'Fake website'];
  for (const a of answers) {
    await api(`/chat/${id}/message`, { method: 'POST', body: { text: a, inputMode: 'text' } });
  }

  await api(`/chat/${id}/message`, { method: 'POST', body: { text: '110001', inputMode: 'text' } });
  const afterPin = await api(`/chat/${id}/message`, {
    method: 'POST',
    body: { text: 'House 12, Connaught Place, New Delhi', inputMode: 'text' },
  });
  check('PIN resolved to a state', afterPin.data.draft?.state === 'Delhi', `got ${afterPin.data.draft?.state}`);

  await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'Test Citizen', inputMode: 'text' } });
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'Male', inputMode: 'text' } });

  const beforeDecl = await api(`/chat/${id}/submit`, { method: 'POST', body: {} });
  check('submission refused without the declaration', beforeDecl.status === 400,
    `HTTP ${beforeDecl.status}`);

  await api(`/chat/${id}/declaration`, { method: 'POST', body: { accepted: true } });
  const done = await api(`/chat/${id}/submit`, { method: 'POST', body: {} });

  check('grievance registered', done.status === 201, `HTTP ${done.status}`);
  check('docket number issued', /^MHA-GRV-\d{4}-\d{6}$/.test(done.data.reference || ''),
    done.data.reference);

  const row = (await query('SELECT * FROM grievances WHERE reference_id = $1', [done.data.reference])).rows[0];
  check('stored in the original script', row && row.original_text.includes('धोखाधड़ी'));
  check('division persisted', row?.division_id === 'cyber');
  check('declaration recorded', row?.declaration_truth === true);

  const days = Math.round((new Date(row.sla_deadline) - new Date(row.submitted_at)) / 86_400_000);
  check('SLA deadline is 21 days out', days === 21, `${days} days`);

  const detail = await api(`/grievances/${done.data.reference}`);
  check('citizen can read it back', detail.status === 200);
  check('timeline has an entry', (detail.data.events || []).length > 0);

  const other = await makeCitizen('9000000009');
  const theirs = client(other.token);
  const peek = await theirs(`/grievances/${done.data.reference}`);
  check('another citizen cannot read it', peek.status === 404, `HTTP ${peek.status}`);
  await query('DELETE FROM citizens WHERE mobile = $1', ['9000000009']);

  const pub = await fetch(`${BASE}/api/grievances/track/${done.data.reference}`);
  const pubData = await pub.json();
  check('public tracking works without a session', pub.status === 200);
  check('public tracking leaks no complaint text', !JSON.stringify(pubData).includes('धोखाधड़ी'));

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
  return done.data.reference;
}

async function runDisasterTamil() {
  console.log('\n--- Tamil disaster-relief complaint, with Aadhaar ---');
  const { citizen, token } = await makeCitizen('9000000002');
  const api = client(token);

  const start = await api('/chat/start', { method: 'POST', body: { language: 'ta' } });
  const id = start.data.conversationId;

  const complaint =
    'புயலில் எங்கள் வீடு இடிந்து விழுந்தது, இதுவரை எந்த நிவாரணமும் கிடைக்கவில்லை. உதவி செய்யுங்கள்.';
  const said = await api(`/chat/${id}/message`, {
    method: 'POST',
    body: { text: complaint, inputMode: 'text' },
  });

  const pipe = said.data.pipeline?.steps || [];
  const lid = pipe.find((s) => s.stage === 'language-identification');
  const cls = pipe.find((s) => s.stage === 'classification');
  check('Tamil identified', lid?.detail?.code === 'ta', `got ${lid?.detail?.code}`);
  check('routed to Disaster Management', cls?.detail?.divisionId === 'disaster',
    `got ${cls?.detail?.divisionId}`);

  await api(`/chat/${id}/division`, { method: 'POST', body: { divisionId: 'disaster' } });

  const aadhaar = '234567890123';
  for (const a of [aadhaar, '50100123456789', 'SBIN0001234', 'Cyclone Dana', 'House Collapse']) {
    await api(`/chat/${id}/message`, { method: 'POST', body: { text: a, inputMode: 'text' } });
  }
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: '600001', inputMode: 'text' } });
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: '14 Marina Road, Chennai', inputMode: 'text' } });
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'Test Citizen Two', inputMode: 'text' } });
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'Female', inputMode: 'text' } });
  await api(`/chat/${id}/declaration`, { method: 'POST', body: { accepted: true } });

  const done = await api(`/chat/${id}/submit`, { method: 'POST', body: {} });
  check('Tamil grievance registered', done.status === 201, `HTTP ${done.status}`);

  const row = (await query('SELECT * FROM grievances WHERE reference_id = $1', [done.data.reference])).rows[0];
  const stored = JSON.stringify(row.dynamic_details);
  check('Aadhaar is NOT stored in full', !stored.includes(aadhaar), stored.slice(0, 90));
  check('Aadhaar last 4 retained for matching', stored.includes('0123'));
  check('PIN resolved to Tamil Nadu', row.state === 'Tamil Nadu', `got ${row.state}`);

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

async function runValidation() {
  console.log('\n--- validation and refusals ---');
  const { citizen, token } = await makeCitizen('9000000003');
  const api = client(token);

  const start = await api('/chat/start', { method: 'POST', body: { language: 'en' } });
  const id = start.data.conversationId;

  const vague = await api(`/chat/${id}/message`, {
    method: 'POST',
    body: { text: 'Hello I would like some general information please', inputMode: 'text' },
  });
  const cls = (vague.data.pipeline?.steps || []).find((s) => s.stage === 'classification');
  check('refuses to guess a division on vague text', !cls?.detail?.divisionId,
    `got ${cls?.detail?.divisionId}`);
  check('asks the citizen to choose instead', vague.data.bot?.input?.kind === 'choose_division',
    vague.data.bot?.input?.kind);

  await api(`/chat/${id}/division`, { method: 'POST', body: { divisionId: 'cyber' } });
  const bad = await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'xx', inputMode: 'text' } });
  check('a malformed UTR does not advance the interview',
    bad.data.bot?.input?.field?.key === 'transaction_id' || bad.data.step === 'details',
    `step ${bad.data.step}`);

  const noAuth = await fetch(`${BASE}/api/grievances`);
  check('unauthenticated listing is refused', noAuth.status === 401, `HTTP ${noAuth.status}`);

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

async function runSpeech() {
  console.log('\n--- speech ---');
  const { citizen, token } = await makeCitizen('9000000004');
  const api = client(token);

  const tok = await api('/speech/token');
  check('speech token issued', tok.status === 200 && Boolean(tok.data.token));
  check('LID candidates within Azure\'s limit of 10',
    tok.data.candidates?.length > 0 && tok.data.candidates.length <= 10,
    `${tok.data.candidates?.length} candidates`);
  check('citizen\'s own language is a candidate', tok.data.candidates?.includes('hi-IN'),
    (tok.data.candidates || []).join(','));

  const res = await fetch(`${BASE}/api/speech/speak`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'आपकी शिकायत दर्ज हो गई है।', language: 'hi' }),
  });
  const audio = Buffer.from(await res.arrayBuffer());
  check('Hindi speech synthesised', res.status === 200 && audio.length > 2000,
    `${audio.length} bytes, voice ${res.headers.get('x-voice')}`);

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

async function main() {
  console.log(`Testing ${BASE}`);
  try {
    await runCyberHindi();
    await runDisasterTamil();
    await runValidation();
    await runSpeech();
  } catch (err) {
    console.error('\nUNCAUGHT', err);
    failed += 1;
  }

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main();
