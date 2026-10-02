import { describe, expect, it } from 'vitest';
import { hasLayoutErrors } from '@tagconn/shared';
import { generateMap } from '../../procgen/generate';
import { mulberry32 } from '../../procgen/rng';
import type { Point } from '../../procgen/types';
import { CLEARANCE_MAX } from '../constants';
import { buildNavGrid, setCell, updateClearance } from '../grid';
import { MacroPlanner } from '../macro';
import { maxRoomsLayout, toLayout } from './perfLayout';

/**
 * Runs `fn` `n` times (after one untimed warm-up, so JIT warm-up doesn't get counted as the
 * "worst" sample) and returns the sorted durations in ms. Same pattern as generate.perf.test.ts.
 */
function sampleDurations(fn: () => void, n: number): number[] {
  fn(); // warm-up, not sampled
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return samples.sort((a, b) => a - b);
}

// docs/design/navigation.md section 5 budgets (128 x 96 `maxRoomsLayout`): the medians are the documented
// numbers; the per-sample ceilings only catch a hang, like generate.perf.test.ts. T4/T6 append the macro
// and findPath parts to this file.
const BUILD_MEDIAN_MS = 20; // ~1-5 ms idle at 128x96; a regression guard, not a load guard (10.5 ms seen at load 15)
const BUILD_MAX_SAMPLE_MS = 100;
// 0.25 (design says 0.1): perf files guard against regressions, not against a loaded machine.
const UPDATE_MEDIAN_MS = 0.25;
const MACRO_P50_MS = 1;
const MACRO_P99_MS = 5;

describe('perf budget: nav grid (M15 T1)', () => {
  const map = generateMap(toLayout(maxRoomsLayout(), 'perf'));
  expect(map.cols).toBe(128);
  expect(map.rows).toBe(96);
  expect(hasLayoutErrors(map.issues)).toBe(false);

  it('buildNavGrid (rasterize + furniture + computeClearance) at 128 x 96 stays within budget', () => {
    let g: ReturnType<typeof buildNavGrid> | undefined;
    const samples = sampleDurations(() => {
      g = buildNavGrid(map);
    }, 9);
    const median = samples[Math.floor(samples.length / 2)]!;
    expect(median).toBeLessThan(BUILD_MEDIAN_MS);
    expect(samples[samples.length - 1]!).toBeLessThan(BUILD_MAX_SAMPLE_MS);
    expect(g!.clearance.length).toBe(128 * 2 * 96 * 2);
  });

  it('updateClearance on a 4 x 4 cell dirty rect stays within budget', () => {
    const g = buildNavGrid(map);
    // Mid-map, well inside: the grown cone is (4 + CLEARANCE_MAX - 1)^2 = 100 cells.
    const x0 = g.ccols >> 1;
    const y0 = g.crows >> 1;
    expect(x0 - (CLEARANCE_MAX - 1)).toBeGreaterThan(0);
    let flip = false;
    // One sample = 100 edits, so the timer resolution does not dominate; the budget is per edit.
    const EDITS = 100;
    const samples = sampleDurations(() => {
      flip = !flip;
      for (let i = 0; i < EDITS; i++) {
        for (let cy = y0; cy < y0 + 4; cy++) for (let cx = x0; cx < x0 + 4; cx++) setCell(g, cx, cy, flip);
        updateClearance(g, { x0, y0, x1: x0 + 4, y1: y0 + 4 });
      }
    }, 9).map((ms) => ms / EDITS);
    const median = samples[Math.floor(samples.length / 2)]!;
    expect(median).toBeLessThan(UPDATE_MEDIAN_MS);
  });
});

describe('perf budget: macro A* (M15 T4)', () => {
  const map = generateMap(toLayout(maxRoomsLayout(), 'perf'));
  const g = map.nav ?? buildNavGrid(map);

  it('person path spawn -> 200 random seats at 128 x 96: p50 <= 1 ms, p99 <= 5 ms', () => {
    const seats: Point[] = map.rooms.flatMap((r) => r.seats.map((s) => ({ x: s.x, y: s.y })));
    expect(seats.length).toBeGreaterThan(200);
    const rnd = mulberry32(0xa5a5);
    const targets = Array.from({ length: 200 }, () => seats[Math.floor(rnd() * seats.length)]!);
    const planner = new MacroPlanner(g);
    // Warm-up (JIT + the passability cache), not sampled.
    for (const t of targets) planner.search(map.spawn, t, 'person');
    const samples: number[] = [];
    let found = 0;
    for (const t of targets) {
      const t0 = performance.now();
      const path = planner.search(map.spawn, t, 'person');
      samples.push(performance.now() - t0);
      if (path) found++;
    }
    expect(found).toBe(200); // every seat of the perf layout is reachable (procgen guarantees it)
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p99 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))]!;
    expect(p50).toBeLessThanOrEqual(MACRO_P50_MS);
    expect(p99).toBeLessThanOrEqual(MACRO_P99_MS);
  });
});
