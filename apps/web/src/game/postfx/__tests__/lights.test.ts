import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, MULTIVERSE_THEME_ID } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import type { GeneratedMap } from '../../procgen/types';
import { extractLightSources } from '../lights';

function mapWith(decor: GeneratedMap['decor'], furniture: GeneratedMap['furniture'], northWall: GeneratedMap['northWall'] = []): GeneratedMap {
  const base = generateMap(DEFAULT_LAYOUT);
  return { ...base, decor, furniture, northWall };
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

  describe('fireplaces (M8 8p T4)', () => {
    const fireplace = [{ x: 2, y: 3, w: 2, h: 1, kind: 'fireplace' as const, blocking: true, roomId: 'r1', roomType: 'lounge' as const, variant: 0, againstNorthWall: true }];

    it('emits a warm-orange light at the footprint center, larger than a wall-light or lamp', () => {
      const map = mapWith([], fireplace);
      const T = map.tileSize;
      const lights = extractLightSources(map, 'guild', 10);
      expect(lights).toHaveLength(1);
      expect(lights[0]).toMatchObject({ x: (2 + 1) * T, y: (3 + 0.5) * T, depth: 4 * T, color: 0xff6a2a });
      expect(lights[0]!.radius).toBeGreaterThan(10); // > WALL_LIGHT_RADIUS
    });

    it('flickers only in the guild style; modern and rift fireplaces hold steady', () => {
      const map = mapWith([], fireplace);
      expect(extractLightSources(map, 'guild', 10)[0]?.flicker).toBe(true);
      expect(extractLightSources(map, 'modern', 10)[0]?.flicker).toBe(false);
      expect(extractLightSources(map, MULTIVERSE_THEME_ID, 10)[0]?.flicker).toBe(false);
    });

    it('uses the same warm-orange hue across every style', () => {
      const map = mapWith([], fireplace);
      expect(extractLightSources(map, 'guild', 10)[0]?.color).toBe(0xff6a2a);
      expect(extractLightSources(map, 'modern', 10)[0]?.color).toBe(0xff6a2a);
      expect(extractLightSources(map, MULTIVERSE_THEME_ID, 10)[0]?.color).toBe(0xff6a2a);
    });
  });

  describe('northWall windows (M8 8p T4)', () => {
    it('emits a light centered on the slot span, at the wall row (not the floor)', () => {
      const map = mapWith([], [], [{ x: 4, y: 6, span: 2, kind: 'window', roomId: 'r1', variant: 0 }]);
      const T = map.tileSize;
      const lights = extractLightSources(map, 'modern', 10);
      expect(lights).toHaveLength(1);
      expect(lights[0]).toMatchObject({ x: (4 + 1) * T, y: 6 * T + T / 2, depth: 6 * T });
    });

    it('ignores every other northWall decor kind (clock, picture, board, chart, wall-shelf, banner)', () => {
      const northWall: GeneratedMap['northWall'] = [
        { x: 0, y: 0, span: 1, kind: 'clock', roomId: 'r1', variant: 0 },
        { x: 1, y: 0, span: 1, kind: 'picture', roomId: 'r1', variant: 0 },
        { x: 2, y: 0, span: 2, kind: 'board', roomId: 'r1', variant: 0 },
        { x: 4, y: 0, span: 1, kind: 'chart', roomId: 'r1', variant: 0 },
        { x: 5, y: 0, span: 1, kind: 'wall-shelf', roomId: 'r1', variant: 0 },
        { x: 6, y: 0, span: 1, kind: 'banner', roomId: 'r1', variant: 0 },
      ];
      expect(extractLightSources(mapWith([], [], northWall), 'guild', 10)).toHaveLength(0);
    });

    it('scales radius with span: a 2-tile window glows wider than a 1-tile one', () => {
      const northWall: GeneratedMap['northWall'] = [
        { x: 0, y: 0, span: 1, kind: 'window', roomId: 'r1', variant: 0 },
        { x: 3, y: 0, span: 2, kind: 'window', roomId: 'r1', variant: 0 },
      ];
      const [narrow, wide] = extractLightSources(mapWith([], [], northWall), 'modern', 10);
      expect(wide!.radius).toBeGreaterThan(narrow!.radius);
    });

    it('never flickers, and tints per style: cool daylight (modern), warm amber (guild), cyan (rift)', () => {
      const northWall: GeneratedMap['northWall'] = [{ x: 0, y: 0, span: 1, kind: 'window', roomId: 'r1', variant: 0 }];
      const map = mapWith([], [], northWall);
      const modern = extractLightSources(map, 'modern', 10)[0]!;
      const guild = extractLightSources(map, 'guild', 10)[0]!;
      const rift = extractLightSources(map, MULTIVERSE_THEME_ID, 10)[0]!;
      expect(modern.flicker).toBe(false);
      expect(guild.flicker).toBe(false);
      expect(rift.flicker).toBe(false);
      expect(new Set([modern.color, guild.color, rift.color]).size).toBe(3);
    });
  });

  describe('tiny appliance indicator lights (M8 8p T4)', () => {
    const appliances = [
      { x: 0, y: 0, w: 1, h: 1, kind: 'coffee-machine' as const, blocking: true, roomId: 'r1', roomType: 'lounge' as const, variant: 0 },
      { x: 2, y: 0, w: 1, h: 1, kind: 'fridge' as const, blocking: true, roomId: 'r1', roomType: 'lounge' as const, variant: 0 },
    ];

    it('emits a tiny glow for coffee-machine and fridge', () => {
      const lights = extractLightSources(mapWith([], appliances), 'modern', 10);
      expect(lights).toHaveLength(2);
      for (const l of lights) expect(l.radius).toBeLessThan(7); // smaller than any other light kind
      expect(lights.every((l) => l.flicker === false)).toBe(true);
    });

    it('is the lowest priority: dropped first when the cap forces a choice, after decor and main furniture lights', () => {
      const decor: GeneratedMap['decor'] = [{ x: 0, y: 0, kind: 'wall-light', roomId: 'r1', variant: 0 }];
      const northWall: GeneratedMap['northWall'] = [{ x: 5, y: 0, span: 1, kind: 'window', roomId: 'r1', variant: 0 }];
      const furniture = [
        { x: 1, y: 1, w: 1, h: 1, kind: 'lamp' as const, blocking: true, roomId: 'r1', roomType: 'desks' as const, variant: 0 },
        ...appliances,
      ];
      const map = mapWith(decor, furniture, northWall);
      // 1 wall-light + 1 window + 1 lamp + 2 tiny = 5 candidates; cap at 3 must keep decor+window+lamp.
      const capped = extractLightSources(map, 'modern', 3);
      expect(capped).toHaveLength(3);
      expect(capped.every((l) => !appliances.some((a) => a.kind === 'coffee-machine' || a.kind === 'fridge') || l.radius >= 7)).toBe(true);
      // Explicitly: none of the 3 kept lights is a tiny appliance light (radius < 7).
      expect(capped.some((l) => l.radius < 7)).toBe(false);
    });

    it('is deterministic: repeated extraction gives identical output', () => {
      const map = mapWith([], appliances);
      const a = extractLightSources(map, 'guild', 10);
      const b = extractLightSources(map, 'guild', 10);
      expect(a).toEqual(b);
    });
  });
});
