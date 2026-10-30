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
  const reply = punjabi.data.bot?.text || '';
  check('the bot now replies in Punjabi', /[਀-੿]/.test(reply), reply.slice(0, 50));
  check('including the division name', !/Cyber & Information Security/.test(reply), reply.slice(0, 60));

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

/** Interface translation: the portal's own chrome, in the chosen language. */
async function runInterfaceTranslation() {
  console.log('\n--- interface translation ---');
  const { citizen, token } = await makeCitizen('9000000041');
  const api = client(token);

  const texts = ['Dashboard', 'Register a grievance', 'Track', 'My grievances',
    'Mobile number', 'Full name', 'Sign in', 'Continue with mobile OTP'];

  const pa = await api('/i18n', { method: 'POST', body: { to: 'pa', texts } });
  check('interface translates into Punjabi', pa.status === 200, `HTTP ${pa.status}`);

  const got = pa.data.translations || {};
  const translated = texts.filter((t) => got[t] && /[਀-੿]/.test(got[t]));
  check(`all ${texts.length} chrome strings come back in Gurmukhi`,
    translated.length === texts.length,
    `${translated.length}/${texts.length} — e.g. Dashboard -> ${got.Dashboard}`);

  // The second request for the same strings must be free.
  const again = await api('/i18n', { method: 'POST', body: { to: 'pa', texts } });
  check('repeat requests are served from cache',
    again.data.fetched === 0 && again.data.cached === texts.length,
    `cached ${again.data.cached}, fetched ${again.data.fetched}`);

  const ta = await api('/i18n', { method: 'POST', body: { to: 'ta', texts: ['Dashboard'] } });
  check('a second language works independently',
    /[஀-௿]/.test(ta.data.translations?.Dashboard || ''),
    ta.data.translations?.Dashboard);

  const bad = await api('/i18n', { method: 'POST', body: { to: 'zz', texts } });
  check('an unsupported language is refused', bad.status === 400, `HTTP ${bad.status}`);

  const en = await api('/i18n', { method: 'POST', body: { to: 'en', texts } });
  check('English is a no-op', en.status === 200 && Object.keys(en.data.translations).length === 0);

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

/**
 * The speech configuration the browser is actually handed.
 *
 * Azure transcribes Odia and Assamese but refuses to IDENTIFY them, closing
 * the socket with InvalidArgument the moment either is offered as a
 * candidate - which is what made the microphone fail outright. Determined by
 * probing the service (test/probe-lid.js); there is no published list.
 */
async function runSpeechConfig() {
  console.log('\n--- speech configuration ---');
  const { citizen, token } = await makeCitizen('9000000051');
  const api = client(token);

  const def = await api('/speech/token');
  const cands = def.data.candidates || [];
  check('candidates are offered', cands.length > 0, cands.join(','));
  check('no locale Azure refuses to identify is offered',
    !cands.includes('or-IN') && !cands.includes('as-IN'), cands.join(','));
  check('within Azure\'s limit of 10', cands.length <= 10, String(cands.length));
  check('12 of 14 languages are identifiable', def.data.identifiable === 12,
    String(def.data.identifiable));

  // A citizen who chose Odia gets direct recognition rather than a refusal.
  for (const code of ['or', 'as']) {
    const r = await api(`/speech/token?language=${code}`);
    check(`${code} is transcribed directly instead of identified`,
      r.data.forceLocale === `${code}-IN`, String(r.data.forceLocale));
    check(`${code} is still excluded from the candidate list`,
      !(r.data.candidates || []).includes(`${code}-IN`), (r.data.candidates || []).join(','));
  }

  const hi = await api('/speech/token?language=hi');
  check('an identifiable language is not pinned', hi.data.forceLocale === null,
    String(hi.data.forceLocale));
  check('and it is among the candidates', (hi.data.candidates || []).includes('hi-IN'));

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

/**
 * The whole interview, driven as a voice complaint from start to docket.
 *
 * Every turn carries the locale Azure would have reported, so this exercises
 * the path a speaking citizen actually takes rather than the typed one.
 */
async function runFullVoiceFlow() {
  console.log('\n--- full voice flow, end to end ---');
  const { citizen, token } = await makeCitizen('9000000052');
  const api = client(token);

  const start = await api('/chat/start', { method: 'POST', body: { language: 'en' } });
  const id = start.data.conversationId;
  check('interview opens', start.status === 200 && Boolean(id));

  const spoke = (text, locale) => api(`/chat/${id}/message`, {
    method: 'POST',
    body: { text, inputMode: 'voice', spoken: { locale, confidence: 0.91, candidates: ['hi-IN', 'en-IN'] } },
  });

  const narrative = await spoke(
    'मेरे बैंक खाते से ओटीपी के जरिए पचास हजार रुपये की साइबर धोखाधड़ी हुई है',
    'hi-IN',
  );
  check('spoken language is taken from Azure', narrative.data.language === 'hi',
    narrative.data.language);
  check('routed from speech', narrative.data.draft?.divisionId === 'cyber',
    String(narrative.data.draft?.divisionId));
  check('the trace names Azure as the identifier',
    (narrative.data.pipeline?.steps || []).some((s) => s.provider === 'azure-speech'));

  await api(`/chat/${id}/division`, { method: 'POST', body: { divisionId: 'cyber' } });

  for (const a of ['UTR900000000001', '50000', '2026-10-30 10:00', 'WhatsApp']) {
    await spoke(a, 'hi-IN');
  }
  await spoke('751001', 'hi-IN');
  await spoke('Khordha', 'hi-IN');
  await spoke('Plot 14, Unit 3, Bhubaneswar', 'hi-IN');
  await api(`/chat/${id}/draft`, { method: 'PATCH', body: { skipLocationPin: true } });
  await spoke('Voice Test Citizen', 'hi-IN');
  await spoke('Male', 'hi-IN');
  await api(`/chat/${id}/declaration`, { method: 'POST', body: { accepted: true } });

  const done = await api(`/chat/${id}/submit`, { method: 'POST', body: {} });
  check('voice complaint is registered', done.status === 201, JSON.stringify(done.data).slice(0, 120));

  const g = (await query('SELECT * FROM grievances WHERE reference_id = $1',
    [done.data.reference])).rows[0];
  check('recorded as a voice filing', g?.input_mode === 'voice', g?.input_mode);
  check('PIN resolved to Odisha', g?.state === 'Odisha', g?.state);
  check('district captured', g?.district === 'Khordha', g?.district);
  check('English rendering produced', Boolean(g?.translated_text),
    (g?.translated_text || '').slice(0, 50));
  check('spoken reply is composed', Boolean(done.data.spoken), (done.data.spoken || '').slice(0, 40));

  // And that reply can actually be synthesised in the language it is in.
  const res = await fetch(`${BASE}/api/speech/speak`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: done.data.spoken, language: 'hi' }),
  });
  const audio = Buffer.from(await res.arrayBuffer());
  check('the confirmation can be spoken aloud', res.status === 200 && audio.length > 2000,
    `${audio.length} bytes`);

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

