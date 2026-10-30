/**
 * Applies every .sql file in ../migrations once, in filename order.
 *
 * Runs on boot. A grievance portal that starts up against a schema one
 * migration behind will accept complaints and lose fields, so a failure here
 * is fatal by design.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations');

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }

    console.log(count === 0 ? '[migrate] schema already current' : `[migrate] applied ${count} migration(s)`);
  } finally {
    client.release();
  }
}

// Allow `npm run migrate` as well as the boot-time call.
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate]', err.message);
      process.exit(1);
    });
}
