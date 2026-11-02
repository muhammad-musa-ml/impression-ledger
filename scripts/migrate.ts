import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const files = await migrate(pool);
  console.log(`applied: ${files.join(', ')}`);
} finally {
  await pool.end();
}
