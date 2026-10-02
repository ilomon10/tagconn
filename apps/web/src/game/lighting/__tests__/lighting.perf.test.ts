// M16 L2 perf budgets (docs/design/lighting.md section 5) at 128 x 96 with the 64-room worst-case layout. Wall-clock, so
// `pnpm test:perf` only (excluded from `pnpm test`). Medians over 9 samples after a warm-up; generous ceilings.
import { describe, expect, it } from 'vitest';
import { generateMap } from '../../procgen/generate';
import type { GeneratedMap } from '../../procgen/types';
import { maxRoomsLayout, toLayout } from '../../nav/__tests__/perfLayout';
import { buildOccluders } from '../occluders';
import { bakePolygons, planLightmap } from '../plan';
import { buildLightIndex, characterShadow, furnitureShadows } from '../shadows';
import { LIGHTMAP_MAX_LIGHTS, lightmapSources } from '../sources';
import type { CastShadow } from '../types';
import { NIGHT, NOON, theme } from './lightingFixtures';

function median(fn: () => void, n = 9): number {
  fn();
  const s: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    s.push(performance.now() - t0);
  }
  s.sort((a, b) => a - b);
  return s[Math.floor(n / 2)]!;
}

const map: GeneratedMap = generateMap(toLayout(maxRoomsLayout(), 'perf-light'));
const themeAt = () => theme;
const colours = { sunColor: 0xfff2c8, moonColor: 0x9ab0ff };

describe('perf budget: lighting (128 x 96)', () => {
  it('buildOccluders <= 6 ms', () => {
    const ms = median(() => buildOccluders(map));
    console.log(`[perf] buildOccluders ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThanOrEqual(6);
  });

  it('bakePolygons for every source <= 60 ms (high cap), and bounded at lightScale max', () => {
    for (const scale of [1, 3]) {
      const sources = lightmapSources(map, 'guild', themeAt, scale, 'high');
      const occ = buildOccluders(map);
      expect(sources.length).toBeLessThanOrEqual(LIGHTMAP_MAX_LIGHTS.high);
      const ms = median(() => bakePolygons(sources, occ, map), 5);
      console.log(`[perf] bakePolygons x${sources.length} lightScale ${scale}: ${ms.toFixed(2)} ms`);
      expect(ms).toBeLessThanOrEqual(scale === 1 ? 60 : 150);
    }
  });

  it('planLightmap with cached polygons <= 8 ms (a sun step)', () => {
    const sources = lightmapSources(map, 'guild', themeAt, 1, 'high');
    const polygons = bakePolygons(sources, buildOccluders(map), map);
    const ms = median(() => planLightmap({ map, sun: NIGHT, sources, polygons, quality: 'high', settings: { windowShafts: true }, colours, regions: [] }));
    console.log(`[perf] planLightmap ${ms.toFixed(2)} ms (${sources.length} lights)`);
    expect(ms).toBeLessThanOrEqual(8);
  });

  it('furnitureShadows (cast) <= 4 ms, day and night', () => {
    const sources = lightmapSources(map, 'guild', themeAt, 1, 'high');
    for (const sun of [NOON, NIGHT]) {
      const ms = median(() => furnitureShadows(map, sun, sources, 'cast', 0.25));
      console.log(`[perf] furnitureShadows ${sun.phase} (${map.furniture.length} items) ${ms.toFixed(2)} ms`);
      expect(ms).toBeLessThanOrEqual(4);
    }
  });

  it('characterShadow x 60 <= 0.3 ms per frame', () => {
    const sources = lightmapSources(map, 'guild', themeAt, 1, 'high');
    const index = buildLightIndex(sources, map.cols, map.rows, map.tileSize);
    const o: CastShadow = { dx: 0, dy: 0, len: 0, alpha: 0 };
    const feet = Array.from({ length: 60 }, (_, i) => ({ x: (4 + i * 2) * map.tileSize, y: (6 + (i % 12) * 4) * map.tileSize }));
    const ms = median(() => {
      for (const f of feet) characterShadow(f, NIGHT, index, 'cast', o);
    }, 25);
    console.log(`[perf] characterShadow x60 ${ms.toFixed(3)} ms`);
    expect(ms).toBeLessThanOrEqual(0.3);
  });
});
