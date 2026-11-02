import type { Queryable } from './db.js';
import { evaluateAll, type Strategy, type ViewEvent } from './viewability.js';

interface EventRow {
  view_id: string;
  type: ViewEvent['type'];
  ts_ms: number;
  seq: number;
  visible_fraction: number | null;
}

/** All stored events of the given views, grouped by view. */
export async function loadViewEvents(
  db: Queryable,
  tenantId: string,
  viewIds: readonly string[],
): Promise<Map<string, ViewEvent[]>> {
  const res = await db.query<EventRow>(
    `SELECT view_id, type, ts_ms, seq, visible_fraction
       FROM events
      WHERE tenant_id = $1 AND view_id = ANY($2::text[])`,
    [tenantId, viewIds],
  );
  const byView = new Map<string, ViewEvent[]>();
  for (const row of res.rows) {
    let list = byView.get(row.view_id);
    if (!list) byView.set(row.view_id, (list = []));
    list.push({
      type: row.type,
      tsMs: row.ts_ms,
      seq: row.seq,
      visibleFraction: row.visible_fraction ?? undefined,
    });
  }
  return byView;
}

/** Evaluates every strategy for every view in the map and upserts the verdicts. */
export async function upsertResults(
  db: Queryable,
  tenantId: string,
  eventsByView: ReadonlyMap<string, readonly ViewEvent[]>,
  strategies: readonly Strategy[],
): Promise<number> {
  const viewIds: string[] = [];
  const names: string[] = [];
  const counted: boolean[] = [];
  const countedAt: (number | null)[] = [];
  const longest: number[] = [];
  for (const [viewId, events] of [...eventsByView].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const verdicts = evaluateAll(events, strategies);
    for (const s of strategies) {
      const v = verdicts.get(s.name)!;
      viewIds.push(viewId);
      names.push(s.name);
      counted.push(v.counted);
      countedAt.push(v.countedAtMs);
      longest.push(v.longestRunMs);
    }
  }
  if (viewIds.length === 0) return 0;
  await db.query(
    `INSERT INTO view_results (tenant_id, view_id, strategy, counted, counted_at_ms, longest_run_ms)
     SELECT $1, r.view_id, r.strategy, r.counted, r.counted_at_ms, r.longest_run_ms
       FROM unnest($2::text[], $3::text[], $4::bool[], $5::int[], $6::int[])
            AS r(view_id, strategy, counted, counted_at_ms, longest_run_ms)
     ON CONFLICT (tenant_id, view_id, strategy) DO UPDATE
        SET counted = EXCLUDED.counted,
            counted_at_ms = EXCLUDED.counted_at_ms,
            longest_run_ms = EXCLUDED.longest_run_ms`,
    [tenantId, viewIds, names, counted, countedAt, longest],
  );
  return viewIds.length;
}
