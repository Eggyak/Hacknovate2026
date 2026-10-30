import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Import every module, and check the ones that export things still do.
 *
 * `node --check` validates syntax and nothing else. It will happily pass a
 * file importing a name that no longer exists, and the first sign of trouble
 * is the container crash-looping on boot:
 *
 *   SyntaxError: The requested module './civic.js' does not provide an
 *   export named 'assignCluster'
 *
 * That is exactly what happened when a refactor moved two functions into a
 * different module. This runs in the container, where the dependencies
 * actually exist, and fails in CI instead of in production.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// server.js binds a port and starts timers; importing it would stand up a
// second instance beside the one already serving.
const files = walk(SRC).filter((f) => basename(f) !== 'server.js');

test('every module resolves and binds its imports', async () => {
  const failures = [];
  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      failures.push(`${relative(SRC, file)}: ${err.message}`);
    }
  }
  assert.deepEqual(failures, [], `modules failed to load:\n${failures.join('\n')}`);
});

test('the module graph is non-trivial', () => {
  // A guard that silently checks nothing is worse than no guard.
  assert.ok(files.length >= 15, `only found ${files.length} modules to check`);
});
