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

import {
  reportPanel,
  supportPanel,
  updatesPanel,
  ratingPanel,
  ratingNudge,
  wireDetail,
  viewNearby,
  heatmapPanel,
  loadHeatmap,
  districtHeatPanel,
  loadLocalHeatmap,
} from './civic.js';

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
  activeConversationId: null,
  recent: [],
  recentExpanded: false,
  lastPipeline: null,
  lidCandidates: [],
  /*
   * Whether this filing goes out anonymously.
   *
   * Lives on the interview rather than the account: it is a decision about
   * one complaint, not a standing preference. Somebody reporting their own
   * landlord may want it; the same person reporting a pothole next week
   * probably does not.
   */
  fileAnonymously: false,
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

/**
 * Interface translation.
 *
 * The portal is authored in English and translated into the citizen's chosen
 * language by walking the rendered DOM, collecting the text, and asking the
 * server for all of it in one request.
 *
 * Why the DOM rather than a message catalogue: this portal is one screen of
 * markup away from changing, and a catalogue drifts the moment someone edits
 * a label without updating fourteen files. Walking what was actually rendered
 * cannot drift - whatever is on screen is what gets translated.
 *
 * Three rules keep it from mangling the page:
 *
 *   - Only English-looking text is sent. A Hindi subtitle already in the
 *     markup, a docket number, a PIN, an email address and a currency figure
 *     are all left exactly as they are.
 *   - Anything inside [data-no-i18n] is skipped, which covers the masthead
 *     wordmark, the citizen's own words, and anything monospaced.
 *   - Translation runs on freshly rendered English, never on its own output,
 *     so text cannot be translated twice into nonsense.
 */

const I18N_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'OPTION']);
const I18N_ATTRS = ['placeholder', 'title', 'aria-label'];

const i18n = {
  lang: 'en',
  dict: {},                  // English -> translated, for the active language
  originals: new WeakMap(),  // node -> { '#text' | attr : the English source }
  tracked: [],               // every node we have touched, so it can be reset
  queue: Promise.resolve(),  // fetches are queued, never dropped

  load(lang) {
    this.lang = lang;
    this.dict = {};
    if (lang === 'en') return;
    try {
      const raw = localStorage.getItem(`mha_i18n_${lang}`);
      if (raw) this.dict = JSON.parse(raw);
    } catch { /* private window, or corrupt - we simply refetch */ }
  },

  save() {
    if (this.lang === 'en') return;
    try {
      localStorage.setItem(`mha_i18n_${this.lang}`, JSON.stringify(this.dict));
    } catch { /* over quota or blocked; the cache is an optimisation only */ }
  },

  /**
   * Worth translating?
   *
   * Text with no Latin letters is already in a script we did not author, so
   * it is either the citizen's own words or a deliberate bilingual label -
   * both must survive untouched. Numbers, reference ids and addresses carry
   * no language at all.
   */
  translatable(text) {
    const s = text.trim();
    if (s.length < 2 || s.length > 400) return false;
    if (!/[A-Za-z]/.test(s)) return false;          // no Latin: not ours
    if (!/[A-Za-z]{2,}/.test(s)) return false;      // stray initials only
    if (/^MHA-GRV-/.test(s)) return false;          // docket numbers
    if (/^[\w.+-]+@[\w.-]+$/.test(s)) return false; // email addresses
    if (/^\+?\d[\d\s-]{5,}$/.test(s)) return false; // phone numbers
    return true;
  },

  /**
   * Collect every translatable string currently on screen.
   *
   * The English source for each node is remembered the first time it is seen,
   * and that source - never the node's current contents - is what gets looked
   * up. The masthead strip and the footer live in the static shell and are
   * never re-rendered, so without this, switching Punjabi to Tamil would
   * translate Punjabi into Tamil instead of English into Tamil.
   */
  collect(root = document.body) {
    const found = new Set();
    const nodes = [];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (I18N_SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[data-no-i18n]')) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      const source = this.sourceOf(node, null);
      if (this.translatable(source)) {
        found.add(source);
        nodes.push({ node, text: source, attr: null });
      }
      node = walker.nextNode();
    }

    for (const el of root.querySelectorAll('[placeholder],[title],[aria-label]')) {
      if (el.closest('[data-no-i18n]')) continue;
      for (const attr of I18N_ATTRS) {
        if (!el.hasAttribute(attr)) continue;
        const source = this.sourceOf(el, attr);
        if (this.translatable(source)) {
          found.add(source);
          nodes.push({ node: el, text: source, attr });
        }
      }
    }

    return { strings: [...found], nodes };
  },

  /** The English this node started life with. */
  sourceOf(node, attr) {
    let record = this.originals.get(node);
    if (!record) {
      record = {};
      this.originals.set(node, record);
      this.tracked.push({ node, attr });
    }
    const key = attr || '#text';
    if (record[key] === undefined) {
      record[key] = attr ? node.getAttribute(attr).trim() : node.nodeValue.trim();
      if (attr) this.tracked.push({ node, attr });
    }
    return record[key];
  },

  /** Put every tracked node back to the English it was authored in. */
  restore() {
    for (const { node, attr } of this.tracked) {
      if (!node.isConnected) continue;
      const record = this.originals.get(node);
      if (!record) continue;
      const source = record[attr || '#text'];
      if (source === undefined) continue;
      if (attr) node.setAttribute(attr, source);
      else if (node.nodeValue.trim() !== source) node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), source);
    }
    this.tracked = this.tracked.filter((t) => t.node.isConnected);
  },

  /** Put the dictionary onto the collected nodes. */
  paint(nodes) {
    for (const { node, text, attr } of nodes) {
      const hit = this.dict[text];
      if (!hit) continue;
      if (attr) {
        node.setAttribute(attr, hit);
      } else {
        const current = node.nodeValue.trim();
        if (current !== hit) node.nodeValue = node.nodeValue.replace(current, hit);
        // Let the browser resolve direction for this string alone. A
        // right-to-left translation then reads correctly without the
        // surrounding layout being mirrored.
        const host = node.parentElement;
        if (host && !host.hasAttribute('dir')) host.setAttribute('dir', 'auto');
      }
    }
  },

  /**
   * Translate whatever is on screen now.
   *
   * Paints from cache first, so a language already seen appears instantly,
   * then fetches whatever it has never seen and paints again.
   *
   * The ordering here is the whole bug fix. `localise()` runs twice per
   * navigation - once after the masthead re-renders, once after the view -
   * and the first version bailed out of the second call while the first was
   * still in flight. The nodes collected by that second call were therefore
   * never painted, so the page stayed English until something else forced a
   * re-render. That is exactly the "pick Hindi, pick English, pick Hindi
   * again" dance: the third selection finally landed because by then the
   * dictionary was cached and no fetch was needed.
   *
   * Requests are now queued rather than dropped, and EVERY call paints its
   * own nodes once the dictionary is up to date.
   */
  async apply(root = document.body) {
    if (this.lang === 'en') return;

    const lang = this.lang;
    const { strings, nodes } = this.collect(root);
    if (strings.length === 0) return;

    this.paint(nodes);

    const missing = strings.filter((s) => !(s in this.dict));
    if (missing.length === 0) return;

    // Queue behind any fetch already running instead of abandoning this one.
    this.queue = this.queue.then(() => this.fetchMissing(missing, lang)).catch(() => {});
    await this.queue;

    // The citizen may have switched again while we waited; if so, the newer
    // call owns the page and this one must not paint a stale language over it.
    if (this.lang !== lang) return;
    this.paint(nodes);
  },

  async fetchMissing(missing, lang) {
    const wanted = missing.filter((s) => !(s in this.dict));
    if (wanted.length === 0 || this.lang !== lang) return;

    try {
      const r = await api.post('/i18n', { to: lang, texts: wanted });
      if (this.lang !== lang) return;
      Object.assign(this.dict, r.translations || {});
      // Remember the misses too, so an untranslatable string is not asked
      // for on every single render.
      for (const s of wanted) if (!(s in this.dict)) this.dict[s] = '';
      this.save();
    } catch (err) {
      if (err.status === 503) {
        toast('Interface translation is not available on this server.', 'warn');
        this.lang = 'en';
      }
    }
  },
};

