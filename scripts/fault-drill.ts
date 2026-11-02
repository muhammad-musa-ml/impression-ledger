// Fault drill: replay a synthetic event stream against the real server while
// the server is killed, then compare the database with what was sent.
//
// What it does, per run:
//   1. Creates a throwaway database and starts the server as a child process
//      with its two fault-injection holds switched on: a transaction stays open
//      for a while after its writes (FAULT_HOLD_BEFORE_COMMIT_MS), and a reply
//      is delayed for a while after COMMIT (FAULT_HOLD_AFTER_COMMIT_MS). The
//      process can then be killed inside either window.
//   2. Two probes, each with SIGKILL and a restart:
//      - before COMMIT: nothing of the killed batch may be stored; resending it
//        stores it once, and resending it again stores nothing more.
//      - after COMMIT, before the reply: all of the batch is stored although the
//        client never heard back; resending it is answered as all duplicates.
//   3. Replays the stream: batches in random order, a share of the events
//      delivered twice, a share of whole batches sent again, several requests in
//      flight at once. At fixed points in the replay the server is killed,
//      alternately in each window, and started again. Clients resend whatever
//      was not acknowledged.
//   4. Checks the database against the dataset (src/check.ts).
//
// Delivery is at least once. Where in a window the kill lands is not seeded, so
// two runs with the same seed send the same events and can fail differently.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { checkAgainstTruth, type CheckResult } from '../src/check.js';
import { createPool, migrate } from '../src/db.js';
import type { IngestResult } from '../src/ingest.js';
import type { Report } from '../src/report.js';
import type { LedgerEvent } from '../src/schema.js';
import { generateDataset, planDelivery } from '../src/synthetic.js';
import { defaultStrategies } from '../src/viewability.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(HERE, '..', 'src', 'main.js');
const REPO_ROOT = path.resolve(HERE, '..', '..');

const KEY_OF: Record<string, string> = {
  alpha: 'drill-key-alpha',
  bravo: 'drill-key-bravo',
  'probe-before': 'drill-key-probe-before',
  'probe-after': 'drill-key-probe-after',
};
const TENANT_KEYS = JSON.stringify(Object.fromEntries(Object.entries(KEY_OF).map(([tenant, key]) => [key, tenant])));

interface Options {
  runs: number;
  seed: number;
  views: number;
  kills: number;
  batch: number;
  concurrency: number;
  hold: number;
  out: string;
  databaseUrl: string;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: '3' },
      seed: { type: 'string', default: '1' },
      views: { type: 'string', default: '800' },
      kills: { type: 'string', default: '6' },
      batch: { type: 'string', default: '100' },
      concurrency: { type: 'string', default: '8' },
      hold: { type: 'string', default: '80' },
      out: { type: 'string', default: path.join(REPO_ROOT, 'results', 'fault-drill') },
    },
  });
  return {
    runs: Number(values.runs),
    seed: Number(values.seed),
    views: Number(values.views),
    kills: Number(values.kills),
    batch: Number(values.batch),
    concurrency: Number(values.concurrency),
    hold: Number(values.hold),
    out: path.resolve(values.out!),
    databaseUrl:
      process.env['DATABASE_URL'] ?? 'postgres://ledger:local-development-only@127.0.0.1:55437/ledger',
  };
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(2);
  }
  return cond();
}

/** The server under test, as a child process we are allowed to kill. */
class ServerProcess {
  private child: ChildProcess | null = null;
  private openTxns = new Set<number>();
  private exited: Promise<void> = Promise.resolve();
  private expectedExit = false;
  /** Transactions the server's log says have committed, since this process started. */
  commits = 0;
  stderr = '';
  unexpectedExits = 0;

