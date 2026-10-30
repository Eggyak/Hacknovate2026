/**
 * MHA Samadhan - citizen portal.
 *
 * Every number, name and status on screen comes from the API. There is no
 * placeholder copy and no sample docket: an empty account renders an empty
 * state, because a government portal that shows an invented grievance to a
 * citizen who has filed none is lying to them.
 *
 * Speech recognition runs in this file against the Azure SDK, using a token
 * fetched from our own server. Synthesis is proxied through the server.
 */

const api = {
  async call(path, { method = 'GET', body, form } = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (form) {
      init.body = form;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(`/api${path}`, init);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();

    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.error;
      err.errors = data && data.errors;
      err.retryAfter = data && data.retryAfter;
      throw err;
    }
    return data;
  },
  get(p) { return this.call(p); },
  post(p, body) { return this.call(p, { method: 'POST', body }); },
  patch(p, body) { return this.call(p, { method: 'PATCH', body }); },
  upload(p, form) { return this.call(p, { method: 'POST', form }); },
};

const state = {
  citizen: null,
  languages: [],
  divisions: [],
  health: null,
  conversation: null,
  lastPipeline: null,
  lidCandidates: [],
};

/* ---------- small helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function langOf(code) {
  return state.languages.find((l) => l.code === code) || null;
}

function statusBadge(status) {
  const map = {
    submitted: ['pending', 'Submitted'],
    under_review: ['pending', 'Under review'],
    in_progress: ['pending', 'In progress'],
    resolved: ['ok', 'Resolved'],
    closed: ['ok', 'Closed'],
    rejected: ['urgent', 'Rejected'],
  };
  const [cls, label] = map[status] || ['neutral', status];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function toast(message, kind = 'info') {
  let host = $('#toast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast';
    host.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:90;max-width:min(520px,92vw)';
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `notice ${kind}`;
  el.style.cssText = 'box-shadow:var(--shadow-3);background:#fff;margin-top:8px';
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), 5200);
}

/* ---------- speech ---------- */

const speech = {
  recognizer: null,
  recording: false,

  available() {
    return Boolean(window.SpeechSDK) && Boolean(state.health?.capabilities?.speech);
  },

  /**
   * Start continuous recognition with automatic language identification.
   *
   * Azure evaluates at most ten candidate locales at a time. The server picks
   * which ten from the fourteen we support, using the citizen's chosen
   * language and the languages spoken where their PIN code is - so this is a
   * real fourteen-language system that is honest about its per-utterance
   * window rather than one that quietly only hears Hindi and English.
   */
  async start({ onPartial, onFinal, onError }) {
    if (!window.SpeechSDK) throw new Error('Speech SDK did not load.');

    const { token, region, candidates } = await api.get(
      `/speech/token${state.conversation ? `?conversationId=${state.conversation.conversationId}` : ''}`,
    );
    state.lidCandidates = candidates;

    const SDK = window.SpeechSDK;
    const cfg = SDK.SpeechConfig.fromAuthorizationToken(token, region);
    cfg.setProperty(SDK.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');

    const auto = SDK.AutoDetectSourceLanguageConfig.fromLanguages(candidates);
    const audio = SDK.AudioConfig.fromDefaultMicrophoneInput();
    const rec = SDK.SpeechRecognizer.FromConfig(cfg, auto, audio);

    rec.recognizing = (_s, e) => {
      if (e.result.text) onPartial(e.result.text);
    };

    rec.recognized = (_s, e) => {
      if (e.result.reason !== SDK.ResultReason.RecognizedSpeech || !e.result.text) return;
      const detected = SDK.AutoDetectSourceLanguageResult.fromResult(e.result);
      onFinal({
        text: e.result.text,
        locale: detected?.language || null,
        candidates,
      });
    };

    rec.canceled = (_s, e) => {
      this.stop();
      onError(new Error(e.errorDetails || 'Recognition was cancelled.'));
    };

    this.recognizer = rec;
    this.recording = true;
    await new Promise((resolve, reject) => rec.startContinuousRecognitionAsync(resolve, reject));
  },

  stop() {
    this.recording = false;
    const rec = this.recognizer;
    this.recognizer = null;
    if (rec) {
      try {
        rec.stopContinuousRecognitionAsync(() => rec.close(), () => rec.close());
      } catch { /* already torn down */ }
    }
  },

  /** Speak a bot line. Server-side so the key stays server-side. */
  async say(text, language) {
    if (!state.health?.capabilities?.speech || !text) return;
    try {
      const res = await fetch('/api/speech/speak', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language }),
      });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.addEventListener('ended', () => URL.revokeObjectURL(url));
      await audio.play().catch(() => URL.revokeObjectURL(url));
    } catch { /* speaking is an enhancement, never a blocker */ }
  },
};

/* ---------- chrome ---------- */