/** Translate the current screen. Safe to call after any render. */
function localise() {
  if (i18n.lang === 'en') return Promise.resolve();
  return i18n.apply().catch(() => { /* English is a working fallback */ });
}

/* ---------- speech ---------- */

/**
 * Whether the bot reads its replies aloud.
 *
 * Off by default and remembered. Audio that starts on its own is hostile in
 * the places this portal will actually be used - a shared room, an office, a
 * queue - so speaking is opt-in, and every reply keeps its own Listen button
 * for one-off use.
 */
const speakPref = {
  get() {
    try { return localStorage.getItem('mha_speak') === 'on'; } catch { return false; }
  },
  set(on) {
    try { localStorage.setItem('mha_speak', on ? 'on' : 'off'); } catch { /* private window */ }
  },
};

const speech = {
  recognizer: null,
  recording: false,
  recorder: null,
  chunks: [],
  stream: null,

  available() {
    return Boolean(window.SpeechSDK) && Boolean(state.health?.capabilities?.speech);
  },

  /**
   * Keep a copy of what the citizen actually said.
   *
   * The SDK streams the microphone to Azure and hands back text; the audio
   * itself never reaches us. The data schema requires a raw audio path on
   * every complaint, and rightly so - the transcript is a machine's reading
   * of someone's words, and when a complaint turns on exactly what was said,
   * the recording is the evidence. So we open a second capture of the same
   * microphone and keep it.
   *
   * A failure here must never stop the citizen speaking, so it is swallowed:
   * losing the recording is bad, losing the complaint is worse.
   */
  async startCapture() {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.chunks = [];
      this.recorder = new MediaRecorder(this.stream);
      this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      this.recorder.start();
    } catch {
      this.recorder = null;
    }
  },

  stopCapture() {
    return new Promise((resolve) => {
      const rec = this.recorder;
      this.recorder = null;
      if (!rec || rec.state === 'inactive') {
        this.releaseMic();
        return resolve(null);
      }
      rec.onstop = () => {
        const blob = this.chunks.length ? new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }) : null;
        this.chunks = [];
        this.releaseMic();
        resolve(blob);
      };
      try { rec.stop(); } catch { this.releaseMic(); resolve(null); }
      return undefined;
    });
  },

  releaseMic() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
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

    const lang = state.conversation?.language || state.citizen?.preferred_language || '';
    const { token, region, candidates, forceLocale } = await api.get(
      `/speech/token?language=${encodeURIComponent(lang)}`
      + (state.conversation ? `&conversationId=${state.conversation.conversationId}` : ''),
    );
    state.lidCandidates = candidates;

    const SDK = window.SpeechSDK;
    const cfg = SDK.SpeechConfig.fromAuthorizationToken(token, region);

    const audio = SDK.AudioConfig.fromDefaultMicrophoneInput();
    let rec;

    if (forceLocale) {
      /*
       * Azure will transcribe this language but will not identify it. Asking
       * it to do so closes the socket with InvalidArgument before a word is
       * heard - which is what made the microphone fail outright for Odia.
       * Recognise it directly instead: detection is lost, the microphone is
       * not.
       */
      cfg.speechRecognitionLanguage = forceLocale;
      rec = new SDK.SpeechRecognizer(cfg, audio);
    } else {
      cfg.setProperty(SDK.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');
      const auto = SDK.AutoDetectSourceLanguageConfig.fromLanguages(candidates);
      rec = SDK.SpeechRecognizer.FromConfig(cfg, auto, audio);
    }

    rec.recognizing = (_s, e) => {
      if (e.result.text) onPartial(e.result.text);
    };

    rec.recognized = (_s, e) => {
      if (e.result.reason !== SDK.ResultReason.RecognizedSpeech || !e.result.text) return;
      let locale = forceLocale || null;
      if (!locale) {
        try {
          locale = SDK.AutoDetectSourceLanguageResult.fromResult(e.result)?.language || null;
        } catch {
          locale = null;
        }
      }
      onFinal({ text: e.result.text, locale, candidates });
    };

    rec.canceled = (_s, e) => {
      this.stop();
      const detail = e.errorDetails || '';
      const refused = detail.match(/doesn't support ([a-z]{2}-[a-z]{2})/i);
      if (refused) {
        // Should not happen now that the server filters the list, but if
        // Azure changes its mind about a locale the citizen deserves a
        // sentence they can act on rather than a websocket error code.
        onError(new Error(
          `Voice input cannot auto-detect ${refused[1]}. Choose that language in the header and try again.`,
        ));
        return;
      }
      onError(new Error(detail || 'Recognition was cancelled.'));
    };

    this.recognizer = rec;
    this.recording = true;
    await this.startCapture();
    await new Promise((resolve, reject) => rec.startContinuousRecognitionAsync(resolve, reject));
  },

  stop() {
    this.recording = false;
    this.releaseMic();
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
  const here = location.hash || '#/';

  if (state.citizen) {
    nav.hidden = false;
    const items = [
      ['#/', 'Dashboard'],
      ['#/new', 'Register'],
      ['#/grievances', 'My grievances'],
      ['#/nearby', 'Nearby'],
      ['#/track', 'Track'],
    ];
    nav.innerHTML = items
      .map(([href, label]) => `<a href="${href}" class="${here === href ? 'on' : ''}">${label}</a>`)
      .join('');
  } else {
    nav.hidden = true;
  }

  // The language picker belongs in the header whether or not anyone is signed
  // in: a citizen who cannot read the English should be able to switch before
  // they reach a form, not after.
  const current = state.citizen?.preferred_language || localStorage.getItem('mha_lang') || 'en';
  right.innerHTML = `
    <span class="langpick">
      <span aria-hidden="true">&#127758;</span>
      <label class="sr" for="portalLang">Choose portal language</label>
      <select id="portalLang">
        ${state.languages.map((l) =>
          `<option value="${l.code}" ${l.code === current ? 'selected' : ''}>${esc(l.native)}${l.code === 'en' ? '' : ` (${esc(l.name)})`}</option>`).join('')}
      </select>
    </span>
    ${state.citizen ? `
      <a class="btn quiet" href="#/profile">${esc(state.citizen.full_name || `+91 ${state.citizen.mobile}`)}</a>
      <button class="btn quiet" id="signout">Sign out</button>` : ''}`;

  $('#portalLang').onchange = async (e) => {
    const code = e.target.value;
    try { localStorage.setItem('mha_lang', code); } catch { /* private window */ }

    document.documentElement.lang = code;
    // Deliberately NOT setting dir on <html>. Urdu is right-to-left as TEXT,
    // but mirroring the whole interface moves the form to the other side of
    // the screen and reverses every row - a layout change nobody asked for
    // when they asked for a translation. Browsers already lay Arabic script
    // out correctly inside a left-to-right block, and individual strings get
    // dir="auto" below so each one reads the right way round on its own.

    if (state.citizen) {
      api.patch('/auth/profile', { preferredLanguage: code }).catch(() => {});
      state.citizen.preferred_language = code;
    }

    // Back to the authored English first. The masthead and footer live in the
    // static shell and are never re-rendered, so without this they would be
    // translated out of the previous language rather than out of English.
    i18n.restore();
    i18n.load(code);
    await route();
    await localise();
  };

  localise();

  const out = $('#signout');
  if (out) {
    out.onclick = async () => {
      await api.post('/auth/signout');
      state.citizen = null;
      location.hash = '#/signin';
      renderChrome();
    };
  }
}

/**
 * Text size, from the Government of India strip.
 *
 * Every font-size in the stylesheet is in rem and the root is a PERCENTAGE,
 * so "A" means 100% - whatever the citizen has already chosen in their
 * browser or operating system - rather than a size of ours that overrides
 * theirs. A- and A+ step either side of that. Remembered per browser, since
 * someone who needs larger text needs it on every visit.
 */
function wireTextSize() {
  let saved = 'md';
  try { saved = localStorage.getItem('mha_textsize') || 'md'; } catch { /* private window */ }
  apply(saved);

  function apply(size) {
    document.documentElement.setAttribute('data-size', size);
    $$('.textsize button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.size === size));
    });
  }

  $$('.textsize button').forEach((b) => {
    b.onclick = () => {
      apply(b.dataset.size);
      try { localStorage.setItem('mha_textsize', b.dataset.size); } catch { /* ignore */ }
      const said = { sm: 'Smaller text', md: "Using your browser's text size", lg: 'Larger text' };
      toast(said[b.dataset.size] || 'Text size changed');
    };
  });
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
  localise();
}

