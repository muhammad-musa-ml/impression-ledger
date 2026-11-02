import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from './db.js';
import type { LedgerEvent } from './schema.js';
import { loadViewEvents, upsertResults } from './results.js';
import type { Strategy } from './viewability.js';

export interface IngestResult {
  /** Rows written by this call. */
  accepted: number;
  /** Events already stored with identical content, and repeats inside the batch. */
  duplicates: number;
  /** Event ids already stored (or repeated in the batch) with different content. Never overwritten. */
  conflicts: string[];
  rejected: { eventId: string; reason: string }[];
  /** Times the transaction was rolled back by a deadlock or serialisation failure and run again. */
  retries: number;
}

export interface TxnInfo {
  txn: number;
  tenantId: string;
  events: number;
}

export interface IngestOptions {
  strategies: readonly Strategy[];
  /** Fault-injection hook: wait this long between the last write and COMMIT. */
  holdBeforeCommitMs?: number;
  /** Fault-injection hook: wait this long after COMMIT before returning, so the reply is late. */
  holdAfterCommitMs?: number;
  onTxnOpen?: (info: TxnInfo) => void;
  onTxnEnd?: (info: TxnInfo, outcome: 'commit' | 'rollback') => void;
}

const MAX_RETRIES = 8;
let txnCounter = 0;

export function bodyHash(e: LedgerEvent): string {
  const canonical = JSON.stringify([e.viewId, e.adId, e.type, e.tsMs, e.seq, e.visibleFraction ?? null]);
  return createHash('sha256').update(canonical).digest('hex');
}

interface Prepared {
  event: LedgerEvent;
  hash: string;
}

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '40P01' || code === '40001'; // deadlock_detected, serialization_failure
}

/**
 * Stores a batch of events for one tenant and updates the verdicts of every
 * view the batch touched, all in one transaction.
 *
 * Why it is safe to retry, and to run twice at once:
 *  - (tenant_id, event_id) is the primary key and the insert is ON CONFLICT DO
 *    NOTHING, so an event that is already stored is skipped, not stored again.
 *  - The ad_views row of every touched view is locked, in view id order, before
 *    any event is written. Two batches that carry events of the same view run
 *    one after the other, and the one that runs second reads the first one's
 *    committed events when it recomputes the verdict. Locking in a fixed order
 *    keeps two such batches from deadlocking on each other.
 *  - Events and verdicts commit together. A process killed before COMMIT leaves
 *    nothing behind, and the client resends the same batch.
 */
