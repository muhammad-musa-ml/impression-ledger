import type { Queryable } from './db.js';
import type { Strategy } from './viewability.js';

export interface AdReport {
  adId: string;
  /** Views with a verdict. */
  views: number;
  /** Counted views per strategy name. */
  counted: Record<string, number>;
}

export interface Report {
  tenant: string;
  strategies: Strategy[];
  ads: AdReport[];
}

/** Counted impressions per ad for one tenant, read from the stored verdicts in one statement. */
export async function buildReport(db: Queryable, tenantId: string, strategies: readonly Strategy[]): Promise<Report> {
  const res = await db.query<{ ad_id: string; strategy: string; views: number; counted: number }>(
    `SELECT v.ad_id,
            r.strategy,
            count(*)::int                           AS views,
            (count(*) FILTER (WHERE r.counted))::int AS counted
       FROM ad_views v
       JOIN view_results r ON r.tenant_id = v.tenant_id AND r.view_id = v.view_id
      WHERE v.tenant_id = $1 AND r.strategy = ANY($2::text[])
      GROUP BY v.ad_id, r.strategy
      ORDER BY v.ad_id, r.strategy`,
    [tenantId, strategies.map((s) => s.name)],
  );
  const ads = new Map<string, AdReport>();
  for (const row of res.rows) {
    let ad = ads.get(row.ad_id);
    if (!ad) {
      ad = { adId: row.ad_id, views: 0, counted: Object.fromEntries(strategies.map((s) => [s.name, 0])) };
      ads.set(row.ad_id, ad);
    }
    ad.views = Math.max(ad.views, row.views);
    ad.counted[row.strategy] = row.counted;
  }
  return { tenant: tenantId, strategies: [...strategies], ads: [...ads.values()] };
}
