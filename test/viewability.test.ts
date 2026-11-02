import { describe, expect, it } from 'vitest';
import {
  defaultStrategies,
  evaluate,
  evaluateAll,
  type Strategy,
  type ViewEvent,
} from '../src/viewability.js';

const [firstToken, fullyRendered] = defaultStrategies() as [Strategy, Strategy];

let seq = 0;
const ft = (tsMs: number): ViewEvent => ({ type: 'first_token', tsMs, seq: seq++ });
const rc = (tsMs: number): ViewEvent => ({ type: 'render_complete', tsMs, seq: seq++ });
const end = (tsMs: number): ViewEvent => ({ type: 'view_end', tsMs, seq: seq++ });
const vis = (tsMs: number, visibleFraction: number): ViewEvent => ({
  type: 'visibility',
  tsMs,
  seq: seq++,
  visibleFraction,
});

describe('the rule', () => {
  it('counts an ad that stays in view for the full second after the first token', () => {
    const events = [ft(0), vis(0, 1), end(1500)];
    const v = evaluate(events, firstToken);
    expect(v.counted).toBe(true);
    expect(v.countedAtMs).toBe(1000);
    expect(v.timerStartMs).toBe(0);
  });

  it('counts at exactly minVisibleMs and not one millisecond earlier', () => {
    expect(evaluate([ft(0), vis(0, 1), vis(1000, 0), end(1200)], firstToken).counted).toBe(true);
    expect(evaluate([ft(0), vis(0, 1), vis(999, 0), end(1200)], firstToken).counted).toBe(false);
  });

  it('treats the threshold as inclusive', () => {
    expect(evaluate([ft(0), vis(0, 0.5), end(2000)], firstToken).counted).toBe(true);
    expect(evaluate([ft(0), vis(0, 0.49), end(2000)], firstToken).counted).toBe(false);
  });

  it('requires the second to be continuous', () => {
    const events = [ft(0), vis(0, 1), vis(600, 0), vis(700, 1), vis(1300, 0), end(2000)];
    expect(evaluate(events, firstToken).counted).toBe(false);
    expect(evaluate(events, firstToken).longestRunMs).toBe(600);
  });

  it('credits an open stretch only up to the last event of the view', () => {
    // The last thing the client said was a visible sample at t = 0.
    expect(evaluate([ft(0), vis(0, 1)], firstToken).counted).toBe(false);
    // With a later event the same stretch is credited up to that event.
    expect(evaluate([ft(0), vis(0, 1), end(1500)], firstToken).counted).toBe(true);
  });

  it('lets the later sample win when two samples share a timestamp', () => {
    const hiddenLast = [ft(0), { ...vis(500, 1), seq: 10 }, { ...vis(500, 0), seq: 11 }, end(3000)];
    const visibleLast = [ft(0), { ...vis(500, 0), seq: 10 }, { ...vis(500, 1), seq: 11 }, end(3000)];
    expect(evaluate(hiddenLast, firstToken).counted).toBe(false);
    expect(evaluate(visibleLast, firstToken).counted).toBe(true);
  });

  it('does not count a view that never saw its timer start event', () => {
    const v = evaluate([vis(0, 1), end(5000)], firstToken);
    expect(v).toEqual({ counted: false, countedAtMs: null, timerStartMs: null, longestRunMs: 0 });
  });

  it('does not count an empty view', () => {
    expect(evaluate([], firstToken).counted).toBe(false);
  });

  it('rejects rules that cannot be satisfied or are meaningless', () => {
    const base = { name: 'x', timerStart: 'first-token' as const };
    expect(() => evaluate([], { ...base, threshold: 0, minVisibleMs: 1000 })).toThrow(RangeError);
    expect(() => evaluate([], { ...base, threshold: 1.5, minVisibleMs: 1000 })).toThrow(RangeError);
    expect(() => evaluate([], { ...base, threshold: 0.5, minVisibleMs: 0 })).toThrow(RangeError);
    expect(() => evaluate([], { ...base, threshold: 0.5, minVisibleMs: 1.5 })).toThrow(RangeError);
  });
});

describe('when the timer starts', () => {
  // The text streams in from t = 100 to t = 2600.
  const stream = [ft(100), rc(2600)];

  it('lets first-token count a reader who watched only while the text streamed', () => {
    const events = [...stream, vis(100, 1), vis(2200, 0), end(5000)];
    expect(evaluate(events, firstToken).counted).toBe(true);
    expect(evaluate(events, fullyRendered).counted).toBe(false);
  });

  it('starts fully-rendered at the end of the stream even if the ad was already in view', () => {
    const events = [...stream, vis(100, 1), end(5000)];
    const v = evaluate(events, fullyRendered);
    expect(v.counted).toBe(true);
    expect(v.timerStartMs).toBe(2600);
    expect(v.countedAtMs).toBe(3600);
    expect(evaluate(events, firstToken).countedAtMs).toBe(1100);
  });

  it('gives fully-rendered only the time after completion', () => {
    const events = [...stream, vis(100, 1), vis(3100, 0), end(5000)]; // 500 ms after completion
    expect(evaluate(events, fullyRendered).counted).toBe(false);
    expect(evaluate(events, fullyRendered).longestRunMs).toBe(500);
    expect(evaluate(events, firstToken).counted).toBe(true);
  });

  it('never counts a cancelled stream under fully-rendered', () => {
    const events = [ft(100), vis(100, 1), end(9000)];
    expect(evaluate(events, firstToken).counted).toBe(true);
    const v = evaluate(events, fullyRendered);
    expect(v.counted).toBe(false);
    expect(v.timerStartMs).toBeNull();
  });

  it('counts a reader who scrolls in after the text is complete under both', () => {
    const events = [...stream, vis(100, 0), vis(3000, 1), end(4500)];
    expect(evaluate(events, firstToken).countedAtMs).toBe(4000);
    expect(evaluate(events, fullyRendered).countedAtMs).toBe(4000);
  });

  it('uses the earliest start event when it is reported more than once', () => {
    const events = [ft(300), ft(100), vis(100, 1), end(1200)];
    expect(evaluate(events, firstToken).timerStartMs).toBe(100);
    expect(evaluate(events, firstToken).counted).toBe(true);
  });
});

describe('a different rule', () => {
  it('honours a stricter threshold and a longer duration', () => {
    const strict: Strategy = { name: 'strict', timerStart: 'first-token', threshold: 0.75, minVisibleMs: 2000 };
    const events = [ft(0), vis(0, 0.8), vis(1999, 0.7), end(4000)];
    expect(evaluate(events, strict).counted).toBe(false);
    expect(evaluate([ft(0), vis(0, 0.8), vis(2000, 0.7), end(4000)], strict).counted).toBe(true);
  });

  it('evaluates every strategy under its own name', () => {
    const verdicts = evaluateAll([ft(0), vis(0, 1), end(2000)], defaultStrategies());
    expect([...verdicts.keys()]).toEqual(['first-token', 'fully-rendered']);
    expect(verdicts.get('first-token')!.counted).toBe(true);
    expect(verdicts.get('fully-rendered')!.counted).toBe(false);
  });
});