  constructor(
    private readonly port: number,
    private readonly databaseUrl: string,
    private readonly holdMs: number,
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Transactions the server's log says are open: written to, not yet committed or rolled back. */
  get openTransactions(): number {
    return this.openTxns.size;
  }

  async start(): Promise<void> {
    this.openTxns = new Set();
    this.commits = 0;
    this.expectedExit = false;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: this.databaseUrl,
      PORT: String(this.port),
      HOST: '127.0.0.1',
      TENANT_KEYS,
      LOG_REQUESTS: '0',
      FAULT_HOLD_BEFORE_COMMIT_MS: String(this.holdMs),
      FAULT_HOLD_AFTER_COMMIT_MS: String(this.holdMs),
    };
    const child = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.exited = new Promise((resolve) => child.once('exit', () => resolve()));
    child.once('exit', () => {
      if (!this.expectedExit) this.unexpectedExits++;
    });
    child.stderr!.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { msg?: string; txn?: number; outcome?: string };
        if (msg.msg === 'txn-open' && typeof msg.txn === 'number') this.openTxns.add(msg.txn);
        if (msg.msg === 'txn-end' && typeof msg.txn === 'number') {
          this.openTxns.delete(msg.txn);
          if (msg.outcome === 'commit') this.commits++;
        }
      } catch {
        // not a JSON line; ignore
      }
    });
    for (let i = 0; i < 200; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/readyz`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {
        // not up yet
      }
      if (child.exitCode !== null) throw new Error(`server exited while starting: ${this.stderr}`);
      await sleep(50);
    }
    throw new Error('server did not become ready');
  }

  /** SIGKILL: the process gets no chance to roll back, flush or close anything. */
  async kill(): Promise<void> {
    this.expectedExit = true;
    this.child!.kill('SIGKILL');
    await this.exited;
  }

  async stop(): Promise<void> {
    this.expectedExit = true;
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([this.exited, sleep(3000)]);
      if (this.child.exitCode === null) this.child.kill('SIGKILL');
      await this.exited;
    }
  }
}

interface Stats {
  attempts: number;
  failedAttempts: number;
  batchesAcked: number;
  acceptedInAckedResponses: number;
  duplicatesInAckedResponses: number;
  conflicts: number;
  rejected: number;
  deadlockRetries: number;
}

function emptyStats(): Stats {
  return {
    attempts: 0,
    failedAttempts: 0,
    batchesAcked: 0,
    acceptedInAckedResponses: 0,
    duplicatesInAckedResponses: 0,
    conflicts: 0,
    rejected: 0,
    deadlockRetries: 0,
  };
}

/** Sends one batch until the server answers 200, resending after any network error or 5xx. */
async function sendUntilAcked(server: ServerProcess, tenant: string, events: LedgerEvent[], stats: Stats): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    stats.attempts++;
    let res: Response | undefined;
    try {
      res = await fetch(`${server.baseUrl}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY_OF[tenant]}` },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      res = undefined; // connection refused or reset: the server is down or was killed
    }
    if (res) {
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`the server refused a batch with ${res.status}: ${await res.text()}`);
      }
      if (res.status === 200) {
        // A reply cut off half way is a lost reply: the batch is sent again.
        const body = (await res.json().catch(() => undefined)) as IngestResult | undefined;
        if (body) {
          stats.batchesAcked++;
          stats.acceptedInAckedResponses += body.accepted;
          stats.duplicatesInAckedResponses += body.duplicates;
          stats.conflicts += body.conflicts.length;
          stats.rejected += body.rejected.length;
          stats.deadlockRetries += body.retries;
          return;
        }
      }
    }
    stats.failedAttempts++;
    await sleep(Math.min(40 * (attempt + 1), 250));
  }
  throw new Error('a batch was not acknowledged after 400 attempts');
}

type Window = 'before-commit' | 'after-commit';

interface ProbeRecord {
  window: Window;
  killedInWindow: boolean;
  eventsSent: number;
  eventsStoredAfterKill: number;
  verdictRowsAfterKill: number;
  eventsStoredAfterResend: number;
  acceptedOnResend: number;
  duplicatesOnResend: number;
  eventsStoredAfterSecondResend: number;
  acceptedOnSecondResend: number;
  pass: boolean;
}

/** One batch, one kill in the given window, then resend twice. */
async function crashProbe(server: ServerProcess, pool: pg.Pool, seed: number, window: Window): Promise<ProbeRecord> {
  const tenant = window === 'before-commit' ? 'probe-before' : 'probe-after';
  const events = generateDataset({ seed: seed + 7777, tenants: [tenant], viewsPerTenant: 6 }).events.map((e) => e.event);

  const commitsBefore = server.commits;
  const reply = fetch(`${server.baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY_OF[tenant]}` },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(20_000),
  }).then(
    () => 'answered',
    () => 'no reply',
  );
  const killedInWindow =
    window === 'before-commit'
      ? await waitFor(() => server.openTransactions >= 1, 5000)
      : await waitFor(() => server.commits > commitsBefore, 5000);
  await server.kill();
  if ((await reply) === 'answered') throw new Error(`the ${window} probe batch was answered although the server was killed`);

  const count = async (table: string): Promise<number> =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant])).rows[0]!.n;
  const eventsStoredAfterKill = await count('events');
  const verdictRowsAfterKill = await count('view_results');

  await server.start();
  const first = emptyStats();
  await sendUntilAcked(server, tenant, events, first);
  const eventsStoredAfterResend = await count('events');
  const second = emptyStats();
  await sendUntilAcked(server, tenant, events, second);
  const eventsStoredAfterSecondResend = await count('events');

  const stored = window === 'before-commit' ? 0 : events.length;
  const pass =
    killedInWindow &&
    eventsStoredAfterKill === stored &&
    (window === 'before-commit' ? verdictRowsAfterKill === 0 : verdictRowsAfterKill > 0) &&
    eventsStoredAfterResend === events.length &&
    first.acceptedInAckedResponses === (window === 'before-commit' ? events.length : 0) &&
    eventsStoredAfterSecondResend === events.length &&
    second.acceptedInAckedResponses === 0;
  return {
    window,
    killedInWindow,
    eventsSent: events.length,
    eventsStoredAfterKill,
    verdictRowsAfterKill,
    eventsStoredAfterResend,
    acceptedOnResend: first.acceptedInAckedResponses,
    duplicatesOnResend: first.duplicatesInAckedResponses,
    eventsStoredAfterSecondResend,
    acceptedOnSecondResend: second.acceptedInAckedResponses,
    pass,
  };
}

interface KillRecord {
  window: Window;
  afterBatchesAcked: number;
  /** Before-commit kills: transactions the log showed open. After-commit kills: commits logged since the wait began. */
  evidence: number;
}

function codeVersion(): { commit: string; dirty: boolean } {
  const git = (args: string[]): string => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  try {
    return {
      commit: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain', '--', 'src', 'scripts', 'migrations', 'package.json']) !== '',
    };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

async function runOnce(index: number, seed: number, opts: Options): Promise<Record<string, unknown>> {
  const startedAt = new Date();
  const dbName = `il_drill_${seed}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: opts.databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const dbUrl = withDatabase(opts.databaseUrl, dbName);
  const pool = createPool(dbUrl, 4);
  await migrate(pool);
  const postgres = (await pool.query<{ server_version: string }>('SHOW server_version')).rows[0]!.server_version;

  const strategies = defaultStrategies();
  const dataset = generateDataset({ seed, tenants: ['alpha', 'bravo'], viewsPerTenant: opts.views });
  const plan = planDelivery(dataset, { seed, batchSize: opts.batch, duplicateShare: 0.25, replayShare: 0.1 });

  const server = new ServerProcess(await freePort(), dbUrl, opts.hold);
  const stats = emptyStats();
  const kills: KillRecord[] = [];
  let result: CheckResult | undefined;
  const probes: ProbeRecord[] = [];
  try {
    await server.start();
    probes.push(await crashProbe(server, pool, seed, 'before-commit'));
    probes.push(await crashProbe(server, pool, seed, 'after-commit'));

    // The replay: a fixed number of workers take batches from one queue; a
    // separate loop kills the server at set points and starts it again.
    const queue = [...plan.batches];
    let replayDone = false;
    const workers = Array.from({ length: opts.concurrency }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) await sendUntilAcked(server, b.tenant, b.events, stats);
    });
    const killer = (async () => {
      for (let k = 1; k <= opts.kills && !replayDone; k++) {
        const window: Window = k % 2 === 1 ? 'before-commit' : 'after-commit';
        const target = Math.floor((plan.batches.length * k) / (opts.kills + 1));
        await waitFor(() => stats.batchesAcked >= target || replayDone, 120_000);
        if (replayDone) break;
        const commitsBefore = server.commits;
        if (window === 'before-commit') await waitFor(() => server.openTransactions >= 1, 5000);
        else await waitFor(() => server.commits > commitsBefore, 5000);
        await sleep(Math.floor(Math.random() * (opts.hold / 2)));
        kills.push({
          window,
          afterBatchesAcked: stats.batchesAcked,
          evidence: window === 'before-commit' ? server.openTransactions : server.commits - commitsBefore,
        });
        await server.kill();
        await server.start();
      }
    })();
    await Promise.all(workers);
    replayDone = true;
    await killer;

    const reports = new Map<string, Report>();
    for (const tenant of ['alpha', 'bravo']) {
      const res = await fetch(`${server.baseUrl}/v1/report`, { headers: { authorization: `Bearer ${KEY_OF[tenant]}` } });
      reports.set(tenant, (await res.json()) as Report);
    }
    result = await checkAgainstTruth(pool, dataset, strategies, reports);
  } finally {
    await server.stop();
    await pool.end().catch(() => {});
    const a = new pg.Client({ connectionString: opts.databaseUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  }

  if (!result) throw new Error('the run ended without a result');
  const version = codeVersion();
  const withEvidence = (w: Window): number => kills.filter((k) => k.window === w && k.evidence >= 1).length;
  const pass =
    result.pass &&
    probes.every((p) => p.pass) &&
    server.unexpectedExits === 0 &&
    stats.conflicts === 0 &&
    stats.rejected === 0 &&
    stats.deadlockRetries === 0;
  return {
    run: index,
    seed,
    pass,
    startedAt: startedAt.toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 100) / 10,
    code: version,
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      logicalCpus: os.cpus().length,
      node: process.version,
      postgres,
    },
    settings: {
      tenants: 2,
      viewsPerTenant: opts.views,
      batchSize: opts.batch,
      concurrency: opts.concurrency,
      holdBeforeCommitMs: opts.hold,
      holdAfterCommitMs: opts.hold,
      duplicateShare: 0.25,
      replayShare: 0.1,
      killsRequested: opts.kills,
    },
    delivery: {
      distinctEvents: plan.distinctEvents,
      deliveries: plan.deliveries,
      duplicateDeliveries: plan.duplicateDeliveries,
      batches: plan.batches.length,
      replayedBatches: plan.replayedBatches,
    },
    faults: {
      kills: kills.length,
      killsBeforeCommit: kills.filter((k) => k.window === 'before-commit').length,
      killsBeforeCommitWithOpenTransaction: withEvidence('before-commit'),
      killsAfterCommit: kills.filter((k) => k.window === 'after-commit').length,
      killsAfterCommitWithCommitLogged: withEvidence('after-commit'),
      killPoints: kills,
      unexpectedServerExits: server.unexpectedExits,
      failedAttempts: stats.failedAttempts,
      totalAttempts: stats.attempts,
      probes,
    },
    server: {
      batchesAcked: stats.batchesAcked,
      acceptedInAckedResponses: stats.acceptedInAckedResponses,
      duplicatesInAckedResponses: stats.duplicatesInAckedResponses,
      committedUnderLostReply: plan.distinctEvents - stats.acceptedInAckedResponses,
      conflicts: stats.conflicts,
      rejected: stats.rejected,
      deadlockRetries: stats.deadlockRetries,
    },
    result,
  };
}

