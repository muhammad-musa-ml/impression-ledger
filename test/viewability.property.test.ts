import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate, type EventType, type Strategy, type ViewEvent } from '../src/viewability.js';
import { referenceVerdict } from './reference.js';

const FRACTIONS = [0, 0.2, 0.49, 0.5, 0.51, 0.9, 1];

/** FC_RUNS=<n> raises every run count to at least n, for a one-off wider sweep. */
const runs = (n: number): number => Math.max(n, Number(process.env['FC_RUNS'] ?? 0));

const strategyArb: fc.Arbitrary<Strategy> = fc.record({
  name: fc.constant('s'),
  timerStart: fc.constantFrom('first-token' as const, 'fully-rendered' as const),
  threshold: fc.constantFrom(0.3, 0.5, 0.75, 1),
  minVisibleMs: fc.integer({ min: 1, max: 600 }),
});

// Short rules, to go with the packed views below.
const shortStrategyArb: fc.Arbitrary<Strategy> = fc.record({
  name: fc.constant('s'),
  timerStart: fc.constantFrom('first-token' as const, 'fully-rendered' as const),
  threshold: fc.constantFrom(0.3, 0.5, 0.75, 1),
  minVisibleMs: fc.integer({ min: 1, max: 40 }),
});

/**
 * A view: markers (any of them may be missing or repeated) and a pile of samples, in any order.
 * Times run from 0 to maxTs and sequence numbers from 0 to maxSeq, so a small maxTs and maxSeq
 * packs many samples into the same millisecond and gives some of them the same sequence number.
 */
const viewArbOf = (maxTs: number, maxSeq: number): fc.Arbitrary<ViewEvent[]> => {
  const marker = (type: EventType): fc.Arbitrary<ViewEvent> =>
    fc.record({ type: fc.constant(type), tsMs: fc.integer({ min: 0, max: maxTs }), seq: fc.nat(maxSeq) });
  const sample: fc.Arbitrary<ViewEvent> = fc.record({
    type: fc.constant<EventType>('visibility'),
    tsMs: fc.integer({ min: 0, max: maxTs }),
    seq: fc.nat(maxSeq),
    visibleFraction: fc.constantFrom(...FRACTIONS),
  });
  return fc
    .tuple(
      fc.array(marker('first_token'), { maxLength: 2 }),
      fc.array(marker('render_complete'), { maxLength: 2 }),
      fc.array(marker('view_end'), { maxLength: 1 }),
      fc.array(sample, { maxLength: 25 }),
    )
    .chain((parts) => fc.shuffledSubarray(parts.flat(), { minLength: parts.flat().length }));
};

const viewArb = viewArbOf(2500, 40);
const packedViewArb = viewArbOf(60, 3);
const sampleArb: fc.Arbitrary<ViewEvent> = fc.record({
  type: fc.constant<EventType>('visibility'),
  tsMs: fc.integer({ min: 0, max: 2500 }),
  seq: fc.nat(40),
  visibleFraction: fc.constantFrom(...FRACTIONS),
});

const horizon = (events: readonly ViewEvent[]): number => Math.max(0, ...events.map((e) => e.tsMs));

