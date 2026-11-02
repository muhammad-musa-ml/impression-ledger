import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate, type EventType, type Strategy, type ViewEvent } from '../src/viewability.js';
import { referenceVerdict } from './reference.js';

const MAX_TS = 2500;
const FRACTIONS = [0, 0.2, 0.49, 0.5, 0.51, 0.9, 1];

const strategyArb: fc.Arbitrary<Strategy> = fc.record({
  name: fc.constant('s'),
  timerStart: fc.constantFrom('first-token' as const, 'fully-rendered' as const),
  threshold: fc.constantFrom(0.3, 0.5, 0.75, 1),
  minVisibleMs: fc.integer({ min: 1, max: 600 }),
});

const markerArb = (type: EventType): fc.Arbitrary<ViewEvent> =>
  fc.record({ type: fc.constant(type), tsMs: fc.integer({ min: 0, max: MAX_TS }), seq: fc.nat(40) });

const sampleArb: fc.Arbitrary<ViewEvent> = fc.record({
  type: fc.constant<EventType>('visibility'),
  tsMs: fc.integer({ min: 0, max: MAX_TS }),
  seq: fc.nat(40),
  visibleFraction: fc.constantFrom(...FRACTIONS),
});

/** A view: markers (any of them may be missing or repeated) and a pile of samples, in any order. */
const viewArb: fc.Arbitrary<ViewEvent[]> = fc
  .tuple(
    fc.array(markerArb('first_token'), { maxLength: 2 }),
    fc.array(markerArb('render_complete'), { maxLength: 2 }),
    fc.array(markerArb('view_end'), { maxLength: 1 }),
    fc.array(sampleArb, { maxLength: 25 }),
  )
  .chain((parts) => fc.shuffledSubarray(parts.flat(), { minLength: parts.flat().length }));

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

  it('agrees with a millisecond-by-millisecond reference', () => {
    fc.assert(
      fc.property(viewArb, strategyArb, (events, s) => {
        const real = evaluate(events, s);
        const ref = referenceVerdict(events, s);
        expect({ counted: real.counted, countedAtMs: real.countedAtMs }).toEqual(ref);
      }),
      { numRuns: 1500 },
    );
  });

  it('does not depend on the order the events arrive in', () => {
    fc.assert(
      fc.property(viewArb, strategyArb, fc.nat(), (events, s, salt) => {
        const rotated = events.slice(salt % (events.length + 1)).concat(events.slice(0, salt % (events.length + 1)));
        const reversed = [...events].reverse();
        const base = evaluate(events, s);
        expect(evaluate(rotated, s)).toEqual(base);
        expect(evaluate(reversed, s)).toEqual(base);
      }),
      { numRuns: 800 },
    );
  });

  it('does not change when events are delivered more than once', () => {
    fc.assert(
      fc.property(viewArb, strategyArb, fc.nat(), (events, s, salt) => {
        const some = events.filter((_, i) => (i + salt) % 3 === 0);
        expect(evaluate([...events, ...some, ...events], s)).toEqual(evaluate(events, s));
      }),
      { numRuns: 800 },
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
            .sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq || a.visibleFraction! - b.visibleFraction!)
            .at(-1);
          expect(inEffect?.visibleFraction ?? 0).toBeGreaterThanOrEqual(s.threshold);
        }
      }),
      { numRuns: 400 },
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
      { numRuns: 800 },
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
      { numRuns: 800 },
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
      { numRuns: 800 },
    );
  });
});
