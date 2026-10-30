import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-level guards for three bugs that were reported from the browser.
 *
 * These assert on the shape of the code rather than on behaviour, which is a
 * weaker test than I would like - the real check needs a DOM, and there is no
 * browser in this environment. They are here because each of these bugs was
 * invisible until someone used the portal, and a guard that fails in CI is
 * worth more than a comment asking the next person not to reintroduce it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(HERE, '..', 'public', 'app.js'), 'utf8');

test('translating never mirrors the layout', () => {
  /*
   * Setting dir on <html> for Urdu flipped the entire interface: the form
   * moved to the other side of the screen, every row reversed, and English
   * fragments rendered as ". Your Voice Matters". A translation must not be
   * a layout change.
   */
  assert.ok(
    !/documentElement\.setAttribute\(\s*['"]dir['"]/.test(app),
    'document direction is being set globally again',
  );
  assert.ok(
    /setAttribute\('dir', 'auto'\)/.test(app),
    'per-string direction is how right-to-left text should be handled',
  );
});

test('translation fetches are queued, never dropped', () => {
  /*
   * localise() runs twice per navigation - once for the masthead, once for
   * the view. The old code bailed out of the second call while the first was
   * in flight, so those nodes were never painted. That is what made a citizen
   * select Hindi, then English, then Hindi again before it took effect.
   */
  assert.ok(/queue:\s*Promise\.resolve\(\)/.test(app), 'the fetch queue is gone');
  assert.ok(
    !/if \(missing\.length === 0 \|\| this\.pending\) return;/.test(app),
    'the early-return that dropped a pending call is back',
  );
  assert.ok(
    /this\.queue = this\.queue\.then/.test(app),
    'fetches are no longer chained onto the queue',
  );
  assert.ok(
    /function localise\(\)[\s\S]{0,200}return i18n\.apply\(\)/.test(app),
    'localise must return its promise so a language switch can await it',
  );
  assert.ok(/await localise\(\);/.test(app), 'the language switch does not await the translation');
});

test('a translation cannot be painted over a newer language', () => {
  // Two switches in quick succession must not leave the older one's text on
  // screen just because its request finished last.
  assert.ok(
    /if \(this\.lang !== lang\) return;/.test(app),
    'the stale-language guard is missing from apply/fetchMissing',
  );
});

test('an unknown number sends the citizen straight to sign-up', () => {
  /*
   * The delayed version left "No account for this number" under a Login form
   * for over a second, which reads as a refusal. People retype and try again
   * rather than waiting to be redirected.
   */
  const start = app.indexOf("ex.code === 'no_account'");
  const branch = app.slice(start, app.indexOf("already_registered", start));
  assert.ok(!/setTimeout/.test(branch), 'the switch is on a timer again');
  assert.ok(/auth\.mode = 'signup';/.test(branch), 'it no longer switches to sign-up');
  assert.ok(/\$\('#fullName'\)\.focus\(\)/.test(branch), 'the cursor is not placed for them');
});

test('the conversation and filed records are never machine-translated', () => {
  // The bot already replies in the language being SPOKEN, which is not
  // necessarily the one the site is set to, and a complaint is evidence.
  assert.ok(/id="stream" data-no-i18n/.test(app), 'the chat stream is no longer excluded');
  assert.ok(
    (app.match(/data-no-i18n/g) || []).length >= 5,
    'exclusions have been removed from records or docket numbers',
  );
});

test('the text-size control actually changes the text size', () => {
  /*
   * It did not, for several deploys. The root font-size was being scaled
   * while every font-size in the stylesheet was in px, so the buttons moved
   * a value nothing depended on. An accessibility control that does nothing
   * is worse than none: it tells someone their need has been met.
   */
  const css = readFileSync(join(HERE, '..', 'public', 'styles.css'), 'utf8');

  const pxSizes = css.match(/font-size:\s*[^;{}]*?\d+px/g) || [];
  assert.deepEqual(pxSizes, [], `${pxSizes.length} font-size declarations are still in px`);

  const remSizes = css.match(/font-size:\s*[^;{}]*?\drem/g) || [];
  assert.ok(remSizes.length > 50, `only ${remSizes.length} rem font-sizes found`);

  // Root in percent, so "A" follows the browser rather than overriding it.
  assert.ok(/html \{ font-size: 100%; \}/.test(css), 'root size is not 100%');
  assert.ok(/html\[data-size='sm'\] \{ font-size: \d/.test(css), 'smaller step missing');
  assert.ok(/html\[data-size='lg'\] \{ font-size: \d/.test(css), 'larger step missing');
});

test('the footer sits at the bottom of a short page', () => {
  // "My grievances" with nothing filed left the footer stranded mid-screen.
  const css = readFileSync(join(HERE, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(/body \{\s*min-height: 100dvh;\s*display: flex;\s*flex-direction: column;/.test(css),
    'body is no longer a full-height flex column');
  assert.ok(/main \{ flex: 1 0 auto; \}/.test(css), 'main no longer grows to fill');
});

test('a language change does not discard the interview', () => {
  /*
   * Switching language re-renders every view, and viewChat used to call
   * /chat/start each time - so the citizen watched a half-written complaint
   * disappear. It now resumes the active conversation instead.
   */
  assert.ok(/state\.activeConversationId/.test(app), 'the active conversation is not tracked');
  assert.ok(
    /if \(state\.activeConversationId\) \{[\s\S]{0,300}api\.get\(`\/chat\/\$\{state\.activeConversationId\}`\)/.test(app),
    'viewChat no longer resumes the active conversation',
  );
  assert.ok(/replayTranscript/.test(app), 'a resumed conversation is not redrawn');
});

test('clearing recent chats does not delete them', () => {
  // A grievance interview is a record of what a citizen said to a government
  // portal. Tidying a list must not destroy one.
  const block = app.slice(app.indexOf('const hiddenChats'), app.indexOf('async function showHistory'));
  assert.ok(/localStorage/.test(block), 'hidden chats are not kept locally');
  assert.ok(!/DELETE|api\.call|method: 'DELETE'/.test(block), 'hiding a chat reaches the server');
});

test('recent chats is a page, not a panel over the conversation', () => {
  /*
   * As a panel it left the citizen reading a list of past complaints stacked
   * on top of the one they were in the middle of writing. Looking for an
   * earlier chat is its own task and gets its own screen.
   */
  assert.ok(!/historyPanel/.test(app), 'the inline panel is back');
  assert.ok(/async function viewHistory\(\)/.test(app), 'the history page is gone');
  assert.ok(/hash === '#\/chats'/.test(app), 'the history page is not routed');
  assert.ok(/href="#\/chats"/.test(app), 'nothing links to it');
});

test('toggling spoken replies does not raise a toast', () => {
  // The checkbox shows its own state; a confirmation for every flip stacked
  // over the composer the citizen was trying to use.
  const block = app.slice(app.indexOf('function wireSpeakToggle'), app.indexOf('function wireSpeakToggle') + 600);
  assert.ok(!/toast\(/.test(block), 'the speak toggle raises a toast again');
});

test('an unlisted complaint still has somewhere to go', () => {
  assert.ok(/data-d="other"/.test(app), 'the catch-all is no longer offered');
  assert.ok(/chip-other/.test(app), 'it is not distinguished from a real department');
});
