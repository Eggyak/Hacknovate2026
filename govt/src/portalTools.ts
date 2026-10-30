/**
 * Interface translation and text size for the department workspace.
 *
 * Both work the same way they do on the citizen portal, and for the same
 * reasons: staff at a district desk are not all comfortable reading an
 * English interface, and some of them need larger text. A grievance system
 * that only its English-reading officers can operate narrows who can be an
 * officer.
 *
 * Translation walks the rendered DOM rather than using a message catalogue.
 * This is a React app that re-renders constantly, so instead of hooking every
 * component it watches the document and re-translates what changed. A
 * catalogue would also have to be kept in step with every label anyone edits;
 * what is on screen cannot fall out of step with itself.
 *
 * Three rules keep it from mangling the workspace:
 *
 *   - only English-looking text is sent, so a grievance id, a PIN code, an
 *     amount or a citizen's own words are left exactly as they are
 *   - anything inside [data-no-i18n] is skipped, which is how case text is
 *     protected: a complaint is evidence, not chrome
 *   - every node remembers the English it was authored with, so switching
 *     from Punjabi to Tamil translates the English, not the Punjabi
 */

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'OPTION', 'INPUT']);
const ATTRS = ['placeholder', 'title', 'aria-label'];

export const PORTAL_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'हिन्दी', bn: 'বাংলা', ta: 'தமிழ்', te: 'తెలుగు',
  mr: 'मराठी', gu: 'ગુજરાતી', kn: 'ಕನ್ನಡ', ml: 'മലയാളം', pa: 'ਪੰਜਾਬੀ',
  or: 'ଓଡ଼ିଆ', as: 'অসমীয়া', ur: 'اردو', ne: 'नेपाली',
};

type Tracked = { node: Node; attr: string | null };

const originals = new WeakMap<Node, Record<string, string>>();
let tracked: Tracked[] = [];
let dictionary: Record<string, string> = {};
let language = 'en';
let queue: Promise<unknown> = Promise.resolve();
let observer: MutationObserver | null = null;
let pending = 0;

function translatable(text: string): boolean {
  const s = text.trim();
  if (s.length < 2 || s.length > 400) return false;
  if (!/[A-Za-z]/.test(s)) return false;        // no Latin: not ours to touch
  if (!/[A-Za-z]{2,}/.test(s)) return false;    // stray initials only
  if (/^MHA-\d{4}-\d+$/.test(s)) return false;  // department case ids
  if (/^MHA-GRV-/.test(s)) return false;        // citizen docket ids
  if (/^WARD-/.test(s)) return false;           // ward ids
  if (/^[\w.+-]+@[\w.-]+$/.test(s)) return false;
  return true;
}

function sourceOf(node: Node, attr: string | null): string {
  let record = originals.get(node);
  if (!record) {
    record = {};
    originals.set(node, record);
  }
  const key = attr ?? '#text';
  if (record[key] === undefined) {
    record[key] = attr
      ? ((node as Element).getAttribute(attr) ?? '').trim()
      : (node.nodeValue ?? '').trim();
    tracked.push({ node, attr });
  }
  return record[key];
}

function collect(root: HTMLElement) {
  const found = new Set<string>();
  const nodes: Array<{ node: Node; text: string; attr: string | null }> = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-no-i18n]')) return NodeFilter.FILTER_REJECT;
      return (node.nodeValue ?? '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    const source = sourceOf(node, null);
    if (translatable(source)) {
      found.add(source);
      nodes.push({ node, text: source, attr: null });
    }
    node = walker.nextNode();
  }

  for (const el of Array.from(root.querySelectorAll('[placeholder],[title],[aria-label]'))) {
    if (el.closest('[data-no-i18n]')) continue;
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const source = sourceOf(el, attr);
      if (translatable(source)) {
        found.add(source);
        nodes.push({ node: el, text: source, attr });
      }
    }
  }

  return { strings: Array.from(found), nodes };
}

function paint(nodes: Array<{ node: Node; text: string; attr: string | null }>) {
  for (const { node, text, attr } of nodes) {
    const hit = dictionary[text];
    if (!hit) continue;
    if (attr) {
      (node as Element).setAttribute(attr, hit);
    } else {
      const current = (node.nodeValue ?? '').trim();
      if (current !== hit) node.nodeValue = (node.nodeValue ?? '').replace(current, hit);
      // Per-string direction, so Urdu reads correctly without mirroring the
      // whole workspace layout.
      const host = node.parentElement;
      if (host && !host.hasAttribute('dir')) host.setAttribute('dir', 'auto');
    }
  }
}

/** Put every node we have touched back to the English it was authored with. */
function restore() {
  for (const { node, attr } of tracked) {
    if (!node.isConnected) continue;
    const record = originals.get(node);
    if (!record) continue;
    const source = record[attr ?? '#text'];
    if (source === undefined) continue;
    if (attr) (node as Element).setAttribute(attr, source);
    else {
      const current = (node.nodeValue ?? '').trim();
      if (current !== source) node.nodeValue = (node.nodeValue ?? '').replace(current, source);
    }
  }
  tracked = tracked.filter((t) => t.node.isConnected);
}