/**
 * Sign in and create account.
 *
 * Two doors, one verification. Creating an account collects the identity
 * fields the grievance schema needs - name, gender, email - and signing in
 * asks for the number and the email together. Either way the number is proved
 * by a code before anything is written, and the verification state is shown
 * as it actually is rather than asserted.
 *
 * Labels are bilingual because the form is, and because a citizen reading the
 * Hindi should not have to infer which box is which from the English.
 */

const auth = { mode: 'signin', pending: null, timer: null, genders: [] };

/** Where a code will actually go, which is not always where a form promises. */
function deliveryNote(email) {
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return 'A code will be sent to your email';
  }
  return 'A code will be sent by SMS';
}

function viewAuth(mode = 'signin') {
  auth.mode = mode === 'signup' ? 'signup' : 'signin';
  auth.pending = null;
  clearInterval(auth.timer);

  const h = state.health;
  setView(`
    <div class="auth">
      <aside class="pitch">
        <span class="eyebrow">MHA Samadhan / एमएचए समाधान <span class="sep">|</span> नागरिक अधिकार पत्र</span>

        <h1>Your Voice Matters.<span class="gold">Your Grievance Matters.</span></h1>
        <div class="hi">आपकी आवाज़, आपका अधिकार।</div>
        <p class="lede">Register your grievance directly with the Ministry of Home Affairs, follow
          every stage of its progress, and receive the official outcome under a time-bound
          statutory guarantee.</p>

        <div class="feat">
          <span class="ico a" aria-hidden="true">&#127908;</span>
          <span><b>Speak or type naturally</b>
            <span>Describe what happened in your own words, by voice or text, in
            ${h.counts.languages} Indian languages${h.capabilities.translation ? ' with automatic translation' : ''}.</span></span>
        </div>
        <div class="feat">
          <span class="ico b" aria-hidden="true">&#128279;</span>
          <span><b>Intelligently routed</b>
            <span>Your complaint is read in your own language and sent to the right one of
            ${h.counts.divisions} MHA divisions.</span></span>
        </div>
        <div class="feat">
          <span class="ico c" aria-hidden="true">&#9201;</span>
          <span><b>Guaranteed ${h.sla.days}-day timeline</b>
            <span>Every stage is logged and the clock is visible to you from the moment
            you file.</span></span>
        </div>

        <div class="figures">
          <div><b>${h.counts.languages}</b><span>Languages</span></div>
          <div><b>${h.counts.divisions}</b><span>Divisions</span></div>
          <div><b>${h.sla.days}</b><span>Day SLA</span></div>
        </div>

        <div class="trust">
          <span>&#128274; TLS encrypted</span>
          <span>&#9878; DPDP Act 2023</span>
          <span>&#128273; No passwords</span>
        </div>
      </aside>

      <div><div class="authcard" id="authcard"></div></div>
    </div>`);

  renderAuthCard();
}

function renderAuthCard() {
  const host = $('#authcard');
  if (auth.pending) return renderOtpStep(host);

  const signup = auth.mode === 'signup';
  host.innerHTML = `
    <div class="eyebrow">MHA Samadhan &bull; Citizen Gateway</div>
    <h1>Welcome to MHA Samadhan</h1>
    <p class="sub">
      ${signup
        ? 'Create an account to register and track grievances. <span class="hi">/ नया खाता बनाएं।</span>'
        : 'Sign in to register and track grievances. <span class="hi">/ शिकायत दर्ज करने और ट्रैक करने के लिए लॉगिन करें।</span>'}
    </p>

    <div class="segs mb-4" role="tablist">
      <button role="tab" aria-selected="${!signup}" data-mode="signin">&#8594;] Login / प्रवेश</button>
      <button role="tab" aria-selected="${signup}" data-mode="signup">&#43; Create Account / नया खाता</button>
    </div>

    <form id="authForm" novalidate>
      ${signup ? `
        <div class="field">
          <label for="fullName">Full name <span class="req">*</span>
            <span class="hi">(आधिकारिक पहचान पत्र अनुसार)</span></label>
          <input id="fullName" type="text" autocomplete="name"
                 placeholder="Enter your legal name" required>
          <div class="err hidden" data-err="fullName"></div>
        </div>` : ''}

      <div class="field">
        <div class="row between">
          <label for="mobile" style="margin:0">Mobile number <span class="req">*</span>
            <span class="hi">/ मोबाइल नंबर</span></label>
          <span class="aside">10 digits, Indian SIM</span>
        </div>
        <div class="phone-row" style="margin-top:6px">
          <span class="cc"><small>IN</small>+91</span>
          <input id="mobile" type="tel" inputmode="numeric" autocomplete="tel-national"
                 maxlength="10" placeholder="Enter 10-digit mobile number" required>
        </div>
        <div class="err hidden" data-err="mobile"></div>
      </div>

      ${signup ? `
        <div class="field">
          <label for="gender">Gender <span class="req">*</span> <span class="hi">/ लिंग</span></label>
          <select id="gender" required>
            <option value="">Select gender</option>
            ${auth.genders.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
          </select>
          <div class="err hidden" data-err="gender"></div>
        </div>` : ''}

      <div class="field">
        <div class="row between">
          <label for="email" style="margin:0">Email address
            ${signup
              ? '<span class="hi">(optional / वैकल्पिक)</span>'
              : '<span class="req">*</span> <span class="hi">/ ईमेल</span>'}</label>
          <span class="aside">${signup ? 'For your acknowledgment copy' : 'The address on your account'}</span>
        </div>
        <input id="email" type="email" autocomplete="email" placeholder="name@example.com"
               style="margin-top:6px" ${signup ? '' : 'required'}>
        <div class="err hidden" data-err="email"></div>
      </div>

      ${signup ? `
        <div class="field">
          <div class="vstrip" id="vstrip">
            <span class="vstate pending">Mobile verification: Pending</span>
            <span class="how" id="vhow">${deliveryNote('')}</span>
          </div>
        </div>
        <div class="field">
          <label class="consent">
            <input type="checkbox" id="consent">
            <span>I confirm the particulars given are correct, and agree to receive grievance
              communications about them.</span>
          </label>
          <div class="err hidden" data-err="consent"></div>
        </div>` : ''}

      <div class="err hidden mb-3" data-err="_form"></div>
      <button class="btn primary block" type="submit" id="authBtn">
        ${signup ? 'Verify mobile and create account' : 'Continue with mobile OTP / ओटीपी प्राप्त करें'}
      </button>
    </form>

    <div class="swap">
      ${signup
        ? 'Already registered? <span class="hi">पहले से पंजीकृत?</span><button type="button" data-swap="signin">Sign in here &rarr;</button>'
        : 'First time here? <span class="hi">पहली बार आए हैं?</span><button type="button" data-swap="signup">Create an account &rarr;</button>'}
    </div>

    <div class="emergency">
      For emergency assistance with cybercrime or financial fraud, call the
      National Cyber Crime Helpline <b>1930</b> immediately.
    </div>`;

  $$('[data-mode]', host).forEach((b) => {
    b.onclick = () => { auth.mode = b.dataset.mode; renderAuthCard(); };
  });
  $$('[data-swap]', host).forEach((b) => {
    b.onclick = () => { auth.mode = b.dataset.swap; renderAuthCard(); };
  });

  $('#mobile').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, ''); };

  // Keep the promise about where the code goes honest as they type.
  const how = $('#vhow');
  if (how) $('#email').oninput = (e) => { how.textContent = deliveryNote(e.target.value.trim()); };

  $('#authForm').onsubmit = submitAuth;
  return undefined;
}

