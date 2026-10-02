import { describe, expect, it } from 'vitest';
import { hasLayoutErrors } from '@tagconn/shared';
import { maxRoomsLayout, toLayout } from '../../nav/__tests__/perfLayout';
import { generateMap } from '../../procgen';
import { buildDualCells } from '../dual/dualGrid';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { renderGeneratedMap } from '../renderTheme';
import type { ThemeDefinition } from '../types';
import { makeFakeScene } from './testUtils';

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

// docs/design/dual-grid.md section 4.6: the dual pass (2b) is an additive overlay whose cost is proportional
// to the boundary length, so at the 128 x 96 worst case it may add at most 60% more `fillRect`s and 50% more
// wall-clock than the flat render, and the whole bake stays under 400 ms. The stub scene has no canvas: this
// measures the JS command stream only (a real canvas bake adds about 1 ms per 1k rects).
const RECT_RATIO_MAX = 1.6;
const TIME_RATIO_MAX = 1.5;
const TIME_MEDIAN_MAX_MS = 400;
const SAMPLES = 5;

function countRects(map: ReturnType<typeof generateMap>, theme: ThemeDefinition, dualGrid: boolean): number {
  const fake = makeFakeScene({ recordRects: true });
  renderGeneratedMap(fake.scene, map, theme, [], { dualGrid });
  return fake.rects.length;
}

function medianMs(map: ReturnType<typeof generateMap>, theme: ThemeDefinition, dualGrid: boolean): number {
  const samples = sampleDurations(() => {
    const { scene } = makeFakeScene();
    renderGeneratedMap(scene, map, theme, [], { dualGrid });
  }, SAMPLES);
  return samples[Math.floor(samples.length / 2)]!;
}

describe('perf budget: dual-grid render pass (M15 D4)', () => {
  const map = generateMap(toLayout(maxRoomsLayout(), 'perf'));
  expect(map.cols).toBe(128);
  expect(map.rows).toBe(96);
  expect(hasLayoutErrors(map.issues)).toBe(false);

  it('builds (cols+1)(rows+1) = 129 x 97 dual cells', () => {
    expect(buildDualCells(map)).toHaveLength(129 * 97);
  });

  for (const theme of [modernTheme, guildTheme]) {
    it(`${theme.id}: dual on adds at most ${RECT_RATIO_MAX}x the fillRect count of dual off`, () => {
      const off = countRects(map, theme, false);
      const on = countRects(map, theme, true);
      expect(off).toBeGreaterThan(0);
      expect(on).toBeGreaterThan(off); // the pass draws something
      expect(on / off).toBeLessThanOrEqual(RECT_RATIO_MAX);
    });

    it(`${theme.id}: dual on median wall-clock is at most ${TIME_RATIO_MAX}x dual off and under ${TIME_MEDIAN_MAX_MS} ms`, () => {
      const off = medianMs(map, theme, false);
      const on = medianMs(map, theme, true);
      expect(on).toBeLessThan(TIME_MEDIAN_MAX_MS);
      // Guard the ratio against timer noise on a tiny `off` (a few ms): compare against max(off, 20 ms).
      expect(on / Math.max(off, 20)).toBeLessThanOrEqual(TIME_RATIO_MAX);
    });
  }
});
