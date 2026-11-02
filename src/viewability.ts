// Viewability counting for one ad view.
//
// A view is one showing of one streamed ad. The client reports four kinds of
// events about it:
//
//   first_token      the first token of the ad text was rendered
//   render_complete  the last token was rendered
//   visibility       the fraction of the ad that is inside the viewport changed
//                    (or was re-reported by a heartbeat)
//   view_end         the client stopped reporting
//
// All times are milliseconds since the view started on the client's own clock.
// A visibility sample holds from its time until the next sample. If several
// samples share a time, the one with the highest sequence number is the one in
// effect (for equal sequence numbers, the one with the lowest fraction); the
// others hold for no time at all and cannot end a stretch.
//
// A view is counted when the ad stays at or above the visibility threshold for
// minVisibleMs without a break, and the clock for that stretch may not start
// before the strategy's timer start:
//
//   first-token      the timer starts at the first first_token event
//   fully-rendered   the timer starts at the first render_complete event
//
// A visible stretch that began before the timer start is credited from the
// timer start. An open stretch (no later sample ends it) is credited up to the
// latest event of the view and no further: the counter never assumes the ad was
// still on screen after the client's last report.
//
// The result depends only on the set of events, not on the order they are
// passed in, and passing an event twice changes nothing.

export type EventType = 'first_token' | 'render_complete' | 'visibility' | 'view_end';

export interface ViewEvent {
  readonly type: EventType;
  readonly tsMs: number;
  readonly seq: number;
  readonly visibleFraction?: number | undefined;
}

export type TimerStart = 'first-token' | 'fully-rendered';

export interface Strategy {
  readonly name: string;
  readonly timerStart: TimerStart;
  /** Fraction of the ad that must be in view, inclusive. In (0, 1]. */
  readonly threshold: number;
  /** Continuous time at or above the threshold, inclusive. Positive. */
  readonly minVisibleMs: number;
}

export interface Verdict {
  readonly counted: boolean;
  /** Time at which the view reached minVisibleMs; null when not counted. */
  readonly countedAtMs: number | null;
  /** Where the strategy's clock starts; null when the event it needs never arrived. */
  readonly timerStartMs: number | null;
  /** Longest qualifying stretch seen, after clipping to the timer start. */
  readonly longestRunMs: number;
}

const TYPE_RANK: Record<EventType, number> = {
  first_token: 0,
  render_complete: 1,
  visibility: 2,
  view_end: 3,
};

/**
 * Total order on events, so the result cannot depend on the order of input.
 * Where two samples share both time and sequence number the lower fraction
 * sorts last, and the last sample at an instant is the one in effect.
 */
export function compareEvents(a: ViewEvent, b: ViewEvent): number {
  return (
    a.tsMs - b.tsMs ||
    a.seq - b.seq ||
    TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
    (b.visibleFraction ?? -1) - (a.visibleFraction ?? -1)
  );
}

export function defaultStrategies(threshold = 0.5, minVisibleMs = 1000): Strategy[] {
  return [
    { name: 'first-token', timerStart: 'first-token', threshold, minVisibleMs },
    { name: 'fully-rendered', timerStart: 'fully-rendered', threshold, minVisibleMs },
  ];
}

export function validateStrategy(s: Strategy): void {
  if (!(s.threshold > 0 && s.threshold <= 1)) {
    throw new RangeError(`strategy ${s.name}: threshold must be in (0, 1], got ${s.threshold}`);
  }
  if (!Number.isInteger(s.minVisibleMs) || s.minVisibleMs <= 0) {
    throw new RangeError(`strategy ${s.name}: minVisibleMs must be a positive integer, got ${s.minVisibleMs}`);
  }
}

function timerStartOf(sorted: readonly ViewEvent[], mode: TimerStart): number | null {
  const wanted: EventType = mode === 'first-token' ? 'first_token' : 'render_complete';
  for (const e of sorted) {
    if (e.type === wanted) return e.tsMs; // sorted by time, so the first match is the earliest
  }
  return null;
}

export function evaluate(events: readonly ViewEvent[], strategy: Strategy): Verdict {
  validateStrategy(strategy);
  const sorted = [...events].sort(compareEvents);
  const timerStartMs = timerStartOf(sorted, strategy.timerStart);
  if (timerStartMs === null || sorted.length === 0) {
    return { counted: false, countedAtMs: null, timerStartMs, longestRunMs: 0 };
  }
  const horizonMs = sorted[sorted.length - 1]!.tsMs;

  let countedAtMs: number | null = null;
  let longestRunMs = 0;
  const closeRun = (startMs: number, endMs: number): void => {
    const from = Math.max(startMs, timerStartMs);
    const length = endMs - from;
    if (length <= 0) return;
    if (length > longestRunMs) longestRunMs = length;
    if (countedAtMs === null && length >= strategy.minVisibleMs) {
      countedAtMs = from + strategy.minVisibleMs;
    }
  };

  // Several samples can carry the same time. Only the last of them is in effect, for the
  // time until the next one, so a sample that is replaced at the same instant never ends a stretch.
  const inEffect: ViewEvent[] = [];
  for (const e of sorted) {
    if (e.type !== 'visibility') continue;
    if (inEffect.length > 0 && inEffect[inEffect.length - 1]!.tsMs === e.tsMs) inEffect[inEffect.length - 1] = e;
    else inEffect.push(e);
  }

  let runStartMs: number | null = null;
  for (const e of inEffect) {
    const visible = (e.visibleFraction ?? 0) >= strategy.threshold;
    if (visible && runStartMs === null) {
      runStartMs = e.tsMs;
    } else if (!visible && runStartMs !== null) {
      closeRun(runStartMs, e.tsMs);
      runStartMs = null;
    }
  }
  if (runStartMs !== null) closeRun(runStartMs, horizonMs);

  return { counted: countedAtMs !== null, countedAtMs, timerStartMs, longestRunMs };
}

export function evaluateAll(events: readonly ViewEvent[], strategies: readonly Strategy[]): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const s of strategies) out.set(s.name, evaluate(events, s));
  return out;
}