describe('properties of the counter', () => {
  it('produces both outcomes, so the properties below are not vacuous', () => {
    const verdicts = fc
      .sample(fc.tuple(viewArb, strategyArb), { numRuns: 400, seed: 7 })
      .map(([events, s]) => evaluate(events, s).counted);
    const counted = verdicts.filter(Boolean).length;
    expect(counted).toBeGreaterThan(40);
    expect(verdicts.length - counted).toBeGreaterThan(40);
  });

  const families = [
    { name: 'spread over 2.5 s', views: viewArb, strategies: strategyArb },
    { name: 'packed into 60 ms, with repeated sequence numbers', views: packedViewArb, strategies: shortStrategyArb },
  ] as const;

  it.each(families)('agrees with a millisecond-by-millisecond reference: $name', ({ views, strategies }) => {
    fc.assert(
      fc.property(views, strategies, (events, s) => {
        const real = evaluate(events, s);
        const ref = referenceVerdict(events, s);
        expect({ counted: real.counted, countedAtMs: real.countedAtMs }).toEqual(ref);
      }),
      { numRuns: runs(1500) },
    );
  });

  it.each(families)('does not depend on the order the events arrive in: $name', ({ views, strategies }) => {
    fc.assert(
      fc.property(views, strategies, fc.nat(), (events, s, salt) => {
        const rotated = events.slice(salt % (events.length + 1)).concat(events.slice(0, salt % (events.length + 1)));
        const reversed = [...events].reverse();
        const base = evaluate(events, s);
        expect(evaluate(rotated, s)).toEqual(base);
        expect(evaluate(reversed, s)).toEqual(base);
      }),
      { numRuns: runs(800) },
    );
  });

  it.each(families)('does not change when events are delivered more than once: $name', ({ views, strategies }) => {
    fc.assert(
      fc.property(views, strategies, fc.nat(), (events, s, salt) => {
        const some = events.filter((_, i) => (i + salt) % 3 === 0);
        expect(evaluate([...events, ...some, ...events], s)).toEqual(evaluate(events, s));
      }),
      { numRuns: runs(800) },
    );
  });

  it('never counts before the timer has started and the threshold has been held for the full time', () => {
    fc.assert(
      fc.property(viewArb, strategyArb, (events, s) => {
        const v = evaluate(events, s);
        if (!v.counted) {
          expect(v.countedAtMs).toBeNull();
          return;
        }
        expect(v.timerStartMs).not.toBeNull();
        expect(v.countedAtMs!).toBeGreaterThanOrEqual(v.timerStartMs! + s.minVisibleMs);
        expect(v.countedAtMs!).toBeLessThanOrEqual(horizon(events));
        // Every millisecond of the window that ended at countedAtMs was at or above the threshold.
        for (let t = v.countedAtMs! - s.minVisibleMs; t < v.countedAtMs!; t++) {
          const inEffect = events
            .filter((e) => e.type === 'visibility' && e.tsMs <= t)
            .sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq || b.visibleFraction! - a.visibleFraction!)
            .at(-1);
          expect(inEffect?.visibleFraction ?? 0).toBeGreaterThanOrEqual(s.threshold);
        }
      }),
      { numRuns: runs(400) },
    );
  });

  it('counts fewer views when the threshold goes up or the duration goes up', () => {
    fc.assert(
      fc.property(viewArb, strategyArb, (events, s) => {
        const harderThreshold = { ...s, threshold: Math.min(1, s.threshold + 0.25) };
        const longer = { ...s, minVisibleMs: s.minVisibleMs + 200 };
        const base = evaluate(events, s).counted;
        if (evaluate(events, harderThreshold).counted) expect(base).toBe(true);
        if (evaluate(events, longer).counted) expect(base).toBe(true);
      }),
      { numRuns: runs(800) },
    );
  });

  it('never counts fewer views with first-token than with fully-rendered when the stream ends after it starts', () => {
    const ordered = viewArb.filter((events) => {
      const firsts = events.filter((e) => e.type === 'first_token').map((e) => e.tsMs);
      const ends = events.filter((e) => e.type === 'render_complete').map((e) => e.tsMs);
      return firsts.length > 0 && ends.length > 0 && Math.min(...firsts) <= Math.min(...ends);
    });
    fc.assert(
      fc.property(ordered, strategyArb, (events, s) => {
        const early = evaluate(events, { ...s, timerStart: 'first-token' });
        const late = evaluate(events, { ...s, timerStart: 'fully-rendered' });
        if (late.counted) expect(early.counted).toBe(true);
        if (late.counted && early.counted) expect(early.countedAtMs!).toBeLessThanOrEqual(late.countedAtMs!);
      }),
      { numRuns: runs(800) },
    );
  });

  it('never uncounts a view when later events arrive', () => {
    fc.assert(
      fc.property(viewArb, strategyArb, fc.array(sampleArb, { maxLength: 6 }), (events, s, more) => {
        const h = horizon(events);
        const later = more.map((e) => ({ ...e, tsMs: h + e.tsMs }));
        const before = evaluate(events, s);
        const after = evaluate([...events, ...later], s);
        if (before.counted) {
          expect(after.counted).toBe(true);
          expect(after.countedAtMs).toBe(before.countedAtMs);
        }
      }),
      { numRuns: runs(800) },
    );
  });
});