function renderChrome() {
  const nav = $('#nav');
  const right = $('#headerRight');

  if (!state.citizen) {
    nav.hidden = true;
    right.innerHTML = '';
    return;
  }

  nav.hidden = false;
  const here = location.hash || '#/';
  const items = [
    ['#/', 'Dashboard'],
    ['#/new', 'Register'],
    ['#/grievances', 'My grievances'],
    ['#/track', 'Track'],
  ];
  nav.innerHTML = items
    .map(([href, label]) => `<a href="${href}" class="${here === href ? 'on' : ''}">${label}</a>`)
    .join('');

  right.innerHTML = `
    <a class="btn quiet" href="#/profile" title="Profile">${esc(state.citizen.full_name || `+91 ${state.citizen.mobile}`)}</a>
    <button class="btn quiet" id="signout">Sign out</button>`;

  $('#signout').onclick = async () => {
    await api.post('/auth/signout');
    state.citizen = null;
    location.hash = '#/signin';
    renderChrome();
  };
}

function renderCapabilities() {
  const bar = $('#capBar');
  if (!state.health) return;
  const c = state.health.capabilities;
  const bits = [
    `${state.health.counts.languages} languages`,
    c.speech ? 'voice on' : 'voice unavailable',
    c.translation ? 'translation on' : 'translation off',
  ];
  bar.textContent = bits.join(' · ');
  $('#slaDays').textContent = state.health.sla.days;
}

/* ---------- views ---------- */

const view = $('#view');

function setView(html) {
  view.innerHTML = html;
  window.scrollTo(0, 0);
}

