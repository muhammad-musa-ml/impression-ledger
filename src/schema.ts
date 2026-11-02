import { z } from 'zod';
import type { EventType } from './viewability.js';

export const MAX_BATCH_EVENTS = 500;
const INT4_MAX = 2_147_483_647;

export interface LedgerEvent {
  /** Idempotency key. Unique within a tenant; the client must reuse it on every retry. */
  eventId: string;
  viewId: string;
  adId: string;
  type: EventType;
  tsMs: number;
  seq: number;
  visibleFraction?: number;
}

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, 'must be 1 to 128 characters of A-Z a-z 0-9 . _ : -');
const int = z.number().int().min(0).max(INT4_MAX);

const common = { eventId: id, viewId: id, adId: id, tsMs: int, seq: int };

export const EventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('first_token') }),
  z.strictObject({ ...common, type: z.literal('render_complete') }),
  z.strictObject({ ...common, type: z.literal('view_end') }),
  z.strictObject({ ...common, type: z.literal('visibility'), visibleFraction: z.number().min(0).max(1) }),
]);

export const BatchSchema = z.strictObject({
  events: z.array(EventSchema).min(1).max(MAX_BATCH_EVENTS),
});

export type Batch = z.infer<typeof BatchSchema>;