async function main(): Promise<void> {
  const opts = parseOptions();
  await mkdir(opts.out, { recursive: true });
  let failed = 0;
  for (let i = 1; i <= opts.runs; i++) {
    const seed = opts.seed + i - 1;
    console.log(`run ${i}/${opts.runs} (seed ${seed}) ...`);
    const record = await runOnce(i, seed, opts);
    const file = path.join(opts.out, `run-${String(i).padStart(2, '0')}.json`);
    await writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
    const r = record['result'] as CheckResult;
    const f = record['faults'] as {
      kills: number;
      killsBeforeCommitWithOpenTransaction: number;
      killsAfterCommitWithCommitLogged: number;
      failedAttempts: number;
      probes: ProbeRecord[];
    };
    const s = record['server'] as { committedUnderLostReply: number };
    console.log(
      `  ${record['pass'] ? 'PASS' : 'FAIL'}: ${r.eventsStored}/${r.eventsExpected} events, gaps ${r.gaps}, extra ${r.extra}, ` +
        `duplicates ${r.semanticDuplicates}, verdict mismatches ${r.viewVerdictMismatches + r.reportMismatches + r.derivedStateMismatches}; ` +
        `kills ${f.kills} (${f.killsBeforeCommitWithOpenTransaction} before COMMIT with an open transaction, ` +
        `${f.killsAfterCommitWithCommitLogged} after COMMIT), failed attempts ${f.failedAttempts}, ` +
        `committed under a lost reply ${s.committedUnderLostReply}, probes ${f.probes.map((p) => (p.pass ? 'ok' : 'FAIL')).join('/')}`,
    );
    if (!record['pass']) {
      failed++;
      console.log(JSON.stringify({ problems: r.problems, probes: f.probes }, null, 2));
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

await main();
