// Synthetic ad traffic with a known answer.
//
// Every view is built from a scenario that was designed to land on one side of
// each strategy's rule with a wide margin, so the expected outcome is written
// down here, next to the scenario, and not computed by the counter. The drill
// compares the database with these expectations. A test checks that the counter
// agrees with them too.
//
// The margins assume the default rule: 0.5 of the ad in view for 1000 ms.
// Nothing here comes from real traffic.

import type { LedgerEvent } from './schema.js';
import type { EventType } from './viewability.js';

export type Rng = () => number;

/** mulberry32: a small seeded generator, enough for reproducible test data. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

export interface Expectation {
  'first-token': boolean;
  'fully-rendered': boolean;
}

export interface ViewTruth {
  tenant: string;
  viewId: string;
  adId: string;
  scenario: string;
  expect: Expectation;
}

export interface SyntheticEvent {
  tenant: string;
  event: LedgerEvent;
}

export interface Dataset {
  events: SyntheticEvent[];
  views: ViewTruth[];
}

interface Segment {
  from: number;
  to: number;
  /** Fraction reported for each sample in this segment; a function so a dwelling reader can vary it. */
  fraction: () => number;
}

interface Plan {
  scenario: string;
  firstTokenAt: number;
  renderCompleteAt: number | null;
  endAt: number;
  segments: Segment[];
  expect: Expectation;
}

const VISIBLE = [0.5, 0.6, 0.8, 1];
const HIDDEN = [0, 0.1, 0.3, 0.45];

function constant(x: number): () => number {
  return () => x;
}