function showErr(field, message) {
  const el = $(`[data-err="${field}"]`);
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearErrs() {
  $$('[data-err]').forEach((el) => el.classList.add('hidden'));
}

async function submitAuth(e) {
  e.preventDefault();
  clearErrs();

  const signup = auth.mode === 'signup';
  const mobile = $('#mobile').value.replace(/\D/g, '');
  const email = ($('#email').value || '').trim();

  let bad = false;
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    showErr('mobile', 'Enter a valid 10-digit number starting 6, 7, 8 or 9.');
    bad = true;
  }
  if (signup) {
    if (($('#fullName').value || '').trim().length < 2) {
      showErr('fullName', 'Enter your full name.');
      bad = true;
    }
    if (!$('#gender').value) { showErr('gender', 'Select your gender.'); bad = true; }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      showErr('email', 'Enter a valid email address, or leave it blank.');
      bad = true;
    }
    if (!$('#consent').checked) { showErr('consent', 'Confirm your particulars to continue.'); bad = true; }
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    showErr('email', 'Enter the email address on your account.');
    bad = true;
  }
  if (bad) return;

  const btn = $('#authBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Sending code';

  try {
    const body = { mode: auth.mode, mobile, email };
    if (signup) {
      body.fullName = $('#fullName').value.trim();
      body.gender = $('#gender').value;
      body.consent = $('#consent').checked;
    }

    const r = await api.post('/auth/start', body);
    // Keep the accepted body: a resend has to re-state everything the server
    // validated the first time, and the citizen should not retype it.
    auth.pending = { mobile, masked: r.mobile, mode: auth.mode, name: r.name, body, channel: r.channel, email };
    renderAuthCard();

    if (!r.delivered) {
      toast(
        r.devCode
          ? `Delivery is not connected yet. Your code is ${r.devCode}.`
          : 'The code could not be delivered. Check the delivery service.',
        r.devCode ? 'warn' : 'bad',
      );
      if (r.devCode) fillOtp(r.devCode);
    }
  } catch (ex) {
    if (ex.errors) {
      ex.errors.forEach((x) => showErr(x.field, x.message));
    } else if (ex.code === 'no_account') {
      /*
       * Switch immediately, not after a timer.
       *
       * The delayed version left "No account for this number" sitting under
       * a Login form for over a second, which reads as a refusal rather than
       * a redirect - and a citizen who has an account on another portal, or
       * who had one here before, will simply retype and try again. Carry
       * their details over, say plainly what is still needed, and put the
       * cursor in the first empty box.
       */
      auth.mode = 'signup';
      renderAuthCard();
      $('#mobile').value = mobile;
      $('#email').value = email;
      const how = $('#vhow');
      if (how) how.textContent = deliveryNote(email);
      showErr('_form', 'There is no account for this number yet, so this is the sign-up form. '
        + 'Your number and email are filled in - add your name and gender to finish.');
      $('#fullName').focus();
      return;
    } else if (ex.code === 'already_registered') {
      auth.mode = 'signin';
      renderAuthCard();
      $('#mobile').value = mobile;
      $('#email').value = email;
      showErr('_form', 'This number already has an account, so this is the sign-in form. '
        + 'Continue to receive your code.');
      return;
    } else {
      showErr('_form', ex.message);
    }
    btn.disabled = false;
    btn.textContent = signup ? 'Verify mobile and create account' : 'Continue with mobile OTP / ओटीपी प्राप्त करें';
  }
}

function renderOtpStep(host) {
  const { masked, mode, channel, email } = auth.pending;
  const byEmail = channel === 'email' && email;

  host.innerHTML = `
    <div class="eyebrow">MHA Samadhan &bull; Secure session</div>
    <h1>Enter the 6-digit code</h1>
    <p class="sub">
      ${byEmail
        ? `Sent by email to <b>${esc(email)}</b>.`
        : `Sent by SMS to <b class="tnum">${esc(masked)}</b>.`}
      <button type="button" class="btn quiet" id="changeNum"
              style="min-height:auto;padding:0 4px">Change</button>
    </p>

    <div class="field">
      <div class="vstrip" id="vstrip">
        <span class="vstate pending">Mobile verification: Awaiting code</span>
        <span class="how">Valid for 5 minutes</span>
      </div>
    </div>

    <form id="otpForm" novalidate>
      <div class="field">
        <label class="sr" for="d0">One-time code</label>
        <div class="otp" id="otpBoxes"></div>
        <div class="err hidden center mt-3" data-err="code"></div>
      </div>
      <button class="btn primary block" type="submit" id="verifyBtn">
        ${mode === 'signup' ? 'Verify and create account' : 'Verify and enter grievance dashboard'}
      </button>
    </form>

    <div class="center mt-3">
      <button type="button" class="btn quiet" id="resendBtn" disabled>Resend code</button>
    </div>

    <div class="emergency">
      Never share this code. MHA staff will never ask you for it.
    </div>`;

  const boxes = buildOtpBoxes();
  startResend(60);

  $('#changeNum').onclick = () => {
    clearInterval(auth.timer);
    auth.pending = null;
    renderAuthCard();
  };

  $('#otpForm').onsubmit = verifyOtp;
  boxes[0].focus();
  return undefined;
}

function buildOtpBoxes() {
  const host = $('#otpBoxes');
  host.innerHTML = Array.from({ length: 6 }, (_, i) =>
    `<input id="d${i}" type="text" inputmode="numeric" maxlength="1" aria-label="Digit ${i + 1}"
            autocomplete="${i === 0 ? 'one-time-code' : 'off'}">`).join('');

  const boxes = $$('#otpBoxes input');
  boxes.forEach((box, i) => {
    box.oninput = () => {
      box.value = box.value.replace(/\D/g, '');
      if (box.value && i < 5) boxes[i + 1].focus();
      if (boxes.every((b) => b.value)) $('#otpForm').requestSubmit();
    };
    box.onkeydown = (ev) => {
      if (ev.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
    };
    box.onpaste = (ev) => {
      ev.preventDefault();
      fillOtp((ev.clipboardData.getData('text') || '').replace(/\D/g, ''));
    };
  });
  return boxes;
}

function fillOtp(digits) {
  const boxes = $$('#otpBoxes input');
  if (!boxes.length) return;
  [...digits.slice(0, 6)].forEach((d, i) => { boxes[i].value = d; });
  if (digits.length >= 6) $('#otpForm').requestSubmit();
}

function startResend(seconds) {
  const btn = $('#resendBtn');
  let left = seconds;
  clearInterval(auth.timer);

  const tick = () => {
    if (!document.getElementById('resendBtn')) return clearInterval(auth.timer);
    btn.disabled = left > 0;
    btn.textContent = left > 0
      ? `Resend code in ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`
      : 'Resend code';
    left -= 1;
    return undefined;
  };
  tick();
  auth.timer = setInterval(tick, 1000);

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await api.post('/auth/start', auth.pending.body);
      auth.pending.channel = r.channel;
      startResend(60);
      if (r.devCode) { toast(`Your code is ${r.devCode}.`, 'warn'); fillOtp(r.devCode); }
    } catch (ex) {
      toast(ex.message, 'bad');
      startResend(15);
    }
  };
}

