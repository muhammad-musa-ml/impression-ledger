import type { Pool } from './db.js';
import { loadViewEvents, upsertResults } from './results.js';
import type { Strategy } from './viewability.js';

const CHUNK = 500;

/**
 * Rebuilds view_results from the stored events. Use it after changing a
 * strategy's threshold or duration: the events are kept as received, so the
 * same traffic can be counted under new rules.
 */
export async function recomputeAll(pool: Pool, strategies: readonly Strategy[]): Promise<{ views: number; rows: number }> {
  const tenants = await pool.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ad_views ORDER BY tenant_id`);
  let views = 0;
  let rows = 0;
  for (const { tenant_id: tenantId } of tenants.rows) {
    let after = '';
    for (;;) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Lock the chunk's view rows, as ingestion does, so a batch arriving
        // now waits for this chunk instead of being overwritten by it.
        const chunk = await client.query<{ view_id: string }>(
          `SELECT view_id FROM ad_views
            WHERE tenant_id = $1 AND view_id > $2
            ORDER BY view_id
            LIMIT ${CHUNK}
              FOR UPDATE`,
          [tenantId, after],
        );
        const ids = chunk.rows.map((r) => r.view_id);
        if (ids.length > 0) {
          const events = await loadViewEvents(client, tenantId, ids);
          rows += await upsertResults(client, tenantId, events, strategies);
          views += events.size;
        }
        await client.query('COMMIT');
        if (ids.length < CHUNK) break;
        after = ids[ids.length - 1]!;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  }
  return { views, rows };
}