export async function ingestBatch(
  pool: Pool,
  tenantId: string,
  events: readonly LedgerEvent[],
  opts: IngestOptions,
): Promise<IngestResult> {
  const conflicts = new Set<string>();
  const rejected: IngestResult['rejected'] = [];
  let duplicates = 0;

  // Repeats inside one batch: identical ones are duplicates, differing ones conflict.
  const byId = new Map<string, Prepared>();
  for (const event of events) {
    const hash = bodyHash(event);
    const seen = byId.get(event.eventId);
    if (!seen) byId.set(event.eventId, { event, hash });
    else if (seen.hash === hash) duplicates++;
    else conflicts.add(event.eventId);
  }

  // One ad per view. The first event of a view in this batch names it; a stored
  // view row (checked under the lock below) overrides that.
  const adOfView = new Map<string, string>();
  const candidates: Prepared[] = [];
  for (const p of byId.values()) {
    const ad = adOfView.get(p.event.viewId);
    if (ad === undefined) adOfView.set(p.event.viewId, p.event.adId);
    if (ad !== undefined && ad !== p.event.adId) rejected.push({ eventId: p.event.eventId, reason: 'ad_mismatch' });
    else candidates.push(p);
  }
  const viewIds = [...adOfView.keys()].sort();
  const viewAds = viewIds.map((v) => adOfView.get(v)!);

  let retries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const run = await runOnce();
      return {
        accepted: run.accepted,
        duplicates: duplicates + run.duplicates,
        conflicts: [...conflicts, ...run.conflicts],
        rejected: [...rejected, ...run.rejected],
        retries,
      };
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_RETRIES) throw err;
      retries++;
      await sleep(5 * 2 ** attempt + Math.floor(Math.random() * 10));
    }
  }

  async function runOnce(): Promise<{
    accepted: number;
    duplicates: number;
    conflicts: string[];
    rejected: IngestResult['rejected'];
  }> {
    const client = await pool.connect();
    const info: TxnInfo = { txn: ++txnCounter, tenantId, events: candidates.length };
    let opened = false;
    let ended = false;
    try {
      await client.query('BEGIN');

      // Create missing view rows, then lock all of them. Both statements walk
      // the views in sorted order.
      await client.query(
        `INSERT INTO ad_views (tenant_id, view_id, ad_id)
         SELECT $1, v.view_id, v.ad_id
           FROM unnest($2::text[], $3::text[]) AS v(view_id, ad_id)
          ORDER BY v.view_id
         ON CONFLICT (tenant_id, view_id) DO NOTHING`,
        [tenantId, viewIds, viewAds],
      );
      const locked = await client.query<{ view_id: string; ad_id: string }>(
        `SELECT view_id, ad_id FROM ad_views
          WHERE tenant_id = $1 AND view_id = ANY($2::text[])
          ORDER BY view_id
            FOR UPDATE`,
        [tenantId, viewIds],
      );
      const storedAd = new Map(locked.rows.map((r) => [r.view_id, r.ad_id]));

      const toInsert: Prepared[] = [];
      const rejectedHere: IngestResult['rejected'] = [];
      for (const p of candidates) {
        if (storedAd.get(p.event.viewId) === p.event.adId) toInsert.push(p);
        else rejectedHere.push({ eventId: p.event.eventId, reason: 'ad_mismatch' });
      }

      const inserted = await client.query<{ event_id: string; view_id: string }>(
        `INSERT INTO events (tenant_id, event_id, view_id, ad_id, type, ts_ms, seq, visible_fraction, body_hash)
         SELECT $1, e.event_id, e.view_id, e.ad_id, e.type, e.ts_ms, e.seq, e.visible_fraction, e.body_hash
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::float8[], $9::text[])
                AS e(event_id, view_id, ad_id, type, ts_ms, seq, visible_fraction, body_hash)
         ON CONFLICT (tenant_id, event_id) DO NOTHING
         RETURNING event_id, view_id`,
        [
          tenantId,
          toInsert.map((p) => p.event.eventId),
          toInsert.map((p) => p.event.viewId),
          toInsert.map((p) => p.event.adId),
          toInsert.map((p) => p.event.type),
          toInsert.map((p) => p.event.tsMs),
          toInsert.map((p) => p.event.seq),
          toInsert.map((p) => p.event.visibleFraction ?? null),
          toInsert.map((p) => p.hash),
        ],
      );

      // Events the insert skipped: same content is a duplicate, different content a conflict.
      const written = new Set(inserted.rows.map((r) => r.event_id));
      const skipped = toInsert.filter((p) => !written.has(p.event.eventId));
      let existingDuplicates = 0;
      const existingConflicts: string[] = [];
      if (skipped.length > 0) {
        const stored = await client.query<{ event_id: string; body_hash: string }>(
          `SELECT event_id, body_hash FROM events WHERE tenant_id = $1 AND event_id = ANY($2::text[])`,
          [tenantId, skipped.map((p) => p.event.eventId)],
        );
        const hashOf = new Map(stored.rows.map((r) => [r.event_id, r.body_hash]));
        for (const p of skipped) {
          const storedHash = hashOf.get(p.event.eventId);
          if (storedHash === undefined) throw new Error(`event ${p.event.eventId} was skipped but is not stored`);
          if (storedHash === p.hash) existingDuplicates++;
          else existingConflicts.push(p.event.eventId);
        }
      }

      // Recompute the views that gained events, from all of their stored events.
      const touched = [...new Set(inserted.rows.map((r) => r.view_id))].sort();
      if (touched.length > 0) {
        const eventsByView = await loadViewEvents(client, tenantId, touched);
        await upsertResults(client, tenantId, eventsByView, opts.strategies);
      }

      opened = true;
      opts.onTxnOpen?.(info);
      const hold = opts.holdBeforeCommitMs ?? 0;
      if (hold > 0) await sleep(hold);

      await client.query('COMMIT');
      ended = true;
      opts.onTxnEnd?.(info, 'commit');
      const holdAfter = opts.holdAfterCommitMs ?? 0;
      if (holdAfter > 0) await sleep(holdAfter);
      return {
        accepted: inserted.rows.length,
        duplicates: existingDuplicates,
        conflicts: existingConflicts,
        rejected: rejectedHere,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
      if (opened && !ended) opts.onTxnEnd?.(info, 'rollback');
    }
  }
}