const SCENARIOS: { name: string; weight: number; plan: (rng: Rng) => Plan }[] = [
  {
    // Stays in view from the first token well past the end of the stream.
    name: 'dwell',
    weight: 25,
    plan: (rng) => {
      const f = int(rng, 50, 400);
      const c = f + int(rng, 900, 3000);
      return {
        scenario: 'dwell',
        firstTokenAt: f,
        renderCompleteAt: c,
        endAt: c + 3000,
        segments: [{ from: f, to: c + 3000, fraction: () => pick(rng, VISIBLE) }],
        expect: { 'first-token': true, 'fully-rendered': true },
      };
    },
  },
  {
    // A short look and gone.
    name: 'glance',
    weight: 15,
    plan: (rng) => {
      const f = int(rng, 50, 400);
      const c = f + int(rng, 900, 3000);
      return {
        scenario: 'glance',
        firstTokenAt: f,
        renderCompleteAt: c,
        endAt: c + 2000,
        segments: [
          { from: f, to: f + 400, fraction: constant(pick(rng, VISIBLE)) },
          { from: f + 400, to: c + 2000, fraction: constant(pick(rng, HIDDEN)) },
        ],
        expect: { 'first-token': false, 'fully-rendered': false },
      };
    },
  },
  {
    // Watched while the text streamed in, scrolled away before it finished.
    name: 'during-stream',
    weight: 10,
    plan: (rng) => {
      const f = int(rng, 50, 400);
      const c = f + int(rng, 2000, 3000);
      return {
        scenario: 'during-stream',
        firstTokenAt: f,
        renderCompleteAt: c,
        endAt: c + 2500,
        segments: [
          { from: f, to: c - 400, fraction: constant(pick(rng, VISIBLE)) },
          { from: c - 400, to: c + 2500, fraction: constant(pick(rng, HIDDEN)) },
        ],
        expect: { 'first-token': true, 'fully-rendered': false },
      };
    },
  },
  {
    // Stays 500 ms past the end of the stream: enough with the clock running
    // from the first token, not enough with the clock running from the end.
    name: 'just-past-complete',
    weight: 8,
    plan: (rng) => {
      const f = int(rng, 50, 400);
      const c = f + int(rng, 900, 3000);
      return {
        scenario: 'just-past-complete',
        firstTokenAt: f,
        renderCompleteAt: c,
        endAt: c + 2500,
        segments: [
          { from: f, to: c + 500, fraction: constant(pick(rng, VISIBLE)) },
          { from: c + 500, to: c + 2500, fraction: constant(pick(rng, HIDDEN)) },
        ],
        expect: { 'first-token': true, 'fully-rendered': false },
      };
    },
  },
  {
    // Fully on screen, but never enough of it.
    name: 'below-threshold',
    weight: 10,
    plan: (rng) => {
      const f = int(rng, 50, 400);
      const c = f + int(rng, 900, 3000);
      return {
        scenario: 'below-threshold',
        firstTokenAt: f,
        renderCompleteAt: c,
        endAt: c + 4000,
        segments: [{ from: f, to: c + 4000, fraction: () => pick(rng, [0.3, 0.45, 0.49]) }],
        expect: { 'first-token': false, 'fully-rendered': false },
      };
    },
  },
  {
    // In and out: 600 ms visible, 300 ms hidden, over and over. Never one second in a row.
    name: 'flicker',
    weight: 7,
    plan: (rng) => {
      const f = int(rng, 50, 400);
      const c = f + int(rng, 900, 3000);
      const segments: Segment[] = [];
      let t = f;
      while (t < f + 6000) {
        segments.push({ from: t, to: t + 600, fraction: constant(pick(rng, VISIBLE)) });
        segments.push({ from: t + 600, to: t + 900, fraction: constant(pick(rng, HIDDEN)) });
        t += 900;
      }
      return {
        scenario: 'flicker',
        firstTokenAt: f,
        renderCompleteAt: c,
        endAt: t,
        segments,
        expect: { 'first-token': false, 'fully-rendered': false },
      };
    },
  },
  {
    // The stream was cancelled: there is a first token and no end to the text.
    name: 'cancelled',
    weight: 8,
    plan: (rng) => {
      const f = int(rng, 50, 400);
      return {
        scenario: 'cancelled',
        firstTokenAt: f,
        renderCompleteAt: null,
        endAt: f + 3500,
        segments: [
          { from: f, to: f + 2500, fraction: constant(pick(rng, VISIBLE)) },
          { from: f + 2500, to: f + 3500, fraction: constant(pick(rng, HIDDEN)) },
        ],
        expect: { 'first-token': true, 'fully-rendered': false },
      };
    },
  },
  {
    // Scrolled into view after the text was complete, then read for a while.
    name: 'late-scroll-in',
    weight: 10,
    plan: (rng) => {
      const f = int(rng, 50, 400);
      const c = f + int(rng, 900, 3000);
      return {
        scenario: 'late-scroll-in',
        firstTokenAt: f,
        renderCompleteAt: c,
        endAt: c + 2600,
        segments: [
          { from: f, to: c + 800, fraction: constant(pick(rng, HIDDEN)) },
          { from: c + 800, to: c + 2600, fraction: constant(pick(rng, VISIBLE)) },
        ],
        expect: { 'first-token': true, 'fully-rendered': true },
      };
    },
  },
  {
    // In view for 900 ms after the text was complete: under a second either way.
    name: 'brief-after-complete',
    weight: 7,
    plan: (rng) => {
      const f = int(rng, 50, 400);
      const c = f + int(rng, 900, 3000);
      return {
        scenario: 'brief-after-complete',
        firstTokenAt: f,
        renderCompleteAt: c,
        endAt: c + 2000,
        segments: [
          { from: f, to: c, fraction: constant(pick(rng, HIDDEN)) },
          { from: c, to: c + 900, fraction: constant(pick(rng, VISIBLE)) },
          { from: c + 900, to: c + 2000, fraction: constant(pick(rng, HIDDEN)) },
        ],
        expect: { 'first-token': false, 'fully-rendered': false },
      };
    },
  },
];

const TOTAL_WEIGHT = SCENARIOS.reduce((n, s) => n + s.weight, 0);

function pickScenario(rng: Rng): (typeof SCENARIOS)[number] {
  let x = rng() * TOTAL_WEIGHT;
  for (const s of SCENARIOS) {
    x -= s.weight;
    if (x < 0) return s;
  }
  return SCENARIOS[0]!;
}

export const SCENARIO_NAMES = SCENARIOS.map((s) => s.name);

const RANK: Record<EventType, number> = { first_token: 0, render_complete: 1, visibility: 2, view_end: 3 };

interface Raw {
  type: EventType;
  tsMs: number;
  visibleFraction?: number;
}

/** Events of one view in the order the client would have emitted them. */
function emitView(plan: Plan, rng: Rng): Raw[] {
  const raw: Raw[] = [{ type: 'first_token', tsMs: plan.firstTokenAt }];
  if (plan.renderCompleteAt !== null) raw.push({ type: 'render_complete', tsMs: plan.renderCompleteAt });
  for (const seg of plan.segments) {
    // A sample where the segment starts, then a heartbeat about every 400 ms.
    raw.push({ type: 'visibility', tsMs: seg.from, visibleFraction: seg.fraction() });
    for (let t = seg.from + int(rng, 350, 450); t < seg.to; t += int(rng, 350, 450)) {
      raw.push({ type: 'visibility', tsMs: t, visibleFraction: seg.fraction() });
    }
  }
  raw.push({ type: 'view_end', tsMs: plan.endAt });
  return raw.sort((a, b) => a.tsMs - b.tsMs || RANK[a.type] - RANK[b.type]);
}

