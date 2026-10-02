// M17 D1 perf budgets (docs/design/depth-25d.md section 8): wall-clock, so `pnpm test:perf` only (the *.perf.test.ts name keeps it out of `pnpm test`).
import { describe, expect, it } from 'vitest';
import { hasLayoutErrors } from '@tagconn/shared';
import { maxRoomsLayout, toLayout } from '../../nav/__tests__/perfLayout';
import { generateMap } from '../../procgen';
import { modernTheme } from '../../themes/modern';
import { renderGeneratedMap } from '../../themes/renderTheme';
import { makeFakeScene } from '../../themes/__tests__/testUtils';
import { buildFurnitureAtlas } from '../furnitureAtlas';
import { packFrames } from '../pack';
import { planSprites } from '../spritePlan';
import { ATLAS_MAX_HEIGHT, ATLAS_WIDTH } from '../tables';

function median(fn: () => void, n = 9): number {
  fn(); // warm-up, not sampled
  const s: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    s.push(performance.now() - t0);
  }
  s.sort((a, b) => a - b);
  return s[Math.floor(n / 2)]!;
}

const map = generateMap(toLayout(maxRoomsLayout(), 'perf'));
const input = { map, sprites: true, maxSprites: 1500, themeIdAt: () => 'modern' };

describe('perf budget: furniture sprites at 128 x 96 (M17 D1)', () => {
  it('builds a valid worst-case map with several hundred items', () => {
    expect(hasLayoutErrors(map.issues)).toBe(false);
    expect(map.furniture.length).toBeGreaterThan(400);
  });

  it('planSprites <= 3 ms', () => {
    expect(median(() => planSprites(input))).toBeLessThanOrEqual(3);
  });

  it('packFrames <= 2 ms; every page <= 1024 x 2048 and at most 2 pages per style', () => {
    const specs = [...planSprites(input).frames.values()];
    expect(specs.length).toBeGreaterThan(20);
    expect(median(() => packFrames(specs))).toBeLessThanOrEqual(2);
    const layout = packFrames(specs);
    expect(layout.pages.length).toBeLessThanOrEqual(2);
    for (const p of layout.pages) {
      expect(p.w).toBeLessThanOrEqual(ATLAS_WIDTH);
      expect(p.h).toBeLessThanOrEqual(ATLAS_MAX_HEIGHT);
    }
  });

  it('the atlas paints at most 1.1x the furniture share of the base bake (command count)', () => {
    const withFurniture = makeFakeScene({ recordRects: true });
    renderGeneratedMap(withFurniture.scene, map, modernTheme);
    const without = makeFakeScene({ recordRects: true });
    renderGeneratedMap(without.scene, { ...map, furniture: [] }, modernTheme);
    const share = withFurniture.commands.length - without.commands.length;
    const specs = [...planSprites(input).frames.values()];
    const atlas = makeFakeScene({ recordRects: true });
    buildFurnitureAtlas(atlas.scene, modernTheme, specs, map.tileSize, 1);
    expect(share).toBeGreaterThan(0);
    expect(atlas.commands.length).toBeLessThanOrEqual(1.1 * share);
  });
});
