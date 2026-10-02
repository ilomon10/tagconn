import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import type { GeneratedMap, RoomLight } from '../../procgen/types';
import { extractLightSources } from '../../postfx/lights';
import { LIGHTMAP_MAX_LIGHTS, MAX_LIGHT_REACH_TILES, clampReach, intensityAt, lightmapSources, type LightmapLight } from '../sources';
import { NIGHT, NOON, T, furn, mapFrom, theme, walledRows } from './lightingFixtures';

const themeAt = () => theme;

function withLights(n: number): { map: GeneratedMap; room: RoomLight[] } {
  const base = generateMap(DEFAULT_LAYOUT);
  const room: RoomLight[] = Array.from({ length: n }, (_, i) => ({ x: 2 + (i % 20), y: 2 + Math.floor(i / 20), roomId: 'r1', reachTiles: 3 }));
  return { map: { ...base, lights: room }, room };
}

describe('lightmapSources', () => {
  it('room lights come first, then every extractLightSources entry 1:1 with its kind', () => {
    const { map, room } = withLights(5);
    const out = lightmapSources(map, 'guild', themeAt, 1);
    const ext = extractLightSources(map, 'guild', -1);
    expect(ext.length).toBeGreaterThan(0);
    expect(out.slice(0, 5).every((l) => l.kind === 'ambient-fill')).toBe(true);
    expect(out.slice(0, 5).map((l) => [l.x, l.y])).toEqual(room.map((r) => [(r.x + 0.5) * T, (r.y + 0.5) * T]));
    const rest = out.slice(5);
    expect(rest).toHaveLength(ext.length);
    rest.forEach((l, i) => {
      expect(l.kind).toBe(ext[i]!.kind);
      expect(l.color).toBe(ext[i]!.color);
      expect(l.flicker).toBe(ext[i]!.flicker);
    });
  });

  it('missing map.lights is fine (L3 optional)', () => {
    const base = generateMap(DEFAULT_LAYOUT);
    const out = lightmapSources({ ...base, lights: undefined }, 'modern', themeAt, 1);
    expect(out.every((l) => l.kind !== 'ambient-fill')).toBe(true);
  });

  it('reach table in tiles, scaled by lightScale', () => {
    const m = mapFrom(walledRows(8, 6), {
      lights: [{ x: 3, y: 3, roomId: 'r1', reachTiles: 4 }],
      furniture: [furn('lamp', 2, 2), furn('fireplace', 5, 2, 2, 1), furn('coffee-machine', 4, 5)],
    });
    m.decor = [{ x: 3, y: 0, kind: 'wall-light', roomId: 'r1', variant: 0 }];
    m.northWall = [{ kind: 'window', x: 5, y: 0, span: 1, roomId: 'r1', variant: 0 }];
    const one = lightmapSources(m, 'modern', themeAt, 1);
    const reach = (k: string) => one.filter((l) => l.kind === k).map((l) => l.reach / T);
    expect(reach('ambient-fill')).toEqual([4]);
    expect(reach('wall')).toEqual([4]);
    expect(reach('window')).toEqual([3]);
    expect(reach('point').sort()).toEqual([3, 5]);
    expect(reach('tiny')).toEqual([1]);
    const half = lightmapSources(m, 'modern', themeAt, 0.5);
    expect(half.map((l) => l.reach)).toEqual(one.map((l) => l.reach / 2));
  });

  it('clamps the final reach to MAX_LIGHT_REACH_TILES after lightScale', () => {
    const { map } = withLights(3);
    const out = lightmapSources(map, 'guild', themeAt, 3);
    expect(Math.max(...out.map((l) => l.reach))).toBeLessThanOrEqual(MAX_LIGHT_REACH_TILES * T);
    expect(out.some((l) => l.reach === MAX_LIGHT_REACH_TILES * T)).toBe(true);
    expect(clampReach(5, 3, T)).toBe(8 * T);
    expect(clampReach(Infinity, 1, T)).toBe(0);
    expect(clampReach(NaN, 1, T)).toBe(0);
    expect(clampReach(-1, 1, T)).toBe(0);
  });

  it('wall and window lights are nudged onto the floor side', () => {
    const m = mapFrom(walledRows(8, 6));
    m.decor = [{ x: 3, y: 0, kind: 'wall-light', roomId: 'r1', variant: 0 }];
    const [l] = lightmapSources(m, 'modern', themeAt, 1);
    expect(m.tiles[Math.floor(l!.y / T)]![3]).toBe('floor');
    expect(l!.roomId).toBe('r1');
  });

  it('truncates to the cap per quality, from the end, so room lights are kept', () => {
    const { map, room } = withLights(100);
    const hi = lightmapSources(map, 'guild', themeAt, 1, 'high');
    const lo = lightmapSources(map, 'guild', themeAt, 1, 'low');
    expect(hi.length).toBeLessThanOrEqual(LIGHTMAP_MAX_LIGHTS.high);
    expect(lo).toHaveLength(LIGHTMAP_MAX_LIGHTS.low);
    expect(lo.slice(0, 96).every((l) => l.kind === 'ambient-fill')).toBe(true);
    expect(room).toHaveLength(100);
    // an absurd room-light list is cut before any further work
    const flood = { ...map, lights: Array.from({ length: 5000 }, (_, i) => ({ x: i % 100, y: 1, roomId: 'r1', reachTiles: 3 })) };
    expect(lightmapSources(flood, 'guild', themeAt, 1, 'low')).toHaveLength(96);
  });

  it('room light reach inputs that are not finite are dropped', () => {
    const m = mapFrom(walledRows(6, 5), { lights: [{ x: 2, y: 2, roomId: 'r1', reachTiles: NaN }, { x: 3, y: 2, roomId: 'r1', reachTiles: 3 }] });
    expect(lightmapSources(m, 'modern', themeAt, 1)).toHaveLength(1);
  });
});

describe('intensityAt', () => {
  const l = (kind: string) => ({ kind }) as Pick<LightmapLight, 'kind'>;
  it('electric lights fade by day, windows follow the sun and keep moonlight', () => {
    expect(intensityAt(l('point'), NOON)).toBeCloseTo(0.15, 6);
    expect(intensityAt(l('wall'), NIGHT)).toBe(1);
    expect(intensityAt(l('window'), NOON)).toBe(1);
    expect(intensityAt(l('window'), NIGHT)).toBeCloseTo(0.25, 6);
  });
  it('unknown and prototype kinds give 0', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'bogus']) expect(intensityAt(l(k), NIGHT)).toBe(0);
  });
});
