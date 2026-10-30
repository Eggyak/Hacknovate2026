import pg from 'pg';
import { env } from './env.js';

// Money and SLA arithmetic must not drift through floating point, so NUMERIC
// comes back as a string unless we say otherwise. We only use NUMERIC for
// confidences and coordinates, where a Number is both safe and convenient.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: env.database.url,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The rollback failing tells us nothing useful beyond the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function healthy() {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    return r.rows[0].ok === 1;
  } catch {
    return false;
  }
}
