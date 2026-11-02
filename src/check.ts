import type { Pool } from './db.js';
import type { Report } from './report.js';
import { loadViewEvents } from './results.js';
import { expectedReport, type Dataset } from './synthetic.js';
import { evaluateAll, type Strategy } from './viewability.js';

export interface CheckResult {
  tenants: string[];
  eventsExpected: number;
  eventsStored: number;
  /** Expected events that are not stored. */
  gaps: number;
  /** Stored events nobody sent. */
  extra: number;
  /** Events that share (tenant, view, type, seq) but have different ids: a duplicate that got past the key. */
  semanticDuplicates: number;
  viewsExpected: number;
  /** Views whose stored verdict differs from the designed expectation. */
  viewVerdictMismatches: number;
  /** (tenant, ad) cells of the report, per strategy and for the view count, that differ from the expectation. */
  reportMismatches: number;
  /** Stored verdicts that differ from a fresh evaluation of the stored events. */
  derivedStateMismatches: number;
  pass: boolean;
  /** The first few problems, in words. */
  problems: string[];
}

const key = (tenant: string, id: string): string => `${tenant}\u0000${id}`;

/**
 * Compares the database with the dataset that was sent to it. The expectations
 * come from the scenarios (src/synthetic.ts), not from the counter under test.
 * `reports` is what the report endpoint returned for each tenant.
 */
export async function checkAgainstTruth(
  pool: Pool,
  dataset: Dataset,
  strategies: readonly Strategy[],
  reports: ReadonlyMap<string, Report>,
): Promise<CheckResult> {
  const problems: string[] = [];
  const note = (msg: string): void => {
    if (problems.length < 10) problems.push(msg);
  };
  const tenants = [...new Set(dataset.events.map((e) => e.tenant))].sort();

  // 1. Stored events against sent events.
  const expectedIds = new Set(dataset.events.map((e) => key(e.tenant, e.event.eventId)));
  const stored = await pool.query<{ tenant_id: string; event_id: string }>(
    `SELECT tenant_id, event_id FROM events WHERE tenant_id = ANY($1::text[])`,
    [tenants],
  );
  const storedIds = new Set(stored.rows.map((r) => key(r.tenant_id, r.event_id)));
  let gaps = 0;
  for (const id of expectedIds) {
    if (!storedIds.has(id)) {
      gaps++;
      note(`missing event ${id.replace('\u0000', '/')}`);
    }
  }
  let extra = 0;
  for (const id of storedIds) {
    if (!expectedIds.has(id)) {
      extra++;
      note(`unexpected event ${id.replace('\u0000', '/')}`);
    }
  }
  const dup = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
        SELECT 1 FROM events WHERE tenant_id = ANY($1::text[])
         GROUP BY tenant_id, view_id, type, seq HAVING count(*) > 1) d`,
    [tenants],
  );
  const semanticDuplicates = dup.rows[0]!.n;
  if (semanticDuplicates > 0) note(`${semanticDuplicates} (view, type, seq) groups stored under more than one event id`);

  // 2. Stored verdicts against the designed expectation, view by view.
  const results = await pool.query<{ tenant_id: string; view_id: string; strategy: string; counted: boolean }>(
    `SELECT tenant_id, view_id, strategy, counted FROM view_results WHERE tenant_id = ANY($1::text[])`,
    [tenants],
  );
  const verdict = new Map(results.rows.map((r) => [`${key(r.tenant_id, r.view_id)}\u0000${r.strategy}`, r.counted]));
  let viewVerdictMismatches = 0;
  for (const v of dataset.views) {
    for (const s of strategies) {
      const want = v.expect[s.name as keyof typeof v.expect];
      const got = verdict.get(`${key(v.tenant, v.viewId)}\u0000${s.name}`);
      if (got !== want) {
        viewVerdictMismatches++;
        note(`view ${v.tenant}/${v.viewId} (${v.scenario}) under ${s.name}: expected ${want}, stored ${got}`);
      }
    }
  }

  // 3. The report endpoint's numbers against the expectation, ad by ad.
  let reportMismatches = 0;
  const want = expectedReport(dataset);
  for (const tenant of tenants) {
    const report = reports.get(tenant);
    const ads = new Map((report?.ads ?? []).map((a) => [a.adId, a]));
    const expectedAds = want.get(tenant) ?? new Map();
    for (const [adId, exp] of expectedAds) {
      const got = ads.get(adId);
      if (!got || got.views !== exp.views) {
        reportMismatches++;
        note(`report ${tenant}/${adId}: views expected ${exp.views}, got ${got?.views}`);
      }
      for (const s of strategies) {
        const e = exp.counted[s.name as keyof typeof exp.counted];
        if (got?.counted[s.name] !== e) {
          reportMismatches++;
          note(`report ${tenant}/${adId} ${s.name}: expected ${e}, got ${got?.counted[s.name]}`);
        }
      }
    }
    for (const adId of ads.keys()) {
      if (!expectedAds.has(adId)) {
        reportMismatches++;
        note(`report ${tenant}: unexpected ad ${adId}`);
      }
    }
  }

  // 4. Derived state: re-evaluate every view from its stored events.
  let derivedStateMismatches = 0;
  for (const tenant of tenants) {
    const viewIds = dataset.views.filter((v) => v.tenant === tenant).map((v) => v.viewId);
    for (let i = 0; i < viewIds.length; i += 500) {
      const chunk = viewIds.slice(i, i + 500);
      const events = await loadViewEvents(pool, tenant, chunk);
      for (const viewId of chunk) {
        const fresh = evaluateAll(events.get(viewId) ?? [], strategies);
        for (const s of strategies) {
          const got = verdict.get(`${key(tenant, viewId)}\u0000${s.name}`);
          if (got !== fresh.get(s.name)!.counted) {
            derivedStateMismatches++;
            note(`view ${tenant}/${viewId} under ${s.name}: stored ${got}, recomputed ${fresh.get(s.name)!.counted}`);
          }
        }
      }
    }
  }

  const pass =
    gaps === 0 &&
    extra === 0 &&
    semanticDuplicates === 0 &&
    viewVerdictMismatches === 0 &&
    reportMismatches === 0 &&
    derivedStateMismatches === 0;
  return {
    tenants,
    eventsExpected: expectedIds.size,
    eventsStored: storedIds.size,
    gaps,
    extra,
    semanticDuplicates,
    viewsExpected: dataset.views.length,
    viewVerdictMismatches,
    reportMismatches,
    derivedStateMismatches,
    pass,
    problems,
  };
}
