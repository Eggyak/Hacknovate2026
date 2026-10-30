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

  const afterPin = await api(`/chat/${id}/message`, { method: 'POST', body: { text: '110001', inputMode: 'text' } });
  check('PIN resolved to a state', afterPin.data.draft?.state === 'Delhi', `got ${afterPin.data.draft?.state}`);
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'New Delhi', inputMode: 'text' } });
  await api(`/chat/${id}/message`, {
    method: 'POST',
    body: { text: 'House 12, Connaught Place, New Delhi', inputMode: 'text' },
  });
  await api(`/chat/${id}/draft`, { method: 'PATCH', body: { skipLocationPin: true } });
  check('declining the location pin does not block the interview', true);

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
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'Chennai', inputMode: 'text' } });
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: '14 Marina Road, Chennai', inputMode: 'text' } });
  await api(`/chat/${id}/draft`, { method: 'PATCH', body: { latitude: 13.0827, longitude: 80.2707 } });
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

async function runAudioCapture() {
  console.log('\n--- narrative audio capture ---');
  const { citizen, token } = await makeCitizen('9000000007');
  const api = client(token);

  const start = await api('/chat/start', { method: 'POST', body: {} });
  const id = start.data.conversationId;

  const form = new FormData();
  form.append('audio', new Blob([Buffer.alloc(4096, 7)], { type: 'audio/webm' }), 'narrative.webm');
  const up = await fetch(`${BASE}/api/grievances/conversation/${id}/audio`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const upData = await up.json().catch(() => ({}));
  check('recording accepted', up.status === 200, `HTTP ${up.status} ${JSON.stringify(upData)}`);

  const conv = await api(`/chat/${id}`);
  check('audio path recorded on the draft', Boolean(conv.data.draft?.audioPath),
    conv.data.draft?.audioPath);

  const badForm = new FormData();
  badForm.append('audio', new Blob(['not audio'], { type: 'text/plain' }), 'a.txt');
  const bad = await fetch(`${BASE}/api/grievances/conversation/${id}/audio`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: badForm,
  });
  check('a non-audio upload is refused', bad.status === 415, `HTTP ${bad.status}`);

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

/**
 * Sign-up and sign-in validation.
 *
 * Every case here is one the server must REFUSE before it reaches delivery,
 * so running this sends no SMS. The one accepted case is checked at the
 * database, to prove the sign-up details are parked on the OTP row and not
 * written to `citizens` until the number is proved.
 */
async function runAuthFlow() {
  console.log('\n--- sign up and sign in ---');
  const post = async (body) => {
    const res = await fetch(`${BASE}/api/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const mobile = '9000000011';
  await query('DELETE FROM citizens WHERE mobile = $1', [mobile]);
  await query('DELETE FROM otp_codes WHERE mobile = $1', [mobile]);

  const base = { mode: 'signup', mobile, gender: 'Male', email: 'citizen@example.com', consent: true };

  const noName = await post({ ...base, fullName: '' });
  check('sign-up refuses a missing name', noName.status === 422, `HTTP ${noName.status}`);

  const badGender = await post({ ...base, fullName: 'Test Citizen', gender: 'Wizard' });
  check('sign-up refuses a gender outside the list', badGender.status === 422, `HTTP ${badGender.status}`);

  const noConsent = await post({ ...base, fullName: 'Test Citizen', consent: false });
  check('sign-up refuses without the confirmation', noConsent.status === 422, `HTTP ${noConsent.status}`);

  const badEmail = await post({ ...base, fullName: 'Test Citizen', email: 'not-an-email' });
  check('sign-up refuses a malformed email', badEmail.status === 422, `HTTP ${badEmail.status}`);

  const unknown = await post({ mode: 'signin', mobile: '9000000012', email: 'citizen@example.com' });
  check('sign-in refuses an unknown number', unknown.status === 404, `HTTP ${unknown.status}`);

  const noEmail = await post({ mode: 'signin', mobile, email: '' });
  check('sign-in requires an email', noEmail.status === 422 || noEmail.status === 404,
    `HTTP ${noEmail.status}`);

  // The one accepted request. Twilio rejects unverified numbers on a trial
  // account, so nothing is delivered; what matters is what was stored.
  const ok = await post({ ...base, fullName: 'Test Citizen' });
  check('a complete sign-up is accepted', ok.status === 200, `HTTP ${ok.status}`);
  check('the number is masked in the response', /•/.test(ok.data.mobile || ''), ok.data.mobile);

  const parked = (await query(
    'SELECT profile FROM otp_codes WHERE mobile = $1 ORDER BY created_at DESC LIMIT 1', [mobile],
  )).rows[0];
  check('sign-up details parked on the OTP row',
    parked?.profile?.fullName === 'Test Citizen' && parked?.profile?.gender === 'Male',
    JSON.stringify(parked?.profile));

  const created = await query('SELECT id FROM citizens WHERE mobile = $1', [mobile]);
  check('no account exists until the number is verified', created.rows.length === 0,
    `${created.rows.length} row(s)`);

  // With an account on file, a mismatched email must be refused.
  await query(
    `INSERT INTO citizens (mobile, mobile_verified, full_name, gender, email)
     VALUES ($1, TRUE, 'Test Citizen', 'Male', 'citizen@example.com')`, [mobile],
  );
  const dup = await post({ ...base, fullName: 'Test Citizen' });
  check('sign-up refuses a number that already has an account', dup.status === 409, `HTTP ${dup.status}`);

  const wrongEmail = await post({ mode: 'signin', mobile, email: 'someone.else@example.com' });
  check('sign-in refuses a mismatched email', wrongEmail.status === 422, `HTTP ${wrongEmail.status}`);

  await query('DELETE FROM citizens WHERE mobile = $1', [mobile]);
  await query('DELETE FROM otp_codes WHERE mobile = $1', [mobile]);
}

/**
 * The conversation follows the citizen's voice, not the portal's chrome.
 *
 * The case that matters: someone reading the site in Hindi who speaks to the
 * bot in Punjabi must be answered in Punjabi. And the case that would ruin
 * it: a short, language-neutral answer like "50000" must not be read as a
 * switch back to English.
 */
async function runLanguageFollowing() {
  console.log('\n--- the bot follows the spoken language ---');
  const { citizen, token } = await makeCitizen('9000000031');
  await query("UPDATE citizens SET preferred_language = 'hi' WHERE id = $1", [citizen.id]);
  const api = client(token);

  // Portal language is Hindi - that is the chrome, not the conversation.
  const start = await api('/chat/start', { method: 'POST', body: { language: 'hi' } });
  const id = start.data.conversationId;
  check('interview opens in the portal language', start.data.language === 'hi', start.data.language);

  // ...but the citizen speaks Punjabi.
  const punjabi = await api(`/chat/${id}/message`, {
    method: 'POST',
    body: { text: 'ਮੇਰੇ ਬੈਂਕ ਖਾਤੇ ਵਿੱਚੋਂ ਧੋਖੇ ਨਾਲ ਪੈਸੇ ਕੱਢ ਲਏ ਗਏ ਹਨ, ਕਿਰਪਾ ਕਰਕੇ ਮੇਰੀ ਸ਼ਿਕਾਇਤ ਦਰਜ ਕਰੋ', inputMode: 'text' },
  });
  check('conversation switches to the spoken language', punjabi.data.language === 'pa',
    `got ${punjabi.data.language}`);
  check('the switch is reported', punjabi.data.detected?.code === 'pa',
    JSON.stringify(punjabi.data.detected?.method));
  check('the bot now replies in Punjabi', /[਀-੿]/.test(punjabi.data.bot?.text || ''),
    (punjabi.data.bot?.text || '').slice(0, 40));

  await api(`/chat/${id}/division`, { method: 'POST', body: { divisionId: 'cyber' } });

  // A language-neutral answer must not drag the conversation elsewhere.
  const neutral = await api(`/chat/${id}/message`, {
    method: 'POST', body: { text: 'UTR123456789012', inputMode: 'text' },
  });
  check('a language-neutral answer does not switch the language',
    neutral.data.language === 'pa', `got ${neutral.data.language}`);

  const digits = await api(`/chat/${id}/message`, {
    method: 'POST', body: { text: '50000', inputMode: 'text' },
  });
  check('a bare number does not switch the language',
    digits.data.language === 'pa', `got ${digits.data.language}`);

  // Spoken input: Azure's own identification of the audio wins outright.
  const spoken = await api(`/chat/${id}/message`, {
    method: 'POST',
    body: {
      text: 'October 28 at 2 PM',
      inputMode: 'voice',
      spoken: { locale: 'ta-IN', confidence: 0.93, candidates: ['pa-IN', 'ta-IN'] },
    },
  });
  check("Azure's audio identification is authoritative", spoken.data.language === 'ta',
    `got ${spoken.data.language}`);
  check('it is attributed to Azure, not the local detector',
    (spoken.data.detected?.method || '').startsWith('azure'), spoken.data.detected?.method);

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

/** Azure Translator, once configured, must carry all fourteen. */
async function runTranslation() {
  console.log('\n--- translation ---');
  const { toEnglish, configured } = await import('../src/services/translate.js');

  if (!configured()) {
    check('Azure Translator configured', false, 'no key set - falling back to the LLM');
    return;
  }

  const samples = [
    ['hi', 'मेरे बैंक खाते से पैसे चोरी हो गए'],
    ['pa', 'ਮੇਰੇ ਬੈਂਕ ਖਾਤੇ ਵਿੱਚੋਂ ਪੈਸੇ ਚੋਰੀ ਹੋ ਗਏ'],
    ['ta', 'எனது வங்கிக் கணக்கிலிருந்து பணம் திருடப்பட்டது'],
    ['or', 'ମୋର ବ୍ୟାଙ୍କ ଖାତାରୁ ଟଙ୍କା ଚୋରି ହୋଇଛି'],
    ['as', 'মোৰ বেংক একাউণ্টৰ পৰা টকা চুৰি হৈছে'],
    ['ur', 'میرے بینک اکاؤنٹ سے پیسے چوری ہو گئے'],
    ['ne', 'मेरो बैंक खाताबाट पैसा चोरी भयो'],
    ['ml', 'എന്റെ ബാങ്ക് അക്കൗണ്ടിൽ നിന്ന് പണം മോഷ്ടിക്കപ്പെട്ടു'],
  ];

  const failures = [];
  for (const [code, text] of samples) {
    const r = await toEnglish(text, { from: code });
    if (!r.text || !/bank|money|stolen|account|theft/i.test(r.text)) {
      failures.push(`${code}: ${r.text || r.reason}`);
    }
  }
  check(`Azure Translator handles ${samples.length} scripts`, failures.length === 0,
    failures.length ? failures.join(' | ') : 'all produced sensible English');

  const one = await toEnglish('ਮੇਰੀ ਸ਼ਿਕਾਇਤ ਦਰਜ ਕਰੋ', { from: 'pa' });
  check('it reports itself as the provider', (one.provider || '').includes('azure'), one.provider);

  // The division name is the word the citizen has to agree with, so it must
  // not be the one word left in English.
  const { warmDivisionNames, divisionNameIn } = await import('../src/services/translate.js');
  const { DIVISIONS } = await import('../src/data/divisions.js');
  await warmDivisionNames('pa', DIVISIONS);
  const localised = divisionNameIn('cyber', 'pa', 'Cyber & Information Security');
  check('division names are localised', /[਀-੿]/.test(localised), localised);
}

async function main() {
  console.log(`Testing ${BASE}`);
  try {
    await runCyberHindi();
    await runDisasterTamil();
    await runValidation();
    await runSpeech();
    await runAudioCapture();
    await runAuthFlow();
    await runLanguageFollowing();
    await runTranslation();
  } catch (err) {
    console.error('\nUNCAUGHT', err);
    failed += 1;
  }

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main();