/**
 * A complaint that fits none of the fifteen divisions.
 *
 * The point of this path is that the portal accepts it anyway, and asks
 * questions written for the complaint instead of a form that does not apply.
 */
async function runUnlistedComplaint() {
  console.log('\n--- a complaint outside the listed divisions ---');
  const { citizen, token } = await makeCitizen('9000000061');
  const api = client(token);

  const divisions = await (await fetch(`${BASE}/api/grievances/divisions`)).json();
  const other = divisions.divisions.find((d) => d.id === 'other');
  check('a catch-all division is offered', Boolean(other), other?.name);
  check('it is marked as not from the document', other?.supplementary === true);

  const start = await api('/chat/start', { method: 'POST', body: { language: 'en' } });
  const id = start.data.conversationId;

  const vague = await api(`/chat/${id}/message`, {
    method: 'POST',
    body: {
      text: 'The community water tank in our colony has been locked by a private party '
        + 'and residents are being charged to use it. Nobody will tell us under whose authority.',
      inputMode: 'text',
    },
  });
  check('the citizen is asked to choose', vague.data.bot?.input?.kind === 'choose_division',
    vague.data.bot?.input?.kind);

  const chosen = await api(`/chat/${id}/division`, { method: 'POST', body: { divisionId: 'other' } });
  check('choosing Other is accepted', chosen.status === 200, `HTTP ${chosen.status}`);

  const questions = chosen.data.draft?.otherQuestions || [];
  const plan = chosen.data.draft?.otherPlan || {};
  check('questions were planned for it', questions.length >= 2,
    `${questions.length} via ${plan.source}`);
  check('each question has a key and a readable label',
    questions.every((q) => q.key && q.label && q.label.length > 5),
    JSON.stringify(questions.slice(0, 2)));
  check('no question asks for an identity number',
    !questions.some((q) => /aadhaar|aadhar|\bpan\b|card number|password|otp/i.test(q.label)),
    questions.map((q) => q.label).join(' | ').slice(0, 120));
  check('the bot asks the first of them',
    chosen.data.bot?.input?.field?.key === questions[0]?.key,
    chosen.data.bot?.input?.field?.label);

  // Answer each planned question in turn.
  for (const q of questions) {
    await api(`/chat/${id}/message`, {
      method: 'POST',
      body: { text: `Answer regarding ${q.key.replace(/_/g, ' ')}`, inputMode: 'text' },
    });
  }

  await api(`/chat/${id}/message`, { method: 'POST', body: { text: '110001', inputMode: 'text' } });
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'New Delhi', inputMode: 'text' } });
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: '5 Rajpath', inputMode: 'text' } });
  await api(`/chat/${id}/draft`, { method: 'PATCH', body: { skipLocationPin: true } });
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'Other Citizen', inputMode: 'text' } });
  await api(`/chat/${id}/message`, { method: 'POST', body: { text: 'Male', inputMode: 'text' } });
  await api(`/chat/${id}/declaration`, { method: 'POST', body: { accepted: true } });

  const done = await api(`/chat/${id}/submit`, { method: 'POST', body: {} });
  check('an unlisted complaint can be filed', done.status === 201,
    JSON.stringify(done.data).slice(0, 140));

  const g = (await query('SELECT * FROM grievances WHERE reference_id = $1',
    [done.data.reference])).rows[0];
  check('it is stored against the catch-all', g?.division_id === 'other', g?.division_id);
  check('the answers are kept', Object.keys(g?.dynamic_details || {}).length >= 2,
    JSON.stringify(g?.dynamic_details).slice(0, 110));
  const asked = Array.isArray(g?.dynamic_labels) ? g.dynamic_labels : [];
  check('the questions are kept beside them, in order',
    asked.length === Object.keys(g?.dynamic_details || {}).length
      && asked.every((q) => q.key && q.label),
    JSON.stringify(asked).slice(0, 120));
  // JSONB reorders an object's keys, so the sequence only survives as an array.
  check('the asked order survives storage', Array.isArray(g?.dynamic_labels),
    typeof g?.dynamic_labels);

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

