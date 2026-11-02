import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, migrate, type Pool } from '../../src/db.js';

export const BASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://ledger:local-development-only@127.0.0.1:55437/ledger';

/** CI sets REQUIRE_DB=1 so that a missing database fails the run instead of skipping the tests. */
export const REQUIRE_DB = process.env['REQUIRE_DB'] === '1';

export async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: BASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch (err) {
    if (REQUIRE_DB) throw new Error(`REQUIRE_DB=1 but PostgreSQL is not reachable at ${BASE_URL}: ${String(err)}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export interface TestDb {
  pool: Pool;
  url: string;
  drop: () => Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** A fresh, migrated database that only this test file uses. */
export async function createTestDb(): Promise<TestDb> {
  const name = `il_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(BASE_URL, name);
  const pool = createPool(url, 20);
  await migrate(pool);
  return {
    pool,
    url,
    drop: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: BASE_URL });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
