import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-level guards for the Core Features panels.
 *
 * Same weakness as the other frontend guards: these assert on the shape of
 * the code, because checking the real thing needs a DOM and there is no
 * browser here. They are worth having anyway. Every one of these features
 * already worked end to end on the server for a while before any of it was
 * visible to a citizen, and that is exactly the kind of gap nobody notices
 * from the backend tests - which all passed the whole time.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, '..', 'public', name), 'utf8');

const app = read('app.js');
const civic = read('civic.js');
const css = read('styles.css');

test('the citizen can see the report that closed their case', () => {
  /*
   * The action-taken report is the answer the person has been waiting for,
   * and for a while it existed only inside the officers' workspace. A
   * resolution the complainant cannot read is not a resolution they have
   * been given.
   */
  assert.ok(/govt_report/.test(civic), 'the action-taken report is not rendered');
  assert.ok(/reportPanel\(g,/.test(app), 'the report panel is not on the docket page');
});

test('rating is offered only where the server will accept it', () => {
  /*
   * The server refuses a rating before resolution with 409 and a second one
   * outright. Drawing the stars anyway teaches people that the control is
   * broken, so the panel asks the record - and the record answers, because
   * getForCitizen returns canRate for precisely this reason.
   */
  assert.ok(/g\.canRate/.test(civic), 'the server-provided canRate is being ignored');
  assert.ok(
    /refuses a premature rating with 409/.test(civic),
    'the comment explaining who owns this rule is gone',
  );
});

test('a rating, once given, is shown rather than re-asked', () => {
  assert.ok(
    /satisfaction_rating\s*\)\s*\{/.test(civic),
    'a rating already recorded should short-circuit the form',
  );
  assert.ok(
    /cannot be changed/.test(civic),
    'a revisable rating is not a record of anything; say so',
  );
});

test('grouping is explained as grouping, not as merging', () => {
  /*
   * The server groups without merging - two neighbours filing the same
   * problem keep two dockets, two deadlines and two timelines. If the UI
   * words this badly, being grouped reads like being dismissed.
   */
  assert.ok(/cluster_id/.test(civic), 'the cluster is not surfaced at all');
  assert.ok(
    /handled on its own and keeps its own deadline/.test(civic),
    'nothing tells the citizen their docket survives being grouped',
  );
});

test('the citizen can add to their own case', () => {
  assert.ok(/commentForm/.test(civic), 'there is no way to post an update');
  assert.ok(
    /civic\/\$\{encodeURIComponent\(g\.reference_id\)\}\/comments/.test(civic),
    'the update is not being posted to the comments endpoint',
  );
});

test('the public page leaks nothing and says so', () => {
  /*
   * The map endpoint strips the complainant and the complaint text and
   * rounds coordinates to three decimals before serving them. The page
   * repeats the server's own note rather than making its own claim about
   * what is published.
   */
  assert.ok(/map\.note/.test(civic), "the server's own privacy note is not shown");
  assert.ok(
    !/original_text|complainant/i.test(civic.split('viewNearby')[1] || ''),
    'the public page is reaching for identifying fields',
  );
});

test('nearby is reachable', () => {
  assert.ok(/'#\/nearby', 'Nearby'/.test(app), 'the nav has no link to it');
  assert.ok(/hash === '#\/nearby'/.test(app), 'the router does not handle it');
});

test('the dashboard asks for a rating once, not never', () => {
  /*
   * Without the nudge the satisfaction figure stays empty and the
   * transparency score is computed from nothing - which is the state the
   * board was in before this existed.
   */
  assert.ok(/ratingNudge\(state\.recent/.test(app), 'the dashboard never asks');
  assert.ok(
    /unrated\.length === 0/.test(civic),
    'the nudge should disappear when there is nothing to rate',
  );
});

test('civic.js does not reach into the app', () => {
  /*
   * The helpers are handed in as ctx so the dependency runs one way. If
   * civic.js starts importing app.js the two become a cycle, and a module
   * that both renders panels and mutates the router is the thing this split
   * was meant to avoid.
   */
  assert.ok(!/from '\.\/app\.js'/.test(civic), 'civic.js imports the app back');
  assert.ok(!/\bstate\./.test(civic), "civic.js is touching the app's state directly");
});

test('every colour the scripts ask for actually exists', () => {
  /*
   * civic.js painted the good transparency scores with var(--good), and
   * nothing anywhere defines --good. The palette calls it --success. An
   * undefined custom property does not fail, or warn, or fall back to
   * anything sensible - it simply inherits, so the number rendered in
   * whatever colour the surrounding text happened to be and looked like a
   * design choice.
   *
   * Nothing catches that by reading, and there is no browser here to catch
   * it by looking, so it is checked here.
   */
  const defined = new Set(
    [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]),
  );

  const undefinedRefs = new Set();
  for (const source of [app, civic]) {
    for (const match of source.matchAll(/var\((--[a-z0-9-]+)/gi)) {
      if (!defined.has(match[1])) undefinedRefs.add(match[1]);
    }
  }

  assert.deepEqual(
    [...undefinedRefs],
    [],
    `these custom properties are used but never defined: ${[...undefinedRefs].join(', ')}`,
  );
  assert.ok(defined.size > 10, `only found ${defined.size} custom properties; the regex is wrong`);
});

test('a deploy cannot leave a browser running the old script', () => {
  /*
   * The static handler exempted only .html from the one-hour cache, so new
   * HTML was served alongside the previous app.js for an hour after every
   * deploy. That was survivable while app.js was self-contained. It stopped
   * being survivable when app.js started importing civic.js: a cached copy
   * has no such import, so the new panels were absent rather than broken,
   * which is much harder to notice.
   */
  const server = readFileSync(join(HERE, '..', 'src', 'server.js'), 'utf8');
  assert.ok(
    /\(html\|js\|css\)\$/.test(server),
    'scripts and stylesheets are cacheable again; a deploy will serve stale JS',
  );
});

test('the new controls scale with the text-size setting', () => {
  /*
   * The text-size control works by scaling the root font size, so anything
   * sized in px ignores it. That was already found once here, with 78 of 81
   * font sizes in px and the control appearing to do nothing.
   */
  const block = css.slice(css.indexOf('.stars'));
  assert.ok(block.length > 0, 'the star rules are missing');
  assert.ok(
    !/font-size:\s*\d+px/.test(block),
    'a px font-size in the new rules will not respond to the text-size control',
  );
});