async function verifyOtp(e) {
  e.preventDefault();
  const code = $$('#otpBoxes input').map((b) => b.value).join('');
  if (code.length !== 6) return;

  clearErrs();
  const btn = $('#verifyBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Verifying';

  try {
    const r = await api.post('/auth/verify', { mobile: auth.pending.mobile, code });
    state.citizen = r.citizen;

    const strip = $('#vstrip');
    if (strip) {
      strip.className = 'vstrip done';
      strip.innerHTML = '<span class="vstate done">Mobile verified</span>'
        + '<span class="how">Opening your dashboard</span>';
    }

    clearInterval(auth.timer);
    auth.pending = null;
    renderChrome();
    location.hash = r.profileComplete ? '#/' : '#/profile';
  } catch (ex) {
    showErr('code', ex.message);
    $$('#otpBoxes input').forEach((b) => { b.value = ''; });
    $('#d0')?.focus();
    btn.disabled = false;
    btn.textContent = auth.pending?.mode === 'signup'
      ? 'Verify and create account'
      : 'Verify and enter grievance dashboard';
  }
}

/**
 * Dashboard. Every number and every row is this citizen's own record.
 *
 * The recent list shows a few cases and expands on request rather than
 * paging: someone checking on a complaint wants to see it, not to learn a
 * navigation scheme. Each row carries BOTH references - ours, which they were
 * given the moment they filed, and the department's, which an officer will
 * quote back at them. Showing only one of the two makes the other
 * unfindable.
 */
const RECENT_COLLAPSED = 4;

async function viewDashboard() {
  setView('<div class="center" style="padding:60px 0"><span class="spin dark"></span></div>');

  // In one round trip rather than in series: the dashboard should not
  // take three times as long because it grew a panel.
  const [stats, list] = await Promise.all([
    api.get('/grievances/stats'),
    api.get('/grievances?limit=50'),
  ]);

  /*
   * The citizen's own area if we know it, the country if we do not.
   *
   * Their most recent filing supplies the pincode. Somebody who has filed
   * nothing yet has no area to show, and the national picture is a
   * reasonable thing to show them instead of an empty box.
   */
  const homePincode = (list.grievances || []).map((g) => g.pincode).find(Boolean) || null;
  const local = await loadLocalHeatmap(civicCtx(), homePincode);
  const heat = local && local.districts && local.districts.length
    ? null
    : await loadHeatmap(civicCtx());

  state.recent = list.grievances;
  state.recentExpanded = false;
  const c = state.citizen;

  setView(`
    <div class="row between wrap mb-4">
      <div>
        <h1>${c.full_name ? `Welcome, ${esc(c.full_name)}` : 'Your grievances'}</h1>
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

    ${ratingNudge(state.recent, civicCtx())}

    ${Number(stats.awaiting_forward) > 0 ? `
      <div class="notice warn mb-4">
        <span>${stats.awaiting_forward} complaint(s) are filed with us but have not reached a
        department desk yet. They are retried automatically; your docket number is unaffected.</span>
      </div>` : ''}


    <div class="home-split mb-4">
      <div class="card">
        <div class="row between wrap mb-3">
          <h2>Recent cases</h2>
          ${state.recent.length ? '<a class="small" href="#/grievances">Open full list</a>' : ''}
        </div>
        <div id="recentBody"></div>
      </div>

      ${local && local.districts && local.districts.length
        ? districtHeatPanel(local, civicCtx())
        : heatmapPanel(heat, civicCtx(), { compact: false })}
    </div>

    <div class="card">
      <div class="row between wrap mb-3">
        <h2>Your details</h2>
        <a class="small" href="#/profile">Edit</a>
      </div>
      <div class="grid c3">
        <div>
          <div class="small muted">Name</div>
          <div><b>${esc(c.full_name || 'Not provided')}</b></div>
        </div>
        <div>
          <div class="small muted">Mobile number</div>
          <div><b class="tnum">+91 ${esc(c.mobile)}</b></div>
          <span class="vstate ${c.mobile_verified ? 'done' : 'pending'}">
            ${c.mobile_verified ? 'OTP verified' : 'Not verified'}</span>
        </div>
        <div>
          <div class="small muted">Gender</div>
          <div><b>${esc(c.gender || 'Not provided')}</b></div>
        </div>
        <div>
          <div class="small muted">Email</div>
          <div><b>${esc(c.email || 'Not provided')}</b></div>
        </div>
        <div>
          <div class="small muted">Preferred language</div>
          <div><b>${esc(langOf(c.preferred_language)?.native || '-')}</b></div>
        </div>
        <div>
          <div class="small muted">Profile</div>
          <div>${c.full_name && c.gender
            ? '<span class="badge ok">Complete</span>'
            : '<a class="badge pending" href="#/profile" style="text-decoration:none">Needs details</a>'}</div>
        </div>
      </div>
    </div>`);

  renderRecent();
}

function renderRecent() {
  const host = $('#recentBody');
  if (!host) return;

  const all = state.recent || [];
  if (all.length === 0) {
    host.innerHTML = `
      <div class="center" style="padding:32px 0">
        <p class="muted">You have not filed any grievance yet.</p>
        <a class="btn primary mt-2" href="#/new">Register your first grievance</a>
      </div>`;
    return;
  }

  const shown = state.recentExpanded ? all : all.slice(0, RECENT_COLLAPSED);
  const hidden = all.length - shown.length;

  host.innerHTML = `
    <div class="caselist">
      ${shown.map((g) => {
        const t = g.tracking || {};
        const pct = Math.max(0, Math.min(100, ((g.sla.days - g.sla.daysLeft) / g.sla.days) * 100));
        return `
        <div class="caserow" data-ref="${esc(g.reference_id)}">
          <div class="casemain">
            <div class="row wrap" style="gap:8px;align-items:center">
              ${statusBadge(g.status)}
              ${g.priority === 'high' ? '<span class="badge urgent">Urgent</span>' : ''}
              <span class="small muted">${esc(g.division?.name || '-')}</span>
            </div>
            <div class="casesubject">${esc(g.subject || g.original_text || '').slice(0, 110)}</div>
            <div class="trackline">
              <span title="Your reference, issued when you filed">
                <span class="tk">Tracking</span> <b class="ref" data-no-i18n>${esc(t.reference || g.reference_id)}</b>
              </span>
              ${t.departmentCase
                ? `<span title="The department's own case number">
                     <span class="tk">Department case</span> <b class="ref" data-no-i18n>${esc(t.departmentCase)}</b>
                   </span>`
                : '<span class="badge pending">Reaching the department</span>'}
            </div>
          </div>
          <div class="caseside">
            <div class="small muted">Filed ${fmtDate(g.submitted_at)}</div>
            <div class="small ${g.sla.breached ? '' : 'muted'}"
                 ${g.sla.breached ? 'style="color:var(--danger);font-weight:700"' : ''}>
              ${g.sla.breached ? 'Overdue' : `${g.sla.daysLeft} days left`}
            </div>
            <div class="sla-bar ${g.sla.breached ? 'bad' : (g.sla.daysLeft <= 5 ? 'warn' : '')}">
              <i style="width:${pct}%"></i>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>

    ${all.length > RECENT_COLLAPSED ? `
      <div class="center mt-3">
        <button class="btn ghost" id="toggleRecent">
          ${state.recentExpanded
            ? 'See less'
            : `See ${hidden} more`}
        </button>
      </div>` : ''}`;

  $$('[data-ref]', host).forEach((row) => {
    row.onclick = () => { location.hash = `#/g/${row.dataset.ref}`; };
  });

  const toggle = $('#toggleRecent');
  if (toggle) {
    toggle.onclick = () => {
      state.recentExpanded = !state.recentExpanded;
      renderRecent();
      localise();
    };
  }
}

/* ---------- the interview ---------- */

/**
 * The grievance interview.
 *
 * Resumes `state.activeConversationId` when there is one and starts a fresh
 * interview otherwise. That distinction is what keeps a half-written
 * complaint alive across a language change: switching language re-renders
 * every view, and the old version called /chat/start each time, so the
 * citizen watched their complaint disappear.
 */
