import type { Strategy, ViewEvent } from '../src/viewability.js';

/**
 * A deliberately naive second implementation of the rule, used to cross-check
 * src/viewability.ts. It walks the view one millisecond at a time and shares
 * no code with the real counter.
 *
 * The fraction in effect during millisecond [t, t + 1) is the one reported by
 * the latest sample at or before t. The clock starts at the strategy's timer
 * start, and a break below the threshold resets the streak. The view is
 * observed up to the latest event it has.
 */
export function referenceVerdict(
  events: readonly ViewEvent[],
  s: Strategy,
): { counted: boolean; countedAtMs: number | null } {
  const wanted = s.timerStart === 'first-token' ? 'first_token' : 'render_complete';
  const starts = events.filter((e) => e.type === wanted).map((e) => e.tsMs);
  if (starts.length === 0 || events.length === 0) return { counted: false, countedAtMs: null };
  const start = Math.min(...starts);
  const horizon = Math.max(...events.map((e) => e.tsMs));
  const samples = events
    .filter((e) => e.type === 'visibility')
    .sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq || (b.visibleFraction ?? 0) - (a.visibleFraction ?? 0));

  let streak = 0;
  for (let t = start; t < horizon; t++) {
    let fraction = 0;
    for (const x of samples) {
      if (x.tsMs > t) break;
      fraction = x.visibleFraction ?? 0;
    }
    streak = fraction >= s.threshold ? streak + 1 : 0;
    if (streak >= s.minVisibleMs) return { counted: true, countedAtMs: t + 1 };
  }
  return { counted: false, countedAtMs: null };
}