async function translateNow() {
  if (language === 'en') return;
  const { strings, nodes } = collect(document.body);
  if (strings.length === 0) return;

  paint(nodes);

  const missing = strings.filter((s) => !(s in dictionary));
  if (missing.length === 0) return;

  const forLanguage = language;
  // Queued, never dropped: this runs on every React render, and abandoning a
  // call while another is in flight leaves those nodes permanently English.
  queue = queue.then(async () => {
    const stillMissing = missing.filter((s) => !(s in dictionary));
    if (stillMissing.length === 0 || language !== forLanguage) return;
    try {
      const res = await fetch('/api/i18n', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: forLanguage, texts: stillMissing }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (language !== forLanguage) return;
      Object.assign(dictionary, data.translations ?? {});
      for (const s of stillMissing) if (!(s in dictionary)) dictionary[s] = '';
      try { localStorage.setItem(`mha-govt-i18n-${forLanguage}`, JSON.stringify(dictionary)); } catch { /* quota */ }
    } catch { /* English remains a working interface */ }
  }).catch(() => {});

  await queue;
  if (language !== forLanguage) return;
  paint(nodes);
}

/** Debounced, because React re-renders in bursts. */
function schedule() {
  if (language === 'en') return;
  window.clearTimeout(pending);
  pending = window.setTimeout(() => { void translateNow(); }, 120);
}

export function currentLanguage(): string {
  return language;
}

export function setPortalLanguage(code: string) {
  if (!(code in PORTAL_LANGUAGE_NAMES)) return;

  // Back to English first: the masthead and anything else that is not
  // re-rendered would otherwise be translated out of the previous language
  // rather than out of English.
  restore();

  language = code;
  dictionary = {};
  document.documentElement.lang = code;
  try {
    localStorage.setItem('mha-govt-lang', code);
    const cached = localStorage.getItem(`mha-govt-i18n-${code}`);
    if (cached) dictionary = JSON.parse(cached);
  } catch { /* private window */ }

  if (code === 'en') return;
  void translateNow();
}

/** Start watching. Safe to call once, from the app's first effect. */
export function startPortalTranslation() {
  let saved = 'en';
  try { saved = localStorage.getItem('mha-govt-lang') ?? 'en'; } catch { /* ignore */ }

  if (!observer) {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (saved !== 'en') setPortalLanguage(saved);
}

/* ---------- Text size ---------- */

/**
 * The workspace stylesheet is in px, so scaling the root would do nothing.
 * `zoom` scales the rendered result instead, which is the honest way to make
 * this work without rewriting every rule - and unlike a transform it reflows,
 * so nothing ends up clipped or overlapping.
 */
const SIZES: Record<string, number> = { sm: 0.9, md: 1, lg: 1.15 };

export function currentTextSize(): string {
  try { return localStorage.getItem('mha-govt-textsize') ?? 'md'; } catch { return 'md'; }
}

export function setTextSize(size: string) {
  const factor = SIZES[size] ?? 1;
  document.body.style.zoom = String(factor);
  try { localStorage.setItem('mha-govt-textsize', size); } catch { /* private window */ }
}

export function applySavedTextSize() {
  setTextSize(currentTextSize());
}

/* ---------- The toolbar ---------- */

/**
 * Mounted directly into the document rather than threaded through the app's
 * JSX.
 *
 * App.tsx is one large component with several early returns, and the controls
 * have to appear on all of them - including the sign-in screen, where an
 * officer who cannot read the English most needs them. Injecting once avoids
 * editing every return path, and avoids a change to this file ever being the
 * reason the workspace fails to render.
 *
 * It carries data-no-i18n: the language names are already in their own
 * scripts and must not be translated into each other.
 */
export function mountPortalTools() {
  if (document.getElementById('mha-portal-tools')) return;

  const bar = document.createElement('div');
  bar.id = 'mha-portal-tools';
  bar.setAttribute('data-no-i18n', '');
  bar.innerHTML = `
    <span class="pt-label">Text size</span>
    <button type="button" data-size="sm" title="Smaller">A-</button>
    <button type="button" data-size="md" title="Default">A</button>
    <button type="button" data-size="lg" title="Larger">A+</button>
    <span class="pt-sep"></span>
    <span class="pt-label">Language</span>
    <select aria-label="Portal language">
      ${Object.entries(PORTAL_LANGUAGE_NAMES)
        .map(([code, name]) => `<option value="${code}">${name}</option>`)
        .join('')}
    </select>`;

  document.body.appendChild(bar);

  const select = bar.querySelector('select') as HTMLSelectElement;
  select.value = currentLanguage();
  select.onchange = () => setPortalLanguage(select.value);

  const markSize = (size: string) => {
    bar.querySelectorAll('button[data-size]').forEach((b) => {
      b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.size === size));
    });
  };

  bar.querySelectorAll('button[data-size]').forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const size = (b as HTMLElement).dataset.size ?? 'md';
      setTextSize(size);
      markSize(size);
    };
  });

  markSize(currentTextSize());
  applySavedTextSize();
  startPortalTranslation();
  select.value = currentLanguage();
}