async function viewChat() {
  setView(`
    <div class="row between wrap mb-4">
      <div>
        <h1>Register a grievance</h1>
        <p class="muted small" style="margin:0">Describe what happened in your own words, in any language.</p>
      </div>
      <div class="row wrap" style="gap:10px">
        <div id="detectedBadge"></div>
        <label class="speaktoggle" title="Read the bot's replies aloud">
          <input type="checkbox" id="speakToggle">
          <span>&#128266; Speak replies</span>
        </label>
        <button class="btn ghost" id="newChat" style="min-height:38px">+ New chat</button>
        <a class="btn ghost" href="#/chats" style="min-height:38px">Recent chats</a>
      </div>
    </div>

    <div class="grid" style="grid-template-columns:minmax(0,1.65fr) minmax(0,1fr)">
      <div class="card" style="padding:0;overflow:hidden">
        <div class="chat">
          <div class="stream" id="stream" data-no-i18n></div>
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

  wireSpeakToggle();
  renderDetected(null);

  $('#newChat').onclick = () => startFreshChat();

  let current = null;

  if (state.activeConversationId) {
    try {
      current = await api.get(`/chat/${state.activeConversationId}`);
      replayTranscript(current.transcript || []);
    } catch {
      // Gone, or belonging to someone else. Start over rather than leaving
      // the citizen staring at an empty panel.
      state.activeConversationId = null;
      current = null;
    }
  }

  if (!current) {
    current = await api.post('/chat/start', { language: state.citizen.preferred_language || 'en' });
    state.activeConversationId = current.conversationId;
    pushBot(current.bot.text, current.language);
  }

  state.conversation = current;
  renderAffordance(current);
  renderProgress(current);
  renderDetected(current);

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

/** Put a resumed conversation back on screen, in the order it happened. */
function replayTranscript(turns) {
  for (const turn of turns) {
    if (turn.role === 'bot') pushBot(turn.text, turn.language);
    else pushMe(turn.text, null);
  }
}

/** Leave the current interview where it is and open a clean one. */
async function startFreshChat() {
  // A new interview is a new decision.
  state.fileAnonymously = false;

  state.activeConversationId = null;
  state.conversation = null;
  state.lastPipeline = null;
  await viewChat();
}

/*
 * Hiding a past interview removes it from THIS browser's list only.
 *
 * It is not deleted. A grievance interview is a record of what a citizen said
 * to a government portal, and a tidying gesture in a list must not destroy
 * one. The ids live in localStorage, so the same account on another device
 * still sees everything, and "Show hidden" brings them back here.
 */
const hiddenChats = {
  key: 'mha_hidden_chats',
  read() {
    try {
      return new Set(JSON.parse(localStorage.getItem(this.key) || '[]'));
    } catch {
      return new Set();
    }
  },
  write(set) {
    try {
      localStorage.setItem(this.key, JSON.stringify([...set]));
    } catch { /* private window */ }
  },
  hide(id) {
    const s = this.read();
    s.add(String(id));
    this.write(s);
  },
  hideAll(ids) {
    const s = this.read();
    ids.forEach((i) => s.add(String(i)));
    this.write(s);
  },
  clear() {
    this.write(new Set());
  },
};

/**
 * Recent chats, as a page of its own.
 *
 * It began as a panel above the conversation, which meant asking for the list
 * left the citizen reading both at once - a list of past complaints stacked
 * on top of the one they were in the middle of writing. Looking for an
 * earlier chat is its own task, so it gets its own screen and a way back.
 */
async function viewHistory() {
  setView(`
    <div class="row between wrap mb-4">
      <div>
        <h1>Recent chats</h1>
        <p class="muted small" style="margin:0">Open an earlier complaint to carry on where you left it.</p>
      </div>
      <div class="row wrap" style="gap:10px">
        <a class="btn ghost" href="#/new">&larr; Back to the bot</a>
        <button class="btn primary" id="newFromHistory">+ New chat</button>
      </div>
    </div>
    <div id="historyBody" class="measure"></div>`);

  $('#newFromHistory').onclick = async () => {
    state.activeConversationId = null;
    state.conversation = null;
    state.lastPipeline = null;
    location.hash = '#/new';
  };

  await renderHistoryBody();
}

async function renderHistoryBody() {
  const body = $('#historyBody');
  if (!body) return;

  body.innerHTML = '<div class="card center" style="padding:40px"><span class="spin dark"></span></div>';

  let conversations;
  try {
    ({ conversations } = await api.get('/chat/history'));
  } catch (ex) {
    body.innerHTML = `<div class="notice bad">${esc(ex.message)}</div>`;
    return;
  }

  const hidden = hiddenChats.read();
  const visible = conversations.filter((c) => !hidden.has(String(c.id)));

  body.innerHTML = `
    <div class="card">
      <div class="row between wrap mb-3">
        <h3 style="margin:0">${visible.length} chat${visible.length === 1 ? '' : 's'}</h3>
        <div class="row" style="gap:8px">
          ${hidden.size ? `<button class="btn quiet" id="restoreChats">Show hidden (${hidden.size})</button>` : ''}
          ${visible.length ? '<button class="btn quiet" id="clearChats">Clear list</button>' : ''}
        </div>
      </div>

      ${visible.length === 0 ? `
        <div class="center" style="padding:28px 0">
          <p class="muted" style="margin:0 0 4px">
            ${hidden.size
              ? 'Your list is cleared on this device. Nothing has been deleted.'
              : 'No earlier chats yet.'}
          </p>
          ${hidden.size ? '' : '<a class="btn primary mt-3" href="#/new">Start a complaint</a>'}
        </div>` : `
        <div class="chatlist">
          ${visible.map((c) => `
            <div class="chatrow" data-open="${c.id}">
              <div style="min-width:0">
                <b>${esc(c.title || 'Untitled complaint')}</b>
                <span class="meta">
                  ${c.submitted
                    ? `<span class="badge ok">${esc(c.reference)}</span>`
                    : statusChip(c.step)}
                  &middot; ${c.turns} message(s)
                  &middot; ${fmtDateTime(c.updatedAt)}
                </span>
              </div>
              <button class="btn quiet" data-hide="${c.id}"
                      title="Remove from this list. The chat is not deleted.">&times;</button>
            </div>`).join('')}
        </div>
        <p class="small muted mt-3" style="margin-bottom:0">
          Clearing the list only hides these on this device. Nothing is deleted.
        </p>`}
    </div>`;

  $$('[data-open]', body).forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest('[data-hide]')) return;
      state.activeConversationId = Number(row.dataset.open);
      state.conversation = null;
      state.lastPipeline = null;
      location.hash = '#/new';
    };
  });

  $$('[data-hide]', body).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      hiddenChats.hide(b.dataset.hide);
      renderHistoryBody();
    };
  });

  const clear = $('#clearChats');
  if (clear) {
    clear.onclick = () => {
      hiddenChats.hideAll(visible.map((c) => c.id));
      toast('List cleared on this device. No chat was deleted.', 'good');
      renderHistoryBody();
    };
  }

  const restore = $('#restoreChats');
  if (restore) {
    restore.onclick = () => {
      hiddenChats.clear();
      renderHistoryBody();
    };
  }
}

function statusChip(step) {
  return step === 'done'
    ? '<span class="badge pending">Ready to submit</span>'
    : `<span class="badge neutral">In progress &middot; ${esc(String(step).replace(/_/g, ' '))}</span>`;
}

/**
 * What language the bot is currently being spoken to in, and how it knows.
 *
 * Deliberately separate from the portal language in the masthead. A citizen
 * may read the site in Hindi and speak to the bot in Punjabi; the bot follows
 * the voice, and this badge is where that becomes visible rather than
 * something the citizen has to infer from the replies.
 */
function renderDetected(r) {
  const host = $('#detectedBadge');
  if (!host) return;

  const d = r?.detected;
  if (!d || !d.code) {
    host.innerHTML = '<span class="detbadge waiting">Listening for your language</span>';
    return;
  }

  const lang = langOf(d.code);
  const pct = Math.round((d.confidence || 0) * 100);
  const viaAzure = (d.method || '').startsWith('azure');

  host.innerHTML = `
    <span class="detbadge ${d.switched ? 'switched' : ''}" title="${esc(d.method || '')}">
      <b>${esc(lang?.native || d.code)}</b>
      <span class="n">${esc(lang?.name || '')}</span>
      ${pct ? `<span class="pct">${pct}%</span>` : ''}
      <span class="src">${viaAzure ? 'Azure LID' : 'script'}</span>
    </span>
    ${d.switched && d.previous
      ? `<span class="small muted" style="margin-inline-start:6px">switched from ${esc(langOf(d.previous)?.name || d.previous)}</span>`
      : ''}`;
}

function wireSpeakToggle() {
  const box = $('#speakToggle');
  if (!box) return;
  box.checked = speakPref.get();
  box.onchange = () => {
    speakPref.set(box.checked);
    // No toast: the checkbox already shows its own state, and a confirmation
    // for every flip stacks over the composer the citizen is trying to use.
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
    if (speakPref.get()) speech.say(r.bot.text, r.language);

    renderAffordance(r);
    renderDetected(r);
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

  if (kind === 'field') {
    const field = r.bot.input.field;
    const suggestion = r.bot.input.suggestion;

    // A value lifted from the citizen's own words. Offered for them to check
    // and send, never silently entered - a model's reading of a transaction
    // number is a prompt, not evidence.
    if (suggestion) {
      chips.innerHTML = `
        <span class="small muted" style="width:100%;margin-bottom:-4px">
          From what you told me — check it is right:</span>
        <button class="chip on" data-use>${esc(suggestion)}</button>
        <button class="chip" data-type>Type it myself</button>`;
      $('[data-use]', chips).onclick = () => sendMessage(suggestion, 'text');
      $('[data-type]', chips).onclick = () => { chips.innerHTML = ''; $('#say').focus(); };
      return;
    }

    if (field?.type === 'select') {
      chips.innerHTML = field.options
        .map((o) => `<button class="chip" data-v="${esc(o)}">${esc(o)}</button>`).join('');
      $$('[data-v]', chips).forEach((b) => { b.onclick = () => sendMessage(b.dataset.v, 'text'); });
    }
    return;
  }

  if (kind === 'location_pin') {
    chips.innerHTML = `
      <button class="chip on" id="useGps">Share my location</button>
      <button class="chip" id="skipGps">Skip</button>`;
    $('#useGps').onclick = useGps;
    $('#skipGps').onclick = () => patchAndAdvance({ skipLocationPin: true });
    return;
  }

  if (kind === 'declaration') {
    /*
     * Offered here and nowhere earlier.
     *
     * Asking at the start, before anyone knows what they are about to
     * describe, gets a shrug. Asking once the complaint is written and the
     * division is known is the moment the answer actually means something.
     */
    chips.innerHTML = `
      <label class="anon-toggle">
        <input type="checkbox" id="anonFiling" ${state.fileAnonymously ? 'checked' : ''}>
        <span>
          <b>File this anonymously</b>
          <small>Your complaint is kept off the public map, so no one can tie
          it to a street. It still counts in the state figures. The handling
          department sees it in full &mdash; a complaint nobody can be
          contacted about cannot be investigated.</small>
        </span>
      </label>
      <button class="chip on" data-dec="1">I declare this is true</button>
      <button class="chip" data-dec="0">Not yet</button>`;

    const anonBox = $('#anonFiling', chips);
    if (anonBox) anonBox.onchange = () => { state.fileAnonymously = anonBox.checked; };
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
  const listed = state.divisions.filter((d) => d.id !== 'other');
  const other = state.divisions.find((d) => d.id === 'other');

  const order = [
    ...suggested.map((id) => listed.find((d) => d.id === id)).filter(Boolean),
    ...listed.filter((d) => !suggested.includes(d.id)),
  ];

  chips.innerHTML = order
    .map((d) => `<button class="chip" data-d="${esc(d.id)}" title="${esc(d.blurb)}">${esc(d.name)}</button>`)
    .join('')
    // Always last, always present. A complaint that fits none of the fifteen
    // must still have somewhere to go; refusing it because our list is short
    // is the failure this portal exists to remove.
    + (other ? `<button class="chip chip-other" data-d="other" title="${esc(other.blurb)}">${esc(other.name)}</button>` : '');

  $$('[data-d]', chips).forEach((b) => { b.onclick = () => chooseDivision(b.dataset.d); });
}

async function chooseDivision(divisionId) {
  const r = await api.post(`/chat/${state.conversation.conversationId}/division`, { divisionId });
  state.conversation = r;

  // Append rather than replace: the routing trace above it is still the
  // answer to "how did this get here", and wiping it would lose that.
  if (r.draft?.otherPlan) {
    const p = r.draft.otherPlan;
    const n = (r.draft.otherQuestions || []).length;
    toast(p.source === 'llm'
      ? `This does not fit a listed department, so I have ${n} questions written for your complaint.`
      : `This does not fit a listed department, so I will ask ${n} general questions.`);
  }

  if (r.draft?.extraction) {
    state.lastPipeline = {
      steps: [
        ...(state.lastPipeline?.steps || []),
        {
          stage: 'field-extraction',
          provider: `mistral:${r.draft.extraction.model || 'n/a'}`,
          detail: r.draft.extraction,
        },
      ],
    };
    renderTrace(state.lastPipeline);
  }

  pushBot(r.bot.text, r.language);
  renderAffordance(r);
  renderProgress(r);
  if (r.step === 'done') await finishUp();
}

/** Apply a change to the draft and render whatever the bot asks next. */
async function patchAndAdvance(patch) {
  const r = await api.patch(`/chat/${state.conversation.conversationId}/draft`, patch);
  state.conversation = r;
  pushBot(r.bot.text, r.language);
  renderAffordance(r);
  renderProgress(r);
  if (r.step === 'done') await finishUp();
}

/**
 * Pin the citizen's coordinates, if they agree and the browser can.
 *
 * Declining is a first-class answer: the interview records that the question
 * was asked and moves on. A refused or unavailable GPS fix must never be the
 * thing that stops someone filing a grievance.
 */
function useGps() {
  if (!navigator.geolocation) {
    toast('This browser cannot share a location.', 'warn');
    return patchAndAdvance({ skipLocationPin: true });
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      await patchAndAdvance({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      toast('Location pinned.', 'good');
    },
    async () => {
      toast('Location was not shared.', 'warn');
      await patchAndAdvance({ skipLocationPin: true });
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
  return undefined;
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
    ['Location', Boolean(d.pincode && d.district && d.address)],
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
      } else if (s.stage === 'llm-adjudication') {
        if (!d.ran) {
          body = `<div class="ev">Not consulted — <code>${esc(d.reason || 'unavailable')}</code>.
            The keyword result stands.</div>`;
        } else {
          const div = state.divisions.find((x) => x.id === d.divisionId);
          body = `<div class="ev">${d.divisionId
            ? `Chose <b>${esc(div?.name || d.divisionId)}</b> at ${Math.round((d.confidence || 0) * 100)}% confidence.`
            : 'Found no suitable department either.'}</div>
            ${d.reason ? `<div class="ev">· ${esc(d.reason)}</div>` : ''}
            <div class="ev">· ${d.agreedWithLexicon
              ? 'agrees with the keyword result'
              : `keyword result was <code>${esc(d.lexiconSaid || 'none')}</code>`}</div>`;
        }
      } else if (s.stage === 'field-extraction') {
        body = d.ran === false
          ? `<div class="ev">Not run — <code>${esc(d.reason || 'unavailable')}</code>.</div>`
          : `<div class="ev">Pre-filled ${(d.suggested || []).length} field(s) from the complaint:
              ${(d.suggested || []).map((k) => `<code>${esc(k)}</code>`).join(' ') || 'none'}</div>
             ${(d.rejected || []).length
                ? `<div class="ev">· ${d.rejected.length} suggestion(s) failed the field's own validation and were discarded</div>`
                : ''}`;
      } else if (s.stage === 'location-resolution') {
        body = `<div class="ev">PIN ${esc(d.pincode)} resolved to <b>${esc(d.state || 'unknown')}</b>.</div>`;
      }

      const skipped = (s.stage === 'translation' && !d.produced)
        || (s.stage === 'llm-adjudication' && !d.ran);
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
    const r = await api.post(`/chat/${state.conversation.conversationId}/submit`, {
      anonymous: state.fileAnonymously,
    });
    speech.say(r.spoken, state.conversation.language);

    setView(`
      <div style="max-width:620px;margin:32px auto">
        <div class="card pad-lg center">
          <div class="badge ok" style="font-size:13px">Registered</div>
          <h1 class="mt-3">Your grievance is filed</h1>
          <p class="muted">Keep this docket number. You can track it any time.</p>
          ${state.fileAnonymously ? `
            <p class="small" style="color:var(--accent);font-weight:600">
              Filed anonymously. This complaint is not shown on the public map.
            </p>` : ''}
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
    state.activeConversationId = null;
  } catch (ex) {
    toast(ex.message, 'bad');
  }
}

