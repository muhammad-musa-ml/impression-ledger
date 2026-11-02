import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { recomputeAll } from '../src/recompute.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const { views, rows } = await recomputeAll(pool, config.strategies);
  console.log(`recomputed ${views} views, wrote ${rows} verdict rows`);
} finally {
  await pool.end();
}