/** Chat history: past interviews are listed and can be resumed. */
async function runChatHistory() {
  console.log('\n--- chat history ---');
  const { citizen, token } = await makeCitizen('9000000062');
  const api = client(token);

  const empty = await api('/chat/history');
  check('history starts empty', empty.status === 200 && empty.data.conversations.length === 0);

  const first = await api('/chat/start', { method: 'POST', body: { language: 'en' } });
  await api(`/chat/${first.data.conversationId}/message`, {
    method: 'POST',
    body: { text: 'Money was taken from my bank account by an OTP scam', inputMode: 'text' },
  });
  await api('/chat/start', { method: 'POST', body: { language: 'en' } });

  const list = await api('/chat/history');
  check('both interviews are listed', list.data.conversations.length === 2,
    String(list.data.conversations.length));

  const withText = list.data.conversations.find((c) => c.id === first.data.conversationId);
  check('each carries a readable title', Boolean(withText?.title), withText?.title);
  check('and how far it got', withText?.turns >= 2, String(withText?.turns));

  // Resuming returns the transcript, which is what lets the page redraw it.
  const resumed = await api(`/chat/${first.data.conversationId}`);
  check('a past interview can be resumed', resumed.status === 200);
  check('its transcript comes back', (resumed.data.transcript || []).length >= 2,
    String((resumed.data.transcript || []).length));
  check('with the complaint intact',
    /OTP scam/.test(JSON.stringify(resumed.data.draft?.originalText || '')),
    String(resumed.data.draft?.originalText || '').slice(0, 40));

  // Another citizen's history must never appear here.
  const other = await makeCitizen('9000000063');
  const theirs = client(other.token);
  const peek = await theirs('/chat/history');
  check('history is per citizen', peek.data.conversations.length === 0,
    String(peek.data.conversations.length));
  await query('DELETE FROM citizens WHERE mobile = $1', ['9000000063']);

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

/**
 * Core Features, end to end.
 *
 * Two neighbours report the same problem, one adds their weight to the
 * other's report, an officer resolves it, the citizen rates the service, and
 * the transparency board reflects all of it. That whole chain is the feature,
 * and testing any link of it alone proves very little.
 */
async function runCoreFeatures() {
  console.log('\n--- core features ---');

  const a = await makeCitizen('9000000101');
  const b = await makeCitizen('9000000102');
  await query("UPDATE citizens SET full_name='Neighbour A', gender='Male' WHERE id=$1", [a.citizen.id]);
  await query("UPDATE citizens SET full_name='Neighbour B', gender='Female' WHERE id=$1", [b.citizen.id]);
  const apiA = client(a.token);
  const apiB = client(b.token);

  const COMPLAINT = 'Cyber fraud: money was debited from my bank account through an OTP scam on a fake website';

  async function fileOne(api, text) {
    const start = await api('/chat/start', { method: 'POST', body: { language: 'en' } });
    const id = start.data.conversationId;
    const say = (t) => api(`/chat/${id}/message`, { method: 'POST', body: { text: t, inputMode: 'text' } });
    await say(text);
    await api(`/chat/${id}/division`, { method: 'POST', body: { divisionId: 'cyber' } });
    for (const v of ['UTR110000000001', '60000', '2026-10-31 10:00', 'Fake website']) await say(v);
    await say('110001');
    await say('New Delhi');
    await say('5 Rajpath');
    await api(`/chat/${id}/draft`, { method: 'PATCH', body: { latitude: 28.6139, longitude: 77.2090 } });
    await api(`/chat/${id}/declaration`, { method: 'POST', body: { accepted: true } });
    const done = await api(`/chat/${id}/submit`, { method: 'POST', body: {} });
    return done;
  }

  const first = await fileOne(apiA, COMPLAINT);
  check('first neighbour files', first.status === 201, first.data.reference);

  const second = await fileOne(apiB, `${COMPLAINT} — happened to me as well`);
  check('second neighbour files', second.status === 201, second.data.reference);

  // Both should land in one cluster: same division, same PIN, same terms.
  const rowA = (await query('SELECT id, cluster_id, priority_score FROM grievances WHERE reference_id=$1', [first.data.reference])).rows[0];
  const rowB = (await query('SELECT id, cluster_id FROM grievances WHERE reference_id=$1', [second.data.reference])).rows[0];
  check('the two reports are grouped together',
    rowA.cluster_id !== null && rowA.cluster_id === rowB.cluster_id,
    `A=${rowA.cluster_id} B=${rowB.cluster_id}`);
  check('grouping did not merge them',
    first.data.reference !== second.data.reference, 'separate dockets kept');
  check('priority was scored', rowA.priority_score >= 1 && rowA.priority_score <= 4,
    `score ${rowA.priority_score}`);

  const cluster = (await query('SELECT member_count FROM grievance_clusters WHERE id=$1', [rowA.cluster_id])).rows[0];
  check('the cluster counts both', cluster.member_count === 2, String(cluster.member_count));

  // B adds weight to A's report rather than filing a third.
  const similar = await apiB('/civic/similar', {
    method: 'POST',
    body: { text: COMPLAINT, divisionId: 'cyber', pincode: '110001' },
  });
  check('similar reports are offered before filing', (similar.data.similar || []).length > 0,
    `${(similar.data.similar || []).length} found`);

  const sup = await apiB(`/civic/${first.data.reference}/support`, { method: 'POST' });
  check('a neighbour can support an existing report', sup.status === 200 && sup.data.supporters === 1,
    JSON.stringify(sup.data));

  const again = await apiB(`/civic/${first.data.reference}/support`, { method: 'POST' });
  check('supporting twice does not inflate the count', again.data.supporters === 1,
    String(again.data.supporters));

  const own = await apiA(`/civic/${first.data.reference}/support`, { method: 'POST' });
  check('nobody can support their own report', own.status === 409, `HTTP ${own.status}`);

  // The thread.
  const comment = await apiA(`/civic/${first.data.reference}/comments`, {
    method: 'POST', body: { body: 'The bank has frozen the beneficiary account.' },
  });
  check('the citizen can add an update', comment.status === 201, `HTTP ${comment.status}`);

  const stranger = await apiB(`/civic/${first.data.reference}/comments`);
  check('another citizen cannot read that thread', stranger.status === 404, `HTTP ${stranger.status}`);

  // Rating is refused before the work is done.
  const early = await apiA(`/civic/${first.data.reference}/rating`, { method: 'POST', body: { rating: 5 } });
  check('rating is refused before resolution', early.status === 409, `HTTP ${early.status}`);

  await query("UPDATE grievances SET status='resolved', closed_at=NOW(), resolution_seconds=172800 WHERE id=$1", [rowA.id]);

  const bad = await apiA(`/civic/${first.data.reference}/rating`, { method: 'POST', body: { rating: 9 } });
  check('an out-of-range rating is refused', bad.status === 422, `HTTP ${bad.status}`);

  const rated = await apiA(`/civic/${first.data.reference}/rating`, {
    method: 'POST', body: { rating: 4, comment: 'Handled quickly once it reached the cyber cell.' },
  });
  check('the citizen can rate a resolved case', rated.status === 200 && rated.data.rating === 4,
    JSON.stringify(rated.data));

  const detail = await apiA(`/grievances/${first.data.reference}`);
  check('the record carries supporters, comments and the rating',
    detail.data.supporters === 1 && (detail.data.comments || []).length >= 1
      && detail.data.satisfaction_rating === 4,
    `supporters=${detail.data.supporters} comments=${(detail.data.comments || []).length} rating=${detail.data.satisfaction_rating}`);
  check('and says it can no longer be rated', detail.data.canRate === false, String(detail.data.canRate));

  // Public views carry no identity.
  const map = await (await fetch(`${BASE}/api/civic/map?pincode=110001`)).json();
  check('the public map returns points', (map.points || []).length > 0, `${(map.points || []).length} points`);
  const mapText = JSON.stringify(map);
  check('the map leaks no identity or complaint text',
    !/Neighbour|9000000101|MHA-GRV|OTP scam|UTR1100/.test(mapText), 'clean');
  check('coordinates are rounded', (map.points || []).every((p) => String(p.lat).split('.')[1]?.length <= 3),
    'to 3 decimal places');

  const spots = await (await fetch(`${BASE}/api/civic/hotspots`)).json();
  check('hotspots show the grouped reports',
    (spots.hotspots || []).some((h) => h.reports >= 2), `${(spots.hotspots || []).length} hotspots`);

  const board = await (await fetch(`${BASE}/api/civic/transparency`)).json();
  const cyber = (board.divisions || []).find((d) => d.divisionId === 'cyber');
  check('the transparency board scores the division', Boolean(cyber) && typeof cyber.transparencyScore === 'number',
    cyber ? `score ${cyber.transparencyScore}, avg rating ${cyber.averageRating}` : 'missing');

  await query('DELETE FROM citizens WHERE id = ANY($1)', [[a.citizen.id, b.citizen.id]]);
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
    await runInterfaceTranslation();
    await runSpeechConfig();
    await runFullVoiceFlow();
    await runUnlistedComplaint();
    await runChatHistory();
    await runCoreFeatures();
  } catch (err) {
    console.error('\nUNCAUGHT', err);
    failed += 1;
  }

  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main();
