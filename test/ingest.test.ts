import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAgainstTruth } from '../src/check.js';
import { ingestBatch, type IngestResult } from '../src/ingest.js';
import { recomputeAll } from '../src/recompute.js';
import { buildReport } from '../src/report.js';
import type { LedgerEvent } from '../src/schema.js';
import { generateDataset, planDelivery, shuffle, makeRng } from '../src/synthetic.js';
import { defaultStrategies } from '../src/viewability.js';
import { createTestDb, dbAvailable, type TestDb } from './helpers/db.js';

const available = await dbAvailable();
const strategies = defaultStrategies();
const opts = { strategies };

let db: TestDb;
beforeAll(async () => {
  if (available) db = await createTestDb();
});
afterAll(async () => {
  if (available) await db.drop();
});

let tenantCounter = 0;
/** A tenant nobody else has used, so tests share a database without sharing rows. */
const freshTenant = (): string => `t${++tenantCounter}`;

function ev(viewId: string, adId: string, seq: number, type: LedgerEvent['type'], tsMs: number, f?: number): LedgerEvent {
  return {
    eventId: `${viewId}.${seq}`,
    viewId,
    adId,
    type,
    tsMs,
    seq,
    ...(f === undefined ? {} : { visibleFraction: f }),
  };
}

/** A view that is counted under first-token and not under fully-rendered. */
function duringStream(viewId: string, adId = 'ad-1'): LedgerEvent[] {
  return [
    ev(viewId, adId, 0, 'first_token', 100),
    ev(viewId, adId, 1, 'visibility', 100, 1),
    ev(viewId, adId, 2, 'visibility', 1400, 0.1),
    ev(viewId, adId, 3, 'render_complete', 2600),
    ev(viewId, adId, 4, 'view_end', 4000),
  ];
}

const count = async (sql: string, params: unknown[]): Promise<number> =>
  (await db.pool.query<{ n: number }>(sql, params)).rows[0]!.n;
const eventCount = (tenant: string): Promise<number> =>
  count('SELECT count(*)::int AS n FROM events WHERE tenant_id = $1', [tenant]);

