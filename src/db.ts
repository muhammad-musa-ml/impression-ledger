import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything with a query method: a pool or a checked-out client. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(databaseUrl: string, max = 10): Pool {
  const pool = new Pool({ connectionString: databaseUrl, max });
  // An idle client can be dropped by the server (restart, kill). Without a
  // listener the pool's error event would take the process down.
  pool.on('error', () => {});
  return pool;
}

/** Repository root: this file lives in src/ (or dist/src/ once compiled). */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(path.dirname(here)) === 'dist' ? path.resolve(here, '..', '..') : path.resolve(here, '..');
}

/** Applies every migrations/*.sql in name order. The files are idempotent. */
export async function migrate(pool: Pool): Promise<string[]> {
  const dir = path.join(repoRoot(), 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    await pool.query(sql);
  }
  return files;
}
