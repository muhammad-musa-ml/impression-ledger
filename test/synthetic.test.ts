import { describe, expect, it } from 'vitest';
import { SCENARIO_NAMES, generateDataset, type Expectation } from '../src/synthetic.js';
import { defaultStrategies, evaluate, type ViewEvent } from '../src/viewability.js';

// The scenarios write down what each rule should say about their views. The counter is not
// consulted for that, so this is a check of the counter against the design, not against itself.
describe('the synthetic scenarios', () => {
  const dataset = generateDataset({ seed: 3, tenants: ['t'], viewsPerTenant: 1500 });
  const eventsOf = new Map<string, ViewEvent[]>();
  for (const { event } of dataset.events) {
    const list = eventsOf.get(event.viewId) ?? [];
    list.push({ type: event.type, tsMs: event.tsMs, seq: event.seq, visibleFraction: event.visibleFraction });
    eventsOf.set(event.viewId, list);
  }

  it('use every scenario, so the comparison below is not vacuous', () => {
    expect(new Set(dataset.views.map((v) => v.scenario))).toEqual(new Set(SCENARIO_NAMES));
  });

  it('include views the two timer starts disagree about', () => {
    const disagree = dataset.views.filter((v) => v.expect['first-token'] !== v.expect['fully-rendered']);
    expect(disagree.length).toBeGreaterThan(100);
  });

  it('are counted as designed under both rules', () => {
    const wrong: string[] = [];
    for (const view of dataset.views) {
      for (const strategy of defaultStrategies()) {
        const counted = evaluate(eventsOf.get(view.viewId)!, strategy).counted;
        if (counted !== view.expect[strategy.name as keyof Expectation]) wrong.push(`${view.scenario}/${strategy.name}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
