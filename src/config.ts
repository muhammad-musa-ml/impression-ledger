import { defaultStrategies, validateStrategy, type Strategy } from './viewability.js';

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  /** API key -> tenant id. */
  tenantKeys: Map<string, string>;
  strategies: Strategy[];
  poolMax: number;
  /**
   * Fault-injection hook for the crash drill. When above zero, every ingest
   * transaction waits this long after its writes and before COMMIT, and logs a
   * line when it opens and when it ends. Leave it at 0 outside the drill.
   */
  holdBeforeCommitMs: number;
  logRequests: boolean;
  webRoot: string;
}

export const DEMO_TENANT_KEYS: Record<string, string> = {
  'local-demo-key-alpha-000001': 'alpha',
  'local-demo-key-bravo-000002': 'bravo',
};

function num(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const keys = new Map<string, string>();
  const rawKeys = env['TENANT_KEYS'];
  const parsed: unknown = rawKeys ? JSON.parse(rawKeys) : DEMO_TENANT_KEYS;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TENANT_KEYS must be a JSON object of API key to tenant id');
  }
  for (const [key, tenant] of Object.entries(parsed)) {
    if (typeof tenant !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(tenant)) {
      throw new Error(`TENANT_KEYS: tenant for key ${key.slice(0, 4)}... is not a valid id`);
    }
    keys.set(key, tenant);
  }

  const strategies = defaultStrategies(
    num('VIEWABLE_THRESHOLD', env['VIEWABLE_THRESHOLD'], 0.5),
    num('VIEWABLE_MIN_MS', env['VIEWABLE_MIN_MS'], 1000),
  );
  strategies.forEach(validateStrategy);

  return {
    host: env['HOST'] ?? '127.0.0.1',
    port: num('PORT', env['PORT'], 8787),
    databaseUrl,
    tenantKeys: keys,
    strategies,
    poolMax: num('PG_POOL_MAX', env['PG_POOL_MAX'], 10),
    holdBeforeCommitMs: num('FAULT_HOLD_BEFORE_COMMIT_MS', env['FAULT_HOLD_BEFORE_COMMIT_MS'], 0),
    logRequests: env['LOG_REQUESTS'] !== '0',
    webRoot: env['WEB_ROOT'] ?? 'web/dist',
  };
}
