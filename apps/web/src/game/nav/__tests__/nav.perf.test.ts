import { describe, expect, it } from 'vitest';
import { hasLayoutErrors } from '@tagconn/shared';
import { generateMap } from '../../procgen/generate';
import { CLEARANCE_MAX } from '../constants';
import { buildNavGrid, setCell, updateClearance } from '../grid';
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
const BUILD_MEDIAN_MS = 10;
const BUILD_MAX_SAMPLE_MS = 100;
const UPDATE_MEDIAN_MS = 0.1;

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

  it('updateClearance on a 4 x 4 cell dirty rect is sub-0.1 ms', () => {
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