/**
 * Send the narrative recording up. Only the first one is kept: it is the
 * citizen's account of what happened, not every later one-word answer.
 */
async function uploadNarrativeAudio(blob) {
  if (!state.conversation || state.conversation.draft?.audioPath) return;
  try {
    const form = new FormData();
    form.append('audio', blob, 'narrative.webm');
    await api.upload(`/grievances/conversation/${state.conversation.conversationId}/audio`, form);
  } catch {
    // The complaint stands with or without the recording.
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
          const blob = await speech.stopCapture();
          mic.classList.remove('rec');
          mic.classList.add('busy');
          say.value = '';
          await sendMessage(text, 'voice', { locale, candidates, confidence: 0.9 });
          if (blob) await uploadNarrativeAudio(blob);
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
                <td><span class="ref" data-no-i18n>${esc(g.reference_id)}</span>
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

  /*
   * The questions an unlisted complaint was asked, in the order it was asked
   * them. Stored as an array precisely because JSONB would have reordered an
   * object and left the record reading as a jumble.
   */
  const asked = Array.isArray(g.dynamic_labels) ? g.dynamic_labels : [];
  const askedLabel = new Map(asked.map((q) => [q.key, q.label]));
  const askedOrder = asked.map((q) => q.key);

  const details = Object.entries(g.dynamic_details || {}).sort((a, b) => {
    const ia = askedOrder.indexOf(a[0]);
    const ib = askedOrder.indexOf(b[0]);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  /*
   * A listed division names its own fields. An unlisted complaint was asked
   * questions written for it, which were stored alongside the answers - and
   * without them this table is a column of snake_case keys that mean nothing
   * to the citizen who answered them.
   */
  const fieldLabel = (key) => (g.division?.fields || []).find((f) => f.key === key)?.label
    || askedLabel.get(key)
    || key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  setView(`
    <div class="measure">
    <a class="small muted" href="#/grievances">&larr; My grievances</a>
    <div class="row between wrap mt-3 mb-4">
      <div>
        <div class="row" style="gap:8px"><span class="ref" data-no-i18n>${esc(g.reference_id)}</span>${statusBadge(g.status)}
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
          <p dir="${langOf(g.detected_language)?.dir || 'ltr'}" style="white-space:pre-wrap" data-no-i18n>${esc(g.original_text)}</p>
          ${g.translated_text ? `
            <details class="mt-3"><summary class="small muted" style="cursor:pointer">English rendering</summary>
              <p class="small mt-2" style="white-space:pre-wrap" data-no-i18n>${esc(g.translated_text)}</p>
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

        ${reportPanel(g, civicCtx())}
        ${updatesPanel(g, g.comments, civicCtx())}
        ${ratingPanel(g, civicCtx())}
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

        ${supportPanel(g, civicCtx())}

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
    </div>
    </div>`);

  /*
   * Re-render the whole page after an update or a rating rather than
   * patching it. Neither reply carries the stored comment row or the
   * recomputed priority, and building either locally would mean showing
   * something the server never said.
   */
  wireDetail(g, civicCtx(), () => viewDetail(reference));
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
            <span class="ref" data-no-i18n>${esc(g.reference_id)}</span>${statusBadge(g.status)}
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
  const complete = Boolean(c.full_name && c.gender);

  setView(`
    <div style="max-width:720px;margin:8px auto">
      <h1 class="mb-3">${complete ? 'Your profile' : 'Complete your profile'}</h1>
      ${complete ? '' : `
        <div class="notice warn mb-4">
          <span>Your name and gender are required on every grievance. Fill them in once here.</span>
        </div>`}

      <div class="card mb-4">
        <h3 class="mb-3">Account details</h3>
        <table class="data"><tbody>
          <tr><td class="small muted" style="width:42%">Name</td>
              <td class="small"><b>${esc(c.full_name || 'Not provided')}</b></td></tr>
          <tr><td class="small muted">Mobile number</td>
              <td class="small"><b class="tnum">+91 ${esc(c.mobile)}</b></td></tr>
          <tr><td class="small muted">OTP verification status</td>
              <td><span class="vstate ${c.mobile_verified ? 'done' : 'pending'}">
                ${c.mobile_verified ? 'Verified' : 'Not verified'}</span></td></tr>
          <tr><td class="small muted">Gender</td>
              <td class="small"><b>${esc(c.gender || 'Not provided')}</b></td></tr>
          <tr><td class="small muted">Email</td>
              <td class="small"><b>${esc(c.email || 'Not provided')}</b></td></tr>
          <tr><td class="small muted">Preferred language</td>
              <td class="small"><b>${esc(langOf(c.preferred_language)?.native || '-')}</b>
                <span class="muted">${esc(langOf(c.preferred_language)?.name || '')}</span></td></tr>
        </tbody></table>
      </div>

      <div class="card">
        <h3 class="mb-3">Edit details</h3>
        <form id="pf">
          <div class="field">
            <label for="fn">Full name</label>
            <input id="fn" type="text" value="${esc(c.full_name || '')}" autocomplete="name" required>
          </div>
          <div class="field">
            <label for="gd">Gender</label>
            <select id="gd">
              <option value="">Select gender</option>
              ${auth.genders.map((o) =>
                `<option ${c.gender === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
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
                `<option value="${l.code}" ${c.preferred_language === l.code ? 'selected' : ''}>${esc(l.native)} &middot; ${esc(l.name)}</option>`).join('')}
            </select>
            <div class="hint">The bot speaks and replies in this language by default.</div>
          </div>
          <div class="field">
            <label>Mobile number</label>
            <input type="text" value="+91 ${esc(c.mobile)}" disabled>
            <div class="hint">Verified by OTP and cannot be changed here.</div>
          </div>
          <button class="btn primary block" type="submit" id="pfBtn">Save changes</button>
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
      viewProfile();
    } catch (ex) {
      toast(ex.errors ? ex.errors.map((x) => x.message).join(' ') : ex.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  };
}

/* ---------- router ---------- */

/**
 * The helpers civic.js is given.
 *
 * Handed in rather than imported the other way round, so the dependency
 * runs in one direction only: civic.js knows nothing about this file's
 * state and cannot reach into it.
 */
function civicCtx() {
  return { api, esc, fmtDate, fmtDateTime, toast, setView };
}

async function route() {
  const hash = location.hash || '#/';

  const onGateway = !state.citizen && (hash === '#/signin' || hash === '#/signup');
  document.body.classList.toggle('auth-mode', onGateway);

  /*
   * Two pages need no session, because the endpoints behind them need none.
   *
   * Tracking by docket number is for somebody who filed on another device
   * or has lost their sign-in. Nearby is the transparency board, and the
   * whole point of publishing a division's record is that it can be read
   * before you decide to trust it with a complaint - demanding an account
   * first would make it something other than public.
   */
  const noSignInNeeded = new Set(['#/track', '#/nearby']);

  if (!state.citizen && !noSignInNeeded.has(hash)) {
    if (!onGateway) { location.hash = '#/signin'; return; }
    renderChrome();
    viewAuth(hash === '#/signup' ? 'signup' : 'signin');
    return;
  }

  if (state.citizen && (hash === '#/signin' || hash === '#/signup')) { location.hash = '#/'; return; }

  renderChrome();

  try {
    if (hash.startsWith('#/g/')) return await viewDetail(decodeURIComponent(hash.slice(4)));
    if (hash === '#/new') return await viewChat();
    if (hash === '#/chats') return await viewHistory();
    if (hash === '#/grievances') return await viewList();
    if (hash === '#/nearby') return await viewNearby(civicCtx());
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
    const [health, langs, divs, genders] = await Promise.all([
      api.get('/health'),
      api.get('/speech/languages'),
      api.get('/grievances/divisions'),
      api.get('/auth/genders'),
    ]);
    state.health = health;
    state.languages = langs.languages;
    state.divisions = divs.divisions;
    auth.genders = genders.genders;
    renderCapabilities();
    wireTextSize();

    let saved = 'en';
    try { saved = localStorage.getItem('mha_lang') || 'en'; } catch { /* ignore */ }
    const savedLang = langs.languages.find((l) => l.code === saved);
    if (savedLang) {
      document.documentElement.lang = savedLang.code;
      i18n.load(savedLang.code);
    }
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