/** Sign in / sign up. One flow: the number proves itself, then we know which. */
function viewSignIn() {
  setView(`
    <div style="max-width:440px;margin:40px auto">
      <div class="card pad-lg">
        <h1 style="font-size:24px">Sign in</h1>
        <p class="muted small mt-2 mb-4">
          Enter your mobile number. We will send a one-time code — there is no password.
        </p>

        <form id="startForm" novalidate>
          <div class="field">
            <label for="mobile">Mobile number</label>
            <div class="phone-row">
              <span class="cc">+91</span>
              <input id="mobile" type="tel" inputmode="numeric" autocomplete="tel-national"
                     maxlength="10" placeholder="10-digit number" required>
            </div>
            <div class="err hidden" id="mobileErr"></div>
          </div>
          <button class="btn primary block" type="submit" id="sendBtn">Send code</button>
        </form>

        <form id="codeForm" class="hidden" novalidate>
          <p class="small mb-3">Code sent to <b id="maskedNum"></b>.
            <button type="button" class="btn quiet" id="changeNum" style="min-height:auto;padding:0 4px">Change</button>
          </p>
          <div class="field">
            <label class="sr" for="d0">One-time code</label>
            <div class="otp" id="otpBoxes"></div>
            <div class="err hidden center mt-3" id="codeErr"></div>
          </div>
          <button class="btn primary block" type="submit" id="verifyBtn">Verify and continue</button>
          <div class="center mt-3">
            <button type="button" class="btn quiet" id="resendBtn" disabled>Resend code</button>
          </div>
        </form>
      </div>
      <p class="center small muted mt-4">Your number is used only to verify you and to send updates.</p>
    </div>`);

  let mobile = '';
  const startForm = $('#startForm');
  const codeForm = $('#codeForm');

  startForm.onsubmit = async (e) => {
    e.preventDefault();
    const input = $('#mobile');
    const err = $('#mobileErr');
    const value = input.value.replace(/\D/g, '');

    if (!/^[6-9]\d{9}$/.test(value)) {
      err.textContent = 'Enter a valid 10-digit Indian mobile number.';
      err.classList.remove('hidden');
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    err.classList.add('hidden');
    input.removeAttribute('aria-invalid');

    const btn = $('#sendBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Sending';

    try {
      const r = await api.post('/auth/start', { mobile: value });
      mobile = value;
      $('#maskedNum').textContent = r.mobile;
      startForm.classList.add('hidden');
      codeForm.classList.remove('hidden');
      buildOtpBoxes();
      startResendTimer(r.ttlSeconds);

      if (!r.delivered) {
        toast(
          r.devCode
            ? `SMS delivery is not connected yet. Your code is ${r.devCode}.`
            : 'The code could not be sent by SMS. Check the delivery service.',
          r.devCode ? 'warn' : 'bad',
        );
        if (r.devCode) fillOtp(r.devCode);
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send code';
    }
  };

  function buildOtpBoxes() {
    const host = $('#otpBoxes');
    host.innerHTML = Array.from({ length: 6 }, (_, i) =>
      `<input id="d${i}" type="text" inputmode="numeric" maxlength="1" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" aria-label="Digit ${i + 1}">`).join('');

    const boxes = $$('#otpBoxes input');
    boxes.forEach((box, i) => {
      box.oninput = () => {
        box.value = box.value.replace(/\D/g, '');
        if (box.value && i < 5) boxes[i + 1].focus();
        if (boxes.every((b) => b.value)) codeForm.requestSubmit();
      };
      box.onkeydown = (ev) => {
        if (ev.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      };
      box.onpaste = (ev) => {
        ev.preventDefault();
        fillOtp((ev.clipboardData.getData('text') || '').replace(/\D/g, ''));
      };
    });
    boxes[0].focus();
  }

  function fillOtp(digits) {
    const boxes = $$('#otpBoxes input');
    [...digits.slice(0, 6)].forEach((d, i) => { boxes[i].value = d; });
    if (digits.length >= 6) codeForm.requestSubmit();
  }

  let timer = null;
  function startResendTimer(seconds) {
    const btn = $('#resendBtn');
    let left = Math.min(seconds || 60, 60);
    clearInterval(timer);
    const tick = () => {
      btn.disabled = left > 0;
      btn.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code';
      left -= 1;
      if (left < -1) clearInterval(timer);
    };
    tick();
    timer = setInterval(tick, 1000);
    btn.onclick = () => startForm.requestSubmit();
  }

  $('#changeNum').onclick = () => {
    clearInterval(timer);
    codeForm.classList.add('hidden');
    startForm.classList.remove('hidden');
    $('#mobile').focus();
  };

  codeForm.onsubmit = async (e) => {
    e.preventDefault();
    const code = $$('#otpBoxes input').map((b) => b.value).join('');
    const err = $('#codeErr');
    if (code.length !== 6) return;

    const btn = $('#verifyBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Verifying';
    err.classList.add('hidden');

    try {
      const r = await api.post('/auth/verify', { mobile, code });
      state.citizen = r.citizen;
      clearInterval(timer);
      renderChrome();
      location.hash = r.profileComplete ? '#/' : '#/profile';
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
      $$('#otpBoxes input').forEach((b) => { b.value = ''; });
      $('#d0').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify and continue';
    }
  };
}

/** Dashboard. Counters are computed from this citizen's own records. */
async function viewDashboard() {
  setView('<div class="center" style="padding:60px 0"><span class="spin dark"></span></div>');

  const [stats, list] = await Promise.all([
    api.get('/grievances/stats'),
    api.get('/grievances?limit=5'),
  ]);

  const recent = list.grievances;

  setView(`
    <div class="row between wrap mb-4">
      <div>
        <h1>${state.citizen.full_name ? `Welcome, ${esc(state.citizen.full_name)}` : 'Your grievances'}</h1>
        <p class="muted small" style="margin:0">Speak or type in any of ${state.health.counts.languages} languages.</p>
      </div>
      <a class="btn primary" href="#/new">Register a grievance</a>
    </div>

    <div class="grid c4 mb-4">
      <div class="stat"><div class="n tnum">${stats.total}</div><div class="k">Filed</div></div>
      <div class="stat"><div class="n tnum">${stats.active}</div><div class="k">Active</div></div>
      <div class="stat"><div class="n tnum">${stats.resolved}</div><div class="k">Resolved</div></div>
      <div class="stat"><div class="n tnum" style="color:${stats.breached ? 'var(--danger)' : 'inherit'}">${stats.breached}</div><div class="k">Past due</div></div>
    </div>

    <div class="card">
      <div class="row between mb-3">
        <h2>Recent</h2>
        ${recent.length ? '<a class="small" href="#/grievances">View all</a>' : ''}
      </div>
      ${recent.length === 0 ? `
        <div class="center" style="padding:36px 0">
          <p class="muted">You have not filed any grievance yet.</p>
          <a class="btn primary mt-2" href="#/new">Register your first grievance</a>
        </div>` : `
        <table class="data">
          <thead><tr><th>Docket</th><th>Department</th><th>Status</th><th>Due</th></tr></thead>
          <tbody>
            ${recent.map((g) => `
              <tr class="row" data-ref="${esc(g.reference_id)}">
                <td><span class="ref">${esc(g.reference_id)}</span></td>
                <td>${esc(g.division?.name || '—')}</td>
                <td>${statusBadge(g.status)}</td>
                <td class="num small ${g.sla.breached ? '' : 'muted'}" ${g.sla.breached ? 'style="color:var(--danger);font-weight:700"' : ''}>
                  ${g.sla.breached ? 'Overdue' : `${g.sla.daysLeft}d`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>`);

  $$('tr.row').forEach((tr) => {
    tr.onclick = () => { location.hash = `#/g/${tr.dataset.ref}`; };
  });
}

/* ---------- the interview ---------- */

async function viewChat() {
  setView(`
    <div class="row between wrap mb-4">
      <div>
        <h1>Register a grievance</h1>
        <p class="muted small" style="margin:0">Describe what happened in your own words.</p>
      </div>
      <div id="langPick"></div>
    </div>

    <div class="grid" style="grid-template-columns:minmax(0,1.65fr) minmax(0,1fr)">
      <div class="card" style="padding:0;overflow:hidden">
        <div class="chat">
          <div class="stream" id="stream"></div>
          <div class="chips" id="chips"></div>
          <form class="composer" id="composer">
            <textarea id="say" rows="1" placeholder="Type here, or press the microphone"
                      aria-label="Your message"></textarea>
            <button type="button" class="mic" id="mic" title="Speak" aria-label="Speak">&#127908;</button>
            <button type="submit" class="btn primary" id="send" style="min-height:52px">Send</button>
          </form>
        </div>
      </div>

      <div>
        <div class="card mb-4" id="progressCard"></div>
        <div class="card" id="traceCard">
          <h3 class="mb-3">How this was understood</h3>
          <p class="muted small" style="margin:0">The language check and routing run as you speak. Their results appear here.</p>
        </div>
      </div>
    </div>`);

  renderLanguagePicker();

  const start = await api.post('/chat/start', { language: state.citizen.preferred_language || 'en' });
  state.conversation = start;
  pushBot(start.bot.text, start.language);
  renderAffordance(start);
  renderProgress(start);

  $('#composer').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#say').value.trim();
    if (text) sendMessage(text, 'text');
  };

  const say = $('#say');
  say.oninput = () => {
    say.style.height = 'auto';
    say.style.height = `${Math.min(say.scrollHeight, 120)}px`;
  };
  say.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  };

  wireMic();
}

function renderLanguagePicker() {
  const host = $('#langPick');
  if (!host) return;
  const current = state.conversation?.language || state.citizen?.preferred_language || 'en';
  host.innerHTML = `
    <label class="sr" for="langSel">Language</label>
    <select id="langSel" style="min-width:160px">
      ${state.languages.map((l) =>
        `<option value="${l.code}" ${l.code === current ? 'selected' : ''}>${esc(l.native)} · ${esc(l.name)}</option>`).join('')}
    </select>`;

  $('#langSel').onchange = async (e) => {
    const code = e.target.value;
    await api.patch('/auth/profile', { preferredLanguage: code });
    state.citizen.preferred_language = code;
    const lang = langOf(code);
    $('#stream').setAttribute('dir', lang?.dir || 'ltr');
    toast(`Switched to ${lang?.name}. The bot will reply in this language.`);
  };
}

function pushBot(text, language) {
  if (!text) return;
  const lang = langOf(language);
  const el = document.createElement('div');
  el.className = 'msg bot';
  el.setAttribute('dir', lang?.dir || 'ltr');
  el.innerHTML = `${esc(text)}${state.health?.capabilities?.speech
    ? '<button class="play" type="button">&#9654; Listen</button>' : ''}`;

  const play = el.querySelector('.play');
  if (play) play.onclick = () => speech.say(text, language);

  $('#stream').append(el);
  $('#stream').scrollTop = $('#stream').scrollHeight;
}

function pushMe(text, meta) {
  const el = document.createElement('div');
  el.className = 'msg me';
  el.innerHTML = `${esc(text)}${meta ? `<span class="meta">${esc(meta)}</span>` : ''}`;
  $('#stream').append(el);
  $('#stream').scrollTop = $('#stream').scrollHeight;
}

async function sendMessage(text, inputMode, spoken) {
  const id = state.conversation.conversationId;
  pushMe(text, spoken?.locale ? `Heard as ${langOf(String(spoken.locale).split('-')[0])?.name || spoken.locale}` : null);
  $('#say').value = '';
  $('#say').style.height = 'auto';
  $('#send').disabled = true;

  try {
    const r = await api.post(`/chat/${id}/message`, { text, inputMode, spoken });
    state.conversation = r;
    state.lastPipeline = r.pipeline;

    pushBot(r.bot.text, r.language);
    if (inputMode === 'voice') speech.say(r.bot.text, r.language);

    renderAffordance(r);
    renderProgress(r);
    renderTrace(r.pipeline);

    if (r.step === 'done') await finishUp();
  } catch (ex) {
    toast(ex.message, 'bad');
  } finally {
    $('#send').disabled = false;
  }
}

/** The structured control that belongs with the bot's current question. */
function renderAffordance(r) {
  const chips = $('#chips');
  chips.innerHTML = '';
  const kind = r.bot.input?.kind;

  if (kind === 'confirm_division') {
    const d = state.divisions.find((x) => x.id === r.bot.input.divisionId);
    chips.innerHTML = `
      <button class="chip on" data-yes>Yes, ${esc(d?.name || 'correct')}</button>
      <button class="chip" data-no>No, choose another</button>`;
    chips.querySelector('[data-yes]').onclick = () => chooseDivision(r.bot.input.divisionId);
    chips.querySelector('[data-no]').onclick = () => renderDivisionList([]);
    return;
  }

  if (kind === 'choose_division') {
    renderDivisionList(r.bot.input.suggestions || []);
    return;
  }

  if (kind === 'gender') {
    chips.innerHTML = r.bot.input.options
      .map((o) => `<button class="chip" data-g="${esc(o)}">${esc(o)}</button>`).join('');
    $$('[data-g]', chips).forEach((b) => { b.onclick = () => sendMessage(b.dataset.g, 'text'); });
    return;
  }

  if (kind === 'field' && r.bot.input.field?.type === 'select') {
    chips.innerHTML = r.bot.input.field.options
      .map((o) => `<button class="chip" data-v="${esc(o)}">${esc(o)}</button>`).join('');
    $$('[data-v]', chips).forEach((b) => { b.onclick = () => sendMessage(b.dataset.v, 'text'); });
    return;
  }

  if (kind === 'pincode') {
    chips.innerHTML = '<button class="chip" id="useGps">Use my location</button>';
    $('#useGps').onclick = useGps;
    return;
  }

  if (kind === 'declaration') {
    chips.innerHTML = `
      <button class="chip on" data-dec="1">I declare this is true</button>
      <button class="chip" data-dec="0">Not yet</button>`;
    $$('[data-dec]', chips).forEach((b) => {
      b.onclick = async () => {
        const r2 = await api.post(`/chat/${state.conversation.conversationId}/declaration`, {
          accepted: b.dataset.dec === '1',
        });
        state.conversation = r2;
        if (b.dataset.dec === '1') await finishUp();
        else pushBot(r2.bot.text, r2.language);
        renderProgress(r2);
      };
    });
  }
}

function renderDivisionList(suggested) {
  const chips = $('#chips');
  const order = [
    ...suggested.map((id) => state.divisions.find((d) => d.id === id)).filter(Boolean),
    ...state.divisions.filter((d) => !suggested.includes(d.id)),
  ];
  chips.innerHTML = order
    .map((d) => `<button class="chip" data-d="${esc(d.id)}" title="${esc(d.blurb)}">${esc(d.name)}</button>`)
    .join('');
  $$('[data-d]', chips).forEach((b) => { b.onclick = () => chooseDivision(b.dataset.d); });
}

async function chooseDivision(divisionId) {
  const r = await api.post(`/chat/${state.conversation.conversationId}/division`, { divisionId });
  state.conversation = r;
  pushBot(r.bot.text, r.language);
  renderAffordance(r);
  renderProgress(r);
  if (r.step === 'done') await finishUp();
}

function useGps() {
  if (!navigator.geolocation) return toast('This browser cannot share a location.', 'warn');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      await api.patch(`/chat/${state.conversation.conversationId}/draft`, {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      toast('Location pinned. Please still type your PIN code.');
    },
    () => toast('Location was not shared.', 'warn'),
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

/** Progress through the required fields, derived from the live draft. */
function renderProgress(r) {
  const host = $('#progressCard');
  if (!host) return;
  const d = r.draft || {};
  const division = r.division;

  const items = [
    ['Complaint', Boolean(d.originalText)],
    ['Department', Boolean(d.divisionId && d.confirmedDivision)],
    ['Required details', Boolean(division) && (division.fields || [])
      .filter((f) => f.required).every((f) => String(d.details?.[f.key] ?? '').trim())],
    ['Location', Boolean(d.pincode && d.address)],
    ['Declaration', d.declarationTruth === true],
  ];

  host.innerHTML = `
    <h3 class="mb-3">Progress</h3>
    <ul class="timeline">
      ${items.map(([label, done], i) => `
        <li class="${done ? 'done' : (items.findIndex(([, x]) => !x) === i ? 'now' : '')}">
          <b class="small">${esc(label)}</b>
        </li>`).join('')}
    </ul>
    ${division ? `<div class="notice info mt-3"><span>Routing to <b>${esc(division.name)}</b></span></div>` : ''}
    ${d.language ? `<p class="small muted mt-3" style="margin:0">Language: <b>${esc(langOf(d.language.code)?.native || d.language.code)}</b></p>` : ''}
    <div class="mt-3">
      <label class="btn ghost block" style="cursor:pointer">
        Attach evidence
        <input type="file" id="evi" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" hidden>
      </label>
      <p class="small muted mt-2" style="margin:0" id="eviList">
        ${(d.attachments || []).length} file(s) attached
      </p>
    </div>`;

  $('#evi').onchange = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    try {
      const res = await api.upload(`/grievances/conversation/${r.conversationId}/evidence`, form);
      $('#eviList').textContent = `${res.count} file(s) attached`;
      toast('Evidence attached.', 'good');
    } catch (ex) {
      toast(ex.message, 'bad');
    }
  };
}

/**
 * The pipeline trace.
 *
 * This is the panel that answers "is the NLP real?". It names the component
 * that ran, the decision it reached, and the evidence behind it - including
 * when a stage was skipped and why.
 */
function renderTrace(pipeline) {
  const host = $('#traceCard');
  if (!host || !pipeline?.steps?.length) return;

  host.innerHTML = `<h3 class="mb-3">How this was understood</h3>
    <div class="trace">${pipeline.steps.map((s) => {
      const d = s.detail || {};
      let body = '';

      if (s.stage === 'language-identification') {
        const lang = langOf(d.code) || langOf(String(d.locale || '').split('-')[0]);
        body = `<div class="ev">Identified <b>${esc(lang?.name || d.code || d.locale || 'unknown')}</b>
          at ${Math.round((d.confidence || 0) * 100)}% confidence.</div>
          ${(d.evidence || []).map((e) => `<div class="ev">· ${esc(e)}</div>`).join('')}
          ${d.candidatesEvaluated?.length ? `<div class="ev">· evaluated ${d.candidatesEvaluated.length} candidate locales</div>` : ''}`;
      } else if (s.stage === 'translation') {
        body = d.produced
          ? '<div class="ev">English rendering produced.</div>'
          : `<div class="ev">Skipped — <code>${esc(d.reason || 'unavailable')}</code>. Routing ran on the original text.</div>`;
      } else if (s.stage === 'classification') {
        const div = state.divisions.find((x) => x.id === d.divisionId);
        body = `<div class="ev">${d.divisionId
          ? `Routed to <b>${esc(div?.name || d.divisionId)}</b> at ${Math.round((d.confidence || 0) * 100)}% confidence.`
          : 'No department matched — the citizen was asked to choose.'}</div>
          ${(d.matched || []).length ? `<div class="ev">· matched ${d.matched.map((m) => `<code>${esc(m.term)}</code>`).join(' ')}</div>` : ''}
          ${d.urgent ? '<div class="ev"><span class="badge urgent">urgent terms detected</span></div>' : ''}`;
      } else if (s.stage === 'location-resolution') {
        body = `<div class="ev">PIN ${esc(d.pincode)} resolved to <b>${esc(d.state || 'unknown')}</b>.</div>`;
      }

      const skipped = s.stage === 'translation' && !d.produced;
      return `<div class="stage ${skipped ? 'skipped' : ''}">
        <div class="name">${esc(s.stage.replace(/-/g, ' '))}</div>
        <div class="prov">${esc(s.provider)}</div>
        ${body}
      </div>`;
    }).join('')}</div>`;
}

/** Everything is collected: submit and show the docket. */
async function finishUp() {
  try {
    const r = await api.post(`/chat/${state.conversation.conversationId}/submit`, {});
    speech.say(r.spoken, state.conversation.language);

    setView(`
      <div style="max-width:620px;margin:32px auto">
        <div class="card pad-lg center">
          <div class="badge ok" style="font-size:13px">Registered</div>
          <h1 class="mt-3">Your grievance is filed</h1>
          <p class="muted">Keep this docket number. You can track it any time.</p>
          <p style="font-size:26px;font-weight:800" class="tnum mt-3">${esc(r.reference)}</p>
          <div class="notice info mt-4" style="text-align:start">
            <span>Routed to <b>${esc(r.division.name)}</b>. A reply is due by
            <b>${fmtDate(r.sla.deadline)}</b> — ${r.sla.days} days from today.</span>
          </div>
          <div class="row mt-4" style="justify-content:center">
            <a class="btn primary" href="#/g/${esc(r.reference)}">View grievance</a>
            <a class="btn ghost" href="#/new">File another</a>
          </div>
        </div>
      </div>`);
    state.conversation = null;
  } catch (ex) {
    toast(ex.message, 'bad');
  }
}

function wireMic() {
  const mic = $('#mic');
  if (!speech.available()) {
    mic.disabled = true;
    mic.title = state.health?.capabilities?.speech
      ? 'The speech library did not load.'
      : 'Voice input is not configured on this server.';
    return;
  }

  mic.onclick = async () => {
    if (speech.recording) {
      speech.stop();
      mic.classList.remove('rec');
      mic.title = 'Speak';
      return;
    }

    mic.classList.add('rec');
    mic.title = 'Stop';
    const say = $('#say');

    try {
      await speech.start({
        onPartial: (text) => { say.value = text; },
        onFinal: async ({ text, locale, candidates }) => {
          speech.stop();
          mic.classList.remove('rec');
          mic.classList.add('busy');
          say.value = '';
          await sendMessage(text, 'voice', { locale, candidates, confidence: 0.9 });
          mic.classList.remove('busy');
        },
        onError: (err) => {
          mic.classList.remove('rec', 'busy');
          toast(err.message, 'bad');
        },
      });
    } catch (ex) {
      mic.classList.remove('rec');
      toast(ex.message, 'bad');
    }
  };
}

/* ---------- list, detail, track, profile ---------- */

async function viewList() {
  setView('<div class="center" style="padding:60px 0"><span class="spin dark"></span></div>');
  const { grievances } = await api.get('/grievances');

  setView(`
    <div class="row between wrap mb-4">
      <h1>My grievances</h1>
      <a class="btn primary" href="#/new">Register a grievance</a>
    </div>
    ${grievances.length === 0 ? `
      <div class="card center" style="padding:48px">
        <p class="muted">Nothing filed yet.</p>
        <a class="btn primary mt-2" href="#/new">Register your first grievance</a>
      </div>` : `
      <div class="card">
        <table class="data">
          <thead><tr><th>Docket</th><th>Department</th><th>Filed</th><th>Status</th><th>SLA</th></tr></thead>
          <tbody>
            ${grievances.map((g) => `
              <tr class="row" data-ref="${esc(g.reference_id)}">
                <td><span class="ref">${esc(g.reference_id)}</span>
                  ${g.priority === 'high' ? '<span class="badge urgent mt-2">Urgent</span>' : ''}</td>
                <td>${esc(g.division?.name || '—')}</td>
                <td class="num small muted">${fmtDate(g.submitted_at)}</td>
                <td>${statusBadge(g.status)}</td>
                <td style="min-width:120px">
                  <div class="small ${g.sla.breached ? '' : 'muted'}" ${g.sla.breached ? 'style="color:var(--danger);font-weight:700"' : ''}>
                    ${g.sla.breached ? 'Overdue' : `${g.sla.daysLeft} days left`}
                  </div>
                  <div class="sla-bar ${g.sla.breached ? 'bad' : (g.sla.daysLeft <= 5 ? 'warn' : '')}">
                    <i style="width:${Math.max(0, Math.min(100, ((g.sla.days - g.sla.daysLeft) / g.sla.days) * 100))}%"></i>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}`);

  $$('tr.row').forEach((tr) => { tr.onclick = () => { location.hash = `#/g/${tr.dataset.ref}`; }; });
}

async function viewDetail(reference) {
  setView('<div class="center" style="padding:60px 0"><span class="spin dark"></span></div>');

  let g;
  try {
    g = await api.get(`/grievances/${encodeURIComponent(reference)}`);
  } catch {
    setView('<div class="card center" style="padding:48px"><p class="muted">That grievance was not found.</p><a class="btn ghost mt-2" href="#/grievances">Back</a></div>');
    return;
  }

  const details = Object.entries(g.dynamic_details || {});
  const fieldLabel = (key) => (g.division?.fields || []).find((f) => f.key === key)?.label || key;

  setView(`
    <a class="small muted" href="#/grievances">&larr; My grievances</a>
    <div class="row between wrap mt-3 mb-4">
      <div>
        <div class="row" style="gap:8px"><span class="ref">${esc(g.reference_id)}</span>${statusBadge(g.status)}
          ${g.priority === 'high' ? '<span class="badge urgent">Urgent</span>' : ''}</div>
        <h1 class="mt-2">${esc(g.division?.name || 'Grievance')}</h1>
      </div>
      <div class="center">
        <div class="small muted">Due</div>
        <div style="font-weight:800" class="tnum ${g.sla.breached ? '' : ''}"
             ${g.sla.breached ? 'style="color:var(--danger)"' : ''}>${fmtDate(g.sla_deadline)}</div>
        <div class="small ${g.sla.breached ? '' : 'muted'}" ${g.sla.breached ? 'style="color:var(--danger);font-weight:700"' : ''}>
          ${g.sla.breached ? 'Overdue' : `${g.sla.daysLeft} days left`}
        </div>
      </div>
    </div>

    <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
      <div>
        <div class="card mb-4">
          <h3 class="mb-3">Your complaint</h3>
          <p dir="${langOf(g.detected_language)?.dir || 'ltr'}" style="white-space:pre-wrap">${esc(g.original_text)}</p>
          ${g.translated_text ? `
            <details class="mt-3"><summary class="small muted" style="cursor:pointer">English rendering</summary>
              <p class="small mt-2" style="white-space:pre-wrap">${esc(g.translated_text)}</p>
              <p class="small muted">via ${esc(g.translation_provider || 'unknown')}</p>
            </details>` : `
            <p class="small muted mt-3">Filed in ${esc(langOf(g.detected_language)?.name || g.detected_language || 'an unrecorded language')}. No English rendering was produced.</p>`}
        </div>

        ${details.length ? `
          <div class="card mb-4">
            <h3 class="mb-3">Incident details</h3>
            <table class="data">
              <tbody>${details.map(([k, v]) => `
                <tr><td class="small muted" style="width:45%">${esc(fieldLabel(k))}</td>
                    <td class="small"><b>${esc(v)}</b></td></tr>`).join('')}
              </tbody>
            </table>
          </div>` : ''}

        ${g.attachments?.length ? `
          <div class="card">
            <h3 class="mb-3">Evidence</h3>
            ${g.attachments.map((a) => `
              <div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)">
                <span class="small">${esc(a.original_name)}</span>
                <a class="small" target="_blank" rel="noopener"
                   href="/api/grievances/${esc(g.reference_id)}/attachment/${a.id}">Open</a>
              </div>`).join('')}
          </div>` : ''}
      </div>

      <div>
        <div class="card mb-4">
          <h3 class="mb-3">Timeline</h3>
          <ul class="timeline">
            ${(g.events || []).map((e, i) => `
              <li class="${i === g.events.length - 1 ? 'now' : 'done'}">
                <b class="small">${esc(e.status.replace(/_/g, ' '))}</b>
                ${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}
                <div class="when">${fmtDateTime(e.created_at)}</div>
              </li>`).join('')}
          </ul>
        </div>

        <div class="card">
          <h3 class="mb-3">Filing</h3>
          <table class="data"><tbody>
            <tr><td class="small muted">Filed</td><td class="small">${fmtDateTime(g.submitted_at)}</td></tr>
            <tr><td class="small muted">Language</td><td class="small">${esc(langOf(g.detected_language)?.native || '—')}
              ${g.language_confidence ? `<span class="muted">(${Math.round(g.language_confidence * 100)}%)</span>` : ''}</td></tr>
            <tr><td class="small muted">Input</td><td class="small">${g.input_mode === 'voice' ? 'Voice' : 'Typed'}</td></tr>
            <tr><td class="small muted">Routing</td><td class="small">${esc(g.classification_method || '—')}
              ${g.classification_confidence ? `<span class="muted">(${Math.round(g.classification_confidence * 100)}%)</span>` : ''}</td></tr>
            ${g.state ? `<tr><td class="small muted">State</td><td class="small">${esc(g.state)}</td></tr>` : ''}
            ${g.pincode ? `<tr><td class="small muted">PIN</td><td class="small tnum">${esc(g.pincode)}</td></tr>` : ''}
          </tbody></table>
        </div>
      </div>
    </div>`);
}

function viewTrack() {
  setView(`
    <div style="max-width:560px;margin:24px auto">
      <h1 class="mb-3">Track a grievance</h1>
      <div class="card">
        <form id="trackForm">
          <div class="field">
            <label for="ref">Docket number</label>
            <input id="ref" type="text" placeholder="MHA-GRV-2026-000001" autocomplete="off" required>
            <div class="hint">Printed on your confirmation.</div>
          </div>
          <button class="btn primary block" type="submit">Track</button>
        </form>
      </div>
      <div id="trackOut" class="mt-4"></div>
    </div>`);

  $('#trackForm').onsubmit = async (e) => {
    e.preventDefault();
    const out = $('#trackOut');
    out.innerHTML = '<div class="center"><span class="spin dark"></span></div>';
    try {
      const g = await api.get(`/grievances/track/${encodeURIComponent($('#ref').value.trim())}`);
      out.innerHTML = `
        <div class="card">
          <div class="row between wrap mb-3">
            <span class="ref">${esc(g.reference_id)}</span>${statusBadge(g.status)}
          </div>
          <p class="small muted" style="margin:0">${esc(g.division?.name || '')}</p>
          <div class="notice ${g.sla.breached ? 'bad' : 'info'} mt-3">
            <span>${g.sla.breached ? 'Past the statutory deadline of' : 'Due by'} <b>${fmtDate(g.sla_deadline)}</b></span>
          </div>
          <ul class="timeline mt-4">
            ${g.events.map((e, i) => `
              <li class="${i === g.events.length - 1 ? 'now' : 'done'}">
                <b class="small">${esc(e.status.replace(/_/g, ' '))}</b>
                ${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}
                <div class="when">${fmtDateTime(e.created_at)}</div>
              </li>`).join('')}
          </ul>
        </div>`;
    } catch (ex) {
      out.innerHTML = `<div class="notice bad">${esc(ex.message)}</div>`;
    }
  };
}

function viewProfile() {
  const c = state.citizen;
  setView(`
    <div style="max-width:560px;margin:24px auto">
      <h1 class="mb-3">${c.full_name ? 'Your profile' : 'Complete your profile'}</h1>
      ${c.full_name ? '' : '<p class="muted small mb-4">Your name and gender are required on every grievance, so we ask once.</p>'}
      <div class="card">
        <form id="pf">
          <div class="field">
            <label for="fn">Full name</label>
            <input id="fn" type="text" value="${esc(c.full_name || '')}" autocomplete="name" required>
          </div>
          <div class="field">
            <label for="gd">Gender</label>
            <select id="gd">
              <option value="">Select</option>
              ${['Male', 'Female', 'Other', 'Prefer not to say'].map((o) =>
                `<option ${c.gender === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="em">Email <span class="muted" style="font-weight:400">(optional)</span></label>
            <input id="em" type="email" value="${esc(c.email || '')}" autocomplete="email">
          </div>
          <div class="field">
            <label for="pl">Preferred language</label>
            <select id="pl">
              ${state.languages.map((l) =>
                `<option value="${l.code}" ${c.preferred_language === l.code ? 'selected' : ''}>${esc(l.native)} · ${esc(l.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Mobile</label>
            <input type="text" value="+91 ${esc(c.mobile)}" disabled>
            <div class="hint">Verified. Contact support to change it.</div>
          </div>
          <button class="btn primary block" type="submit" id="pfBtn">Save</button>
        </form>
      </div>
    </div>`);

  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#pfBtn');
    btn.disabled = true;
    try {
      const r = await api.patch('/auth/profile', {
        fullName: $('#fn').value.trim(),
        gender: $('#gd').value,
        email: $('#em').value.trim(),
        preferredLanguage: $('#pl').value,
      });
      state.citizen = r.citizen;
      renderChrome();
      toast('Profile saved.', 'good');
      location.hash = '#/';
    } catch (ex) {
      toast(ex.errors ? ex.errors.map((x) => x.message).join(' ') : ex.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  };
}

/* ---------- router ---------- */

async function route() {
  const hash = location.hash || '#/';

  if (!state.citizen && hash !== '#/track') {
    if (hash !== '#/signin') { location.hash = '#/signin'; return; }
    renderChrome();
    viewSignIn();
    return;
  }

  if (state.citizen && hash === '#/signin') { location.hash = '#/'; return; }

  renderChrome();

  try {
    if (hash.startsWith('#/g/')) return await viewDetail(decodeURIComponent(hash.slice(4)));
    if (hash === '#/new') return await viewChat();
    if (hash === '#/grievances') return await viewList();
    if (hash === '#/track') return viewTrack();
    if (hash === '#/profile') return viewProfile();
    return await viewDashboard();
  } catch (ex) {
    if (ex.status === 401) { state.citizen = null; location.hash = '#/signin'; return; }
    setView(`<div class="notice bad">${esc(ex.message)}</div>`);
  }
  return undefined;
}

async function boot() {
  try {
    const [health, langs, divs] = await Promise.all([
      api.get('/health'),
      api.get('/speech/languages'),
      api.get('/grievances/divisions'),
    ]);
    state.health = health;
    state.languages = langs.languages;
    state.divisions = divs.divisions;
    renderCapabilities();
  } catch {
    setView('<div class="notice bad">The service is not reachable. Please try again shortly.</div>');
    return;
  }

  try {
    const me = await api.get('/auth/me');
    state.citizen = me.citizen;
  } catch {
    state.citizen = null;
  }

  window.addEventListener('hashchange', route);
  await route();
}

boot();
