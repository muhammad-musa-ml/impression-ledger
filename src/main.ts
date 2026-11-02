import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './server.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.poolMax);
if (process.env['AUTO_MIGRATE'] === '1') await migrate(pool);

const server = createApp({ pool, config });
server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      msg: 'listening',
      host: config.host,
      port: config.port,
      strategies: config.strategies.map((s) => s.name),
      holdBeforeCommitMs: config.holdBeforeCommitMs,
    }),
  );
});

async function shutdown(): Promise<void> {
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
