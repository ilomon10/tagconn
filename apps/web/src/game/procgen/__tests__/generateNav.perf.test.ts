// M15 Wave 1 QA gate: `generateMap` now builds `map.nav` (rasterize + furniture + true clearance) and derives
// `walkable` from it. This asserts the EXISTING generate.perf.test.ts budgets (unchanged: 400 ms median, 1500 ms
// per sample) still hold at 128 x 96 with the nav wiring in the loop, and that the nav build itself stays a small
// share of a generation. Run with `pnpm test:perf` (excluded from `pnpm test` like every *.perf.test.ts).
import { describe, expect, it } from 'vitest';
import { hasLayoutErrors, type OfficeLayout } from '@tagconn/shared';
import { buildNavGrid } from '../../nav/grid';
import { maxRoomsLayout, toLayout } from '../../nav/__tests__/perfLayout';
import { generateMap } from '../generate';

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

// Same numbers as generate.perf.test.ts; never lowered here, never raised either.
const MEDIAN_BUDGET_MS = 400;
const MAX_SAMPLE_BUDGET_MS = 1500;
// navigation.md section 5: buildNavGrid + computeClearance at 128 x 96 ≤ 8 ms documented; nav.perf.test.ts enforces 10.
const NAV_BUILD_MEDIAN_MS = 10;

const median = (s: number[]) => s[Math.floor(s.length / 2)]!;

describe('perf budget: generateMap with the M15 nav build (128 x 96, 64 rooms)', () => {
  const plain: OfficeLayout = toLayout(maxRoomsLayout(), 'perf-nav');
  const pinned: OfficeLayout = {
    ...toLayout(maxRoomsLayout(), 'perf-nav-pins'),
    rooms: plain.rooms.map((r) =>
      r.type === 'stairs'
        ? r
        : {
            ...r,
            // Half-offset pins so the half-tile rasterizer and `coveredTiles` paths are on the hot loop too.
            furniture: [
              { kind: 'work-desk', x: 1.5, y: 2, w: 2, h: 1 },
              { kind: 'plant', x: 4, y: 2.5, w: 1, h: 1 },
              { kind: 'bookcase', x: 6.5, y: 0, w: 2, h: 1 },
            ],
          },
    ),
  };

  it('plain layout: the existing generate budget holds and the map carries a full-size nav grid', () => {
    let map: ReturnType<typeof generateMap> | undefined;
    const samples = sampleDurations(() => {
      map = generateMap(plain);
      expect(map.cols).toBe(128);
      expect(map.rows).toBe(96);
      expect(hasLayoutErrors(map.issues)).toBe(false);
    }, 9);
    expect(median(samples)).toBeLessThan(MEDIAN_BUDGET_MS);
    expect(samples[samples.length - 1]!).toBeLessThan(MAX_SAMPLE_BUDGET_MS);
    expect(map!.nav.masks.length).toBe(128 * 96);
    expect(map!.nav.clearance.length).toBe(128 * 2 * 96 * 2);
  });

  it('half-pinned layout (pins on 63 rooms): the same budget holds', () => {
    let map: ReturnType<typeof generateMap> | undefined;
    const samples = sampleDurations(() => {
      map = generateMap(pinned);
      expect(map.layoutId).toBe('perf-nav-pins');
      expect(map.furniture.filter((f) => f.pinned).length).toBeGreaterThan(100);
    }, 9);
    expect(median(samples)).toBeLessThan(MEDIAN_BUDGET_MS);
    expect(samples[samples.length - 1]!).toBeLessThan(MAX_SAMPLE_BUDGET_MS);
    expect(map!.nav.masks.length).toBe(128 * 96);
  });

  it('the nav build is a small share of a generation (buildNavGrid alone stays within its own budget)', () => {
    const map = generateMap(pinned);
    const gen = median(sampleDurations(() => generateMap(pinned), 9));
    const nav = median(sampleDurations(() => buildNavGrid(map, map.walkable), 9));
    expect(nav).toBeLessThan(NAV_BUILD_MEDIAN_MS);
    // Informational guard: a nav build that costs more than a whole generation would mean something regressed badly.
    expect(nav).toBeLessThan(gen);
  });
});
