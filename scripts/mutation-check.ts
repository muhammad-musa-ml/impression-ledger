// Negative controls: does the test suite, or the fault drill, notice a deliberate defect?
//
// The script copies the repository to a temporary folder, breaks one thing at a
// time in the copy, and runs the suites in order (unit tests, PostgreSQL
// integration tests, one small fault drill), stopping at the first that fails.
// The working tree is never touched. A baseline run of the unbroken copy goes
// first: if it does not pass, no verdict below it means anything.
//
//   npm run build && node dist/scripts/mutation-check.js
//
// It needs the same PostgreSQL the tests use (DATABASE_URL).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

type Stage = 'unit' | 'integration' | 'drill';

interface Mutant {
  id: string;
  file: string;
  defect: string;
  edits: { find: string; replace: string }[];
  /** Only a race can show this defect, so one failure proves little: repeat the database tests and count. */
  timing?: boolean;
}

/** Extra runs of the database tests on the unbroken copy and under each timing-dependent defect. */
const TIMING_REPEATS = 10;

const MUTANTS: Mutant[] = [
  {
    id: 'V1',
    file: 'src/viewability.ts',
    defect: 'the threshold is exclusive: exactly 50% in view does not count',
    edits: [{ find: '(e.visibleFraction ?? 0) >= strategy.threshold', replace: '(e.visibleFraction ?? 0) > strategy.threshold' }],
  },
  {
    id: 'V2',
    file: 'src/viewability.ts',
    defect: 'the duration is exclusive: exactly one second does not count',
    edits: [{ find: 'length >= strategy.minVisibleMs', replace: 'length > strategy.minVisibleMs' }],
  },
  {
    id: 'V3',
    file: 'src/viewability.ts',
    defect: 'time in view before the timer start is credited, so the timer start rule has no effect',
    edits: [{ find: 'const from = Math.max(startMs, timerStartMs);', replace: 'const from = startMs;' }],
  },
  {
    id: 'V4',
    file: 'src/viewability.ts',
    defect: 'a break below the threshold does not reset the run, so flickering ads are counted',
    edits: [{ find: 'closeRun(runStartMs, e.tsMs);\n      runStartMs = null;', replace: 'closeRun(runStartMs, e.tsMs);' }],
  },
  {
    id: 'V5',
    file: 'src/viewability.ts',
    defect: 'events are not sorted, so the result depends on arrival order',
    edits: [{ find: 'const sorted = [...events].sort(compareEvents);', replace: 'const sorted = [...events];' }],
  },
  {
    id: 'V6',
    file: 'src/viewability.ts',
    defect: 'a sample that is replaced at the same instant still ends the stretch it interrupts',
    edits: [
      {
        find: 'if (inEffect.length > 0 && inEffect[inEffect.length - 1]!.tsMs === e.tsMs) inEffect[inEffect.length - 1] = e;\n    else inEffect.push(e);',
        replace: 'inEffect.push(e);',
      },
    ],
  },
  {
    id: 'V7',
    file: 'src/viewability.ts',
    defect: 'of two samples with the same time and sequence number, the higher fraction wins',
    edits: [{ find: '(b.visibleFraction ?? -1) - (a.visibleFraction ?? -1)', replace: '(a.visibleFraction ?? -1) - (b.visibleFraction ?? -1)' }],
  },
  {
    id: 'I1',
    file: 'src/ingest.ts',
    defect: 'the ad_views rows are not locked, so batches of the same view run side by side',
    edits: [{ find: 'FOR UPDATE', replace: '' }],
    timing: true,
  },
  {
    id: 'I2',
    file: 'src/ingest.ts',
    defect: 'view rows are created in the order the batch lists them, not in id order',
    edits: [
      { find: 'const viewIds = [...adOfView.keys()].sort();', replace: 'const viewIds = [...adOfView.keys()];' },
      { find: 'ORDER BY v.view_id', replace: '' },
    ],
    timing: true,
  },
  {
    id: 'I3',
    file: 'src/ingest.ts',
    defect: 'no transaction: every statement commits on its own',
    edits: [{ find: "await client.query('BEGIN');", replace: '/* no transaction */' }],
  },
  {
    id: 'I4',
    file: 'src/ingest.ts',
    defect: 'the event insert has no ON CONFLICT clause',
    edits: [{ find: 'ON CONFLICT (tenant_id, event_id) DO NOTHING', replace: '' }],
  },
  {
    id: 'I5',
    file: 'src/ingest.ts',
    defect: 'events are stored under one shared tenant, so the idempotency key is not tenant-scoped',
    edits: [{ find: 'SELECT $1, e.event_id, e.view_id', replace: "SELECT substr($1, 1, 0) || 'shared', e.event_id, e.view_id" }],
  },
  {
    id: 'I6',
    file: 'src/ingest.ts',
    defect: 'an event id that comes back with different content is counted as a duplicate, not a conflict',
    edits: [{ find: 'if (storedHash === p.hash) existingDuplicates++;', replace: 'if (storedHash !== undefined) existingDuplicates++;' }],
  },
  {
    id: 'I7',
    file: 'src/ingest.ts',
    defect: "a view's verdict is computed from the events of this batch only, not from all stored events of the view",
    edits: [
      {
        find: 'const eventsByView = await loadViewEvents(client, tenantId, touched);',
        replace: `const eventsByView = new Map<string, { type: LedgerEvent['type']; tsMs: number; seq: number; visibleFraction?: number | undefined }[]>();
        for (const p of toInsert) {
          if (!written.has(p.event.eventId)) continue;
          const list = eventsByView.get(p.event.viewId) ?? [];
          list.push({ type: p.event.type, tsMs: p.event.tsMs, seq: p.event.seq, visibleFraction: p.event.visibleFraction });
          eventsByView.set(p.event.viewId, list);
        }`,
      },
    ],
  },
];

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');
const SHELL = process.platform === 'win32';