export function generateDataset(opts: {
  seed: number;
  tenants: readonly string[];
  viewsPerTenant: number;
  ads?: number;
}): Dataset {
  const rng = makeRng(opts.seed);
  const adCount = opts.ads ?? 12;
  const events: SyntheticEvent[] = [];
  const views: ViewTruth[] = [];
  opts.tenants.forEach((tenant, ti) => {
    for (let i = 0; i < opts.viewsPerTenant; i++) {
      const scenario = pickScenario(rng);
      const plan = scenario.plan(rng);
      const viewId = `v${ti}-${i}`;
      const adId = `ad-${String(int(rng, 1, adCount)).padStart(2, '0')}`;
      views.push({ tenant, viewId, adId, scenario: plan.scenario, expect: plan.expect });
      emitView(plan, rng).forEach((r, seq) => {
        const event: LedgerEvent = {
          eventId: `${viewId}.${seq}`,
          viewId,
          adId,
          type: r.type,
          tsMs: r.tsMs,
          seq,
          ...(r.visibleFraction === undefined ? {} : { visibleFraction: r.visibleFraction }),
        };
        events.push({ tenant, event });
      });
    }
  });
  return { events, views };
}

export interface Batch {
  tenant: string;
  events: LedgerEvent[];
  /** True when this batch is a verbatim resend of an earlier one. */
  replay: boolean;
}

export interface DeliveryPlan {
  batches: Batch[];
  distinctEvents: number;
  deliveries: number;
  duplicateDeliveries: number;
  replayedBatches: number;
}

export function shuffle<T>(xs: T[], rng: Rng): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

/**
 * Turns a dataset into the batches a flaky client would send: events of
 * different views interleaved and out of time order, a share of the events
 * delivered twice in different batches, and a share of whole batches sent again.
 */
export function planDelivery(
  dataset: Dataset,
  opts: { seed: number; batchSize: number; duplicateShare: number; replayShare: number },
): DeliveryPlan {
  const rng = makeRng(opts.seed ^ 0x9e3779b9);
  const tenants = [...new Set(dataset.events.map((e) => e.tenant))];
  const batches: Batch[] = [];
  let deliveries = 0;
  let duplicateDeliveries = 0;
  for (const tenant of tenants) {
    const mine = dataset.events.filter((e) => e.tenant === tenant).map((e) => e.event);
    const stream = [...mine];
    for (const e of mine) {
      if (rng() < opts.duplicateShare) {
        stream.push(e);
        duplicateDeliveries++;
      }
    }
    shuffle(stream, rng);
    deliveries += stream.length;
    for (let i = 0; i < stream.length; i += opts.batchSize) {
      batches.push({ tenant, events: stream.slice(i, i + opts.batchSize), replay: false });
    }
  }
  shuffle(batches, rng);
  // A replay is inserted somewhere after the batch it repeats.
  const withReplays = [...batches];
  let replayedBatches = 0;
  for (const original of batches) {
    if (rng() < opts.replayShare) {
      const after = withReplays.indexOf(original) + 1;
      const at = after + Math.floor(rng() * (withReplays.length - after + 1));
      withReplays.splice(at, 0, { tenant: original.tenant, events: original.events, replay: true });
      replayedBatches++;
      deliveries += original.events.length;
      duplicateDeliveries += original.events.length;
    }
  }
  return {
    batches: withReplays,
    distinctEvents: dataset.events.length,
    deliveries,
    duplicateDeliveries,
    replayedBatches,
  };
}

export interface ExpectedAd {
  adId: string;
  views: number;
  counted: Record<keyof Expectation, number>;
}

/** What the report endpoint should say, from the designed expectations. */
export function expectedReport(dataset: Dataset): Map<string, Map<string, ExpectedAd>> {
  const out = new Map<string, Map<string, ExpectedAd>>();
  for (const v of dataset.views) {
    let ads = out.get(v.tenant);
    if (!ads) out.set(v.tenant, (ads = new Map()));
    let ad = ads.get(v.adId);
    if (!ad) ads.set(v.adId, (ad = { adId: v.adId, views: 0, counted: { 'first-token': 0, 'fully-rendered': 0 } }));
    ad.views++;
    if (v.expect['first-token']) ad.counted['first-token']++;
    if (v.expect['fully-rendered']) ad.counted['fully-rendered']++;
  }
  return out;
}