describe.skipIf(!available)('ingestion', () => {
  it('stores a batch and records a verdict for every strategy', async () => {
    const t = freshTenant();
    const result = await ingestBatch(db.pool, t, duringStream('v1'), opts);
    expect(result).toMatchObject({ accepted: 5, duplicates: 0, conflicts: [], rejected: [] });
    const report = await buildReport(db.pool, t, strategies);
    expect(report.ads).toEqual([{ adId: 'ad-1', views: 1, counted: { 'first-token': 1, 'fully-rendered': 0 } }]);
  });

  it('stores nothing the second time the same batch arrives', async () => {
    const t = freshTenant();
    await ingestBatch(db.pool, t, duringStream('v1'), opts);
    const again = await ingestBatch(db.pool, t, duringStream('v1'), opts);
    expect(again).toMatchObject({ accepted: 0, duplicates: 5 });
    expect(await eventCount(t)).toBe(5);
    expect((await buildReport(db.pool, t, strategies)).ads[0]!.counted['first-token']).toBe(1);
  });

  it('scopes the idempotency key to the tenant', async () => {
    const [a, b] = [freshTenant(), freshTenant()];
    await ingestBatch(db.pool, a, duringStream('shared-view'), opts);
    const second = await ingestBatch(db.pool, b, duringStream('shared-view'), opts);
    expect(second.accepted).toBe(5);
    expect(await eventCount(a)).toBe(5);
    expect(await eventCount(b)).toBe(5);
    expect((await buildReport(db.pool, a, strategies)).ads).toHaveLength(1);
  });

  it('keeps the first version of an event id that comes back with different content', async () => {
    const t = freshTenant();
    await ingestBatch(db.pool, t, duringStream('v1'), opts);
    const changed = { ...duringStream('v1')[2]!, visibleFraction: 1 }; // same id, other content
    const result = await ingestBatch(db.pool, t, [changed], opts);
    expect(result).toMatchObject({ accepted: 0, duplicates: 0, conflicts: ['v1.2'] });
    const stored = await count(
      'SELECT count(*)::int AS n FROM events WHERE tenant_id = $1 AND event_id = $2 AND visible_fraction = 0.1',
      [t, 'v1.2'],
    );
    expect(stored).toBe(1);
  });

  it('handles repeats inside one batch', async () => {
    const t = freshTenant();
    const events = duringStream('v1');
    const clash = { ...events[1]!, tsMs: 101 };
    const result = await ingestBatch(db.pool, t, [...events, events[0]!, clash], opts);
    expect(result).toMatchObject({ accepted: 5, duplicates: 1, conflicts: ['v1.1'] });
    expect(await eventCount(t)).toBe(5);
  });

  it('refuses an event that names a different ad than its view already has', async () => {
    const t = freshTenant();
    await ingestBatch(db.pool, t, duringStream('v1', 'ad-1'), opts);
    const stray = ev('v1', 'ad-2', 9, 'visibility', 500, 1);
    const result = await ingestBatch(db.pool, t, [stray], opts);
    expect(result.rejected).toEqual([{ eventId: 'v1.9', reason: 'ad_mismatch' }]);
    expect(await eventCount(t)).toBe(5);
  });

  it('gives the same verdicts however the events of a view are split, ordered and repeated', async () => {
    const views = ['a', 'b', 'c'].map((v, i) => duringStream(`pv-${v}`, `ad-${i % 2}`));
    const all = views.flat();
    const baseline = freshTenant();
    await ingestBatch(db.pool, baseline, all, opts);
    const want = await buildReport(db.pool, baseline, strategies);

    await fc.assert(
      fc.asyncProperty(fc.integer(), fc.integer({ min: 1, max: 6 }), async (seed, parts) => {
        const rng = makeRng(seed);
        const stream = shuffle([...all, ...all.filter(() => rng() < 0.4)], rng);
        const size = Math.ceil(stream.length / parts);
        const t = freshTenant();
        for (let i = 0; i < stream.length; i += size) await ingestBatch(db.pool, t, stream.slice(i, i + size), opts);
        expect(await eventCount(t)).toBe(all.length);
        expect({ ...(await buildReport(db.pool, t, strategies)), tenant: '' }).toEqual({ ...want, tenant: '' });
      }),
      { numRuns: 25 },
    );
  });
});

describe.skipIf(!available)('concurrency', () => {
  it('stores one copy when the same batch arrives 24 times at once', async () => {
    const t = freshTenant();
    const batch = generateDataset({ seed: 5, tenants: [t], viewsPerTenant: 8 }).events.map((e) => e.event);
    const results = await Promise.all(Array.from({ length: 24 }, () => ingestBatch(db.pool, t, batch, opts)));
    expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(batch.length);
    expect(results.reduce((n, r) => n + r.duplicates, 0)).toBe(batch.length * 23);
    expect(await eventCount(t)).toBe(batch.length);
    const results2 = await count('SELECT count(*)::int AS n FROM view_results WHERE tenant_id = $1', [t]);
    expect(results2).toBe(8 * strategies.length);
  });

  it('gets the right answer when batches of the same views arrive together in opposite orders', async () => {
    const t = freshTenant();
    const dataset = generateDataset({ seed: 11, tenants: [t], viewsPerTenant: 60 });
    const plan = planDelivery(dataset, { seed: 11, batchSize: 20, duplicateShare: 0.3, replayShare: 0.2 });
    // Every batch carries events of many views, in a different order, so batches overlap on views.
    const results: IngestResult[] = [];
    const queue = [...plan.batches];
    const workers = Array.from({ length: 10 }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        results.push(await ingestBatch(db.pool, t, b.events, opts));
      }
    });
    await Promise.all(workers);
    const reports = new Map([[t, await buildReport(db.pool, t, strategies)]]);
    const check = await checkAgainstTruth(db.pool, dataset, strategies, reports);
    expect(check.problems).toEqual([]);
    expect(check.pass).toBe(true);
    expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(dataset.events.length);
  });
});

