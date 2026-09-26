import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, MULTIVERSE_THEME_ID } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import type { GeneratedMap } from '../../procgen/types';
import { extractLightSources } from '../lights';

function mapWith(decor: GeneratedMap['decor'], furniture: GeneratedMap['furniture']): GeneratedMap {
  const base = generateMap(DEFAULT_LAYOUT);
  return { ...base, decor, furniture };
}

describe('extractLightSources', () => {
  it('emits a light for every wall-light decor slot, in world pixels', () => {
    const map = mapWith([{ x: 3, y: 5, kind: 'wall-light', roomId: 'r1', variant: 0 }], []);
    const T = map.tileSize;
    const lights = extractLightSources(map, 'guild', 200);
    expect(lights).toHaveLength(1);
    expect(lights[0]).toMatchObject({ x: 3 * T + T / 2, y: 5 * T + T / 2 });
  });

  it('ignores wall-hanging and floor-scatter decor (not light sources)', () => {
    const map = mapWith(
      [
        { x: 0, y: 0, kind: 'wall-hanging', roomId: 'r1', variant: 0 },
        { x: 1, y: 0, kind: 'floor-scatter', roomId: 'r1', variant: 0 },
      ],
      [],
    );
    expect(extractLightSources(map, 'modern', 200)).toHaveLength(0);
  });

  it('emits a light for lamp, console and equipment furniture but not other kinds', () => {
    const lit = [
      { x: 0, y: 0, w: 1, h: 1, kind: 'lamp', blocking: true, roomId: 'r1', roomType: 'desks', variant: 0 },
      { x: 2, y: 0, w: 2, h: 2, kind: 'console', blocking: true, roomId: 'r1', roomType: 'server-room', variant: 0 },
      { x: 5, y: 0, w: 2, h: 2, kind: 'equipment', blocking: true, roomId: 'r1', roomType: 'server-room', variant: 0 },
    ] as GeneratedMap['furniture'];
    const unlit = [{ x: 8, y: 0, w: 1, h: 1, kind: 'chair', blocking: false, roomId: 'r1', roomType: 'desks', variant: 0 }] as GeneratedMap['furniture'];
    const map = mapWith([], [...lit, ...unlit]);
    expect(extractLightSources(map, 'modern', 200)).toHaveLength(3);
  });

  it('caps the count at maxLights, keeping decor lights before furniture lights', () => {
    const decor = Array.from({ length: 5 }, (_, i) => ({ x: i, y: 0, kind: 'wall-light' as const, roomId: 'r1', variant: 0 }));
    const furniture = Array.from({ length: 5 }, (_, i) => ({ x: i, y: 2, w: 1, h: 1, kind: 'lamp' as const, blocking: true, roomId: 'r1', roomType: 'desks' as const, variant: 0 }));
    const map = mapWith(decor, furniture);
    const capped = extractLightSources(map, 'modern', 3);
    expect(capped).toHaveLength(3);
    expect(capped.every((l) => l.color === capped[0]!.color)).toBe(true); // all 3 came from decor, same tint
  });

  it('only the guild torch flickers; modern and rift wall-lights hold steady', () => {
    const decor: GeneratedMap['decor'] = [{ x: 0, y: 0, kind: 'wall-light', roomId: 'r1', variant: 0 }];
    expect(extractLightSources(mapWith(decor, []), 'guild', 10)[0]?.flicker).toBe(true);
    expect(extractLightSources(mapWith(decor, []), 'modern', 10)[0]?.flicker).toBe(false);
    expect(extractLightSources(mapWith(decor, []), MULTIVERSE_THEME_ID, 10)[0]?.flicker).toBe(false);
  });

  it('gives modern a warm sconce and cool console tint, never the same color', () => {
    const decor: GeneratedMap['decor'] = [{ x: 0, y: 0, kind: 'wall-light', roomId: 'r1', variant: 0 }];
    const furniture = [{ x: 3, y: 3, w: 2, h: 2, kind: 'console' as const, blocking: true, roomId: 'r1', roomType: 'server-room' as const, variant: 0 }];
    const [wall, console_] = extractLightSources(mapWith(decor, furniture), 'modern', 10);
    expect(wall!.color).not.toBe(console_!.color);
  });
});