function run(cwd: string, command: string, args: string[], timeoutMs: number): { code: number | null; output: string } {
  // npx is a .cmd file on Windows and needs a shell; node itself does not, and its path may hold a space.
  const useShell = SHELL && command !== process.execPath;
  // FC_SEED pins the random inputs of the property tests, so a suite that passed on the unbroken
  // copy can only fail on a broken one because of the defect.
  const env = { ...process.env, FC_SEED: '1' };
  const res = spawnSync(command, args, { cwd, env, shell: useShell, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

interface VitestJson {
  numFailedTests: number;
  numTotalTests: number;
  testResults: { assertionResults: { fullName: string; status: string }[] }[];
}

async function runVitest(cwd: string, files: string[]): Promise<{ passed: boolean; total: number; failed: string[] }> {
  const out = path.join(cwd, 'vitest-out.json');
  await rm(out, { force: true });
  run(cwd, 'npx', ['vitest', 'run', ...files, '--reporter=json', `--outputFile=${out}`], 600_000);
  let json: VitestJson;
  try {
    json = JSON.parse(await readFile(out, 'utf8')) as VitestJson;
  } catch {
    return { passed: false, total: 0, failed: ['(vitest produced no report)'] };
  }
  const failed = json.testResults.flatMap((r) => r.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName));
  return { passed: json.numFailedTests === 0 && json.numTotalTests > 0, total: json.numTotalTests, failed };
}

async function runStage(cwd: string, stage: Stage): Promise<{ passed: boolean; detail: string }> {
  if (stage === 'unit') {
    const r = await runVitest(cwd, ['test/viewability.test.ts', 'test/viewability.property.test.ts', 'test/synthetic.test.ts', 'test/web.test.tsx']);
    return { passed: r.passed, detail: r.passed ? `${r.total} tests passed` : `${r.failed.length} failed: ${r.failed.slice(0, 2).join(' | ')}` };
  }
  if (stage === 'integration') {
    const r = await runVitest(cwd, ['test/ingest.test.ts', 'test/http.test.ts']);
    return { passed: r.passed, detail: r.passed ? `${r.total} tests passed` : `${r.failed.length} failed: ${r.failed.slice(0, 2).join(' | ')}` };
  }
  const build = run(cwd, 'npx', ['tsc', '-p', 'tsconfig.json'], 300_000);
  if (build.code !== 0) return { passed: false, detail: `build failed: ${build.output.slice(0, 200)}` };
  const out = path.join(cwd, 'drill-out');
  const drill = run(cwd, process.execPath, ['dist/scripts/fault-drill.js', '--runs', '1', '--views', '300', '--kills', '4', '--out', out], 420_000);
  const line = drill.output.split('\n').find((l) => /PASS:|FAIL:/.test(l))?.trim() ?? drill.output.trim().split('\n').slice(-2).join(' ').slice(0, 300);
  return { passed: drill.code === 0, detail: line };
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'il-mutation-'));
  const copy = path.join(tmp, 'repo');
  await cp(REPO_ROOT, copy, {
    recursive: true,
    filter: (src) => !/(^|[\\/])(node_modules|dist|\.git|results)([\\/]|$)/.test(path.relative(REPO_ROOT, src)),
  });
  await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'junction');

  const stages: Stage[] = ['unit', 'integration', 'drill'];
  const rows: {
    id: string;
    file: string;
    defect: string;
    caughtBy: string;
    detail: string;
    /** Further runs of the database tests, and how many of them failed. */
    repeats?: { runs: number; failed: number };
  }[] = [];
  let baselineOk = true;

  const repeatIntegration = async (): Promise<{ runs: number; failed: number }> => {
    let failed = 0;
    for (let i = 0; i < TIMING_REPEATS; i++) if (!(await runStage(copy, 'integration')).passed) failed++;
    return { runs: TIMING_REPEATS, failed };
  };

  console.log('baseline (no defect) ...');
  for (const stage of stages) {
    const r = await runStage(copy, stage);
    console.log(`  ${stage}: ${r.passed ? 'pass' : 'FAIL'} - ${r.detail}`);
    rows.push({ id: 'baseline', file: '-', defect: 'none', caughtBy: r.passed ? `${stage}: pass` : `${stage}: FAIL`, detail: r.detail });
    if (!r.passed) baselineOk = false;
  }
  if (!baselineOk) throw new Error('the unbroken copy does not pass; mutation results would mean nothing');
  const baselineRepeats = await repeatIntegration();
  console.log(`  integration, ${baselineRepeats.runs} more runs: ${baselineRepeats.failed} failed`);
  rows.push({
    id: 'baseline',
    file: '-',
    defect: 'none',
    caughtBy: 'integration, repeated',
    detail: `${baselineRepeats.failed} of ${baselineRepeats.runs} further runs failed`,
    repeats: baselineRepeats,
  });
  if (baselineRepeats.failed > 0) throw new Error('the database tests fail on the unbroken copy; a catch below could be a flake');

  for (const m of MUTANTS) {
    const file = path.join(copy, m.file);
    const original = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    let broken = original;
    let unrun = '';
    for (const e of m.edits) {
      const parts = broken.split(e.find);
      if (parts.length !== 2) unrun = `anchor occurs ${parts.length - 1} times: ${e.find.slice(0, 50)}`;
      broken = parts.join(e.replace);
    }
    if (!unrun && md5(broken) === md5(original)) unrun = 'the edit did not change the file';
    if (unrun) {
      console.log(`${m.id}: UNRUN (${unrun})`);
      rows.push({ id: m.id, file: m.file, defect: m.defect, caughtBy: 'UNRUN', detail: unrun });
      continue;
    }
    await writeFile(file, broken, 'utf8');
    let caughtBy = 'none';
    let detail = 'every suite passed';
    let repeats: { runs: number; failed: number } | undefined;
    try {
      for (const stage of stages) {
        const r = await runStage(copy, stage);
        if (!r.passed) {
          caughtBy = stage;
          detail = r.detail;
          break;
        }
      }
      if (m.timing) {
        repeats = await repeatIntegration();
        detail += ` (${repeats.failed} of ${repeats.runs} further runs of the database tests failed)`;
      }
    } finally {
      await writeFile(file, original, 'utf8');
    }
    if (md5(await readFile(file, 'utf8')) !== md5(original)) throw new Error(`${m.file} was not restored`);
    console.log(`${m.id}: ${caughtBy === 'none' ? 'SURVIVED' : `caught by ${caughtBy}`} - ${detail}`);
    rows.push({ id: m.id, file: m.file, defect: m.defect, caughtBy, detail, ...(repeats ? { repeats } : {}) });
  }

  const outDir = path.join(REPO_ROOT, 'results');
  const git = (args: string[]): string => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const code = {
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--', 'src', 'scripts', 'migrations', 'package.json', 'test']) !== '',
  };
  await writeFile(path.join(outDir, 'mutation-checks.json'), JSON.stringify({ code, fcSeed: 1, rows }, null, 2) + '\n', 'utf8');
  const table = rows
    .filter((r) => r.id !== 'baseline')
    .map((r) => `| ${r.id} | \`${r.file}\` | ${r.defect} | ${r.caughtBy === 'none' ? '**survived**' : r.caughtBy} | ${r.detail.replace(/\|/g, '/')} |`)
    .join('\n');
  const text = `# Negative controls

Generated by \`node dist/scripts/mutation-check.js\`. One defect at a time is put into a copy of the code, and the suites run in order (unit, PostgreSQL integration, one small fault drill) until one fails. The unbroken copy passed all three first, and the database tests then ran ${baselineRepeats.runs} more times on it with ${baselineRepeats.failed} failures. Defects that only a race can show are marked in the last column with how many of ${TIMING_REPEATS} further runs of the database tests failed. The property tests ran with a fixed random seed (FC_SEED=1), so only the defect can make a suite fail. Code commit: \`${code.commit.slice(0, 12)}\`${code.dirty ? ' (there were uncommitted changes in src, scripts, migrations, package.json or test)' : ''}.

| id | file | defect | first suite to fail | what failed |
| --- | --- | --- | --- | --- |
${table}
`;
  await writeFile(path.join(outDir, 'mutation-checks.md'), text, 'utf8');
  await rm(tmp, { recursive: true, force: true });
  const survived = rows.filter((r) => r.caughtBy === 'none' || r.caughtBy === 'UNRUN').length;
  console.log(`done: ${MUTANTS.length} defects, ${survived} not caught`);
}

await main();