describe.skipIf(!available)('atomicity', () => {
  it('leaves nothing behind when the transaction does not reach COMMIT', async () => {
    const t = freshTenant();
    const boom = new Error('process died before commit');
    await expect(
      ingestBatch(db.pool, t, duringStream('v1'), {
        ...opts,
        onTxnOpen: () => {
          throw boom; // runs after every write and before COMMIT
        },
      }),
    ).rejects.toBe(boom);
    expect(await eventCount(t)).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM ad_views WHERE tenant_id = $1', [t])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM view_results WHERE tenant_id = $1', [t])).toBe(0);
    // The retry that follows a lost batch stores all of it.
    expect((await ingestBatch(db.pool, t, duringStream('v1'), opts)).accepted).toBe(5);
  });
});

describe.skipIf(!available)('recompute', () => {
  it('counts the same traffic again under a new rule', async () => {
    const t = freshTenant();
    await ingestBatch(db.pool, t, duringStream('v1'), opts); // 1300 ms in view during the stream
    expect((await buildReport(db.pool, t, strategies)).ads[0]!.counted['first-token']).toBe(1);

    const stricter = defaultStrategies(0.5, 2000);
    await recomputeAll(db.pool, stricter);
    const after = await buildReport(db.pool, t, stricter);
    expect(after.ads[0]!.counted).toEqual({ 'first-token': 0, 'fully-rendered': 0 });

    await recomputeAll(db.pool, strategies);
    expect((await buildReport(db.pool, t, strategies)).ads[0]!.counted['first-token']).toBe(1);
  });
});

describe.skipIf(!available)('the checker', () => {
  async function loaded(): Promise<{ t: string; dataset: ReturnType<typeof generateDataset> }> {
    const t = freshTenant();
    const dataset = generateDataset({ seed: 21, tenants: [t], viewsPerTenant: 30 });
    for (let i = 0; i < dataset.events.length; i += 100) {
      await ingestBatch(db.pool, t, dataset.events.slice(i, i + 100).map((e) => e.event), opts);
    }
    return { t, dataset };
  }
  const reportsOf = async (t: string): Promise<Map<string, Awaited<ReturnType<typeof buildReport>>>> =>
    new Map([[t, await buildReport(db.pool, t, strategies)]]);

  it('passes on a correct database', async () => {
    const { t, dataset } = await loaded();
    const check = await checkAgainstTruth(db.pool, dataset, strategies, await reportsOf(t));
    expect(check.problems).toEqual([]);
    expect(check).toMatchObject({ pass: true, gaps: 0, extra: 0, semanticDuplicates: 0 });
  });

  it('notices a lost event', async () => {
    const { t, dataset } = await loaded();
    await db.pool.query(`DELETE FROM events WHERE tenant_id = $1 AND event_id = 'v0-3.2'`, [t]);
    const check = await checkAgainstTruth(db.pool, dataset, strategies, await reportsOf(t));
    expect(check.pass).toBe(false);
    expect(check.gaps).toBe(1);
  });

  it('notices an event that was stored twice under two ids', async () => {
    const { t, dataset } = await loaded();
    await db.pool.query(
      `INSERT INTO events (tenant_id, event_id, view_id, ad_id, type, ts_ms, seq, visible_fraction, body_hash)
       SELECT tenant_id, event_id || '-again', view_id, ad_id, type, ts_ms, seq, visible_fraction, body_hash
         FROM events WHERE tenant_id = $1 AND event_id = 'v0-3.2'`,
      [t],
    );
    const check = await checkAgainstTruth(db.pool, dataset, strategies, await reportsOf(t));
    expect(check.pass).toBe(false);
    expect(check.semanticDuplicates).toBe(1);
    expect(check.extra).toBe(1);
  });

  it('notices a verdict that no longer matches the stored events', async () => {
    const { t, dataset } = await loaded();
    await db.pool.query(
      `UPDATE view_results SET counted = NOT counted, counted_at_ms = CASE WHEN counted THEN NULL ELSE 1 END
        WHERE tenant_id = $1 AND view_id = 'v0-4' AND strategy = 'first-token'`,
      [t],
    );
    const check = await checkAgainstTruth(db.pool, dataset, strategies, await reportsOf(t));
    expect(check.pass).toBe(false);
    expect(check.viewVerdictMismatches).toBe(1);
    expect(check.derivedStateMismatches).toBe(1);
    expect(check.reportMismatches).toBeGreaterThan(0);
  });
});
