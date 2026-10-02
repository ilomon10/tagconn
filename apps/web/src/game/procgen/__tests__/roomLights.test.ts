import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, MULTIVERSE_LIMITS, type MultiverseProjectInput, type OfficeLayout } from '@tagconn/shared';
import { generateMap } from '../generate';
import { generateRandomLayout } from '../bsp';
import { planMultiverse } from '../../multiverse/plan';
import { planRoomLights, ROOM_LIGHT_TILES } from '../roomLights';
import type { GeneratedMap } from '../types';

const room = (id: string, w: number, h: number, type: 'lounge' | 'stairs' | 'hall' = 'lounge') => ({
  id,
  type,
  interior: { x: 3, y: 2, w, h },
});

function checkMap(map: GeneratedMap): void {
  const lights = map.lights ?? [];
  const keys = new Set<string>();
  for (const l of lights) {
    const r = map.rooms.find((x) => x.id === l.roomId);
    expect(r, `room ${l.roomId}`).toBeDefined();
    const { x, y, w, h } = r!.interior;
    expect(l.x >= x && l.x < x + w && l.y >= y && l.y < y + h).toBe(true);
    expect(Number.isInteger(l.x) && Number.isInteger(l.y)).toBe(true);
    expect(map.tiles[l.y]?.[l.x]).toBe('floor');
    expect(l.reachTiles).toBeGreaterThanOrEqual(2.5);
    expect(l.reachTiles).toBeLessThanOrEqual(5);
    const key = `${l.x},${l.y}`;
    expect(keys.has(key), `duplicate light at ${key}`).toBe(false);
    keys.add(key);
  }
  for (const r of map.rooms) {
    const area = r.interior.w * r.interior.h;
    const n = lights.filter((l) => l.roomId === r.id).length;
    const per = r.type === 'hall' ? ROOM_LIGHT_TILES * 2 : ROOM_LIGHT_TILES;
    expect(n).toBe(r.type === 'stairs' ? 1 : Math.max(1, Math.ceil(area / per)));
  }
}

describe('planRoomLights', () => {
  it('puts one light at the centre of a 4 x 3 room', () => {
    const [l, ...rest] = planRoomLights([room('a', 4, 3)]);
    expect(rest).toHaveLength(0);
    expect(l).toMatchObject({ roomId: 'a', x: 5, y: 3 });
  });

  it('gives ceil(area / 24) lights for every size, all inside and distinct', () => {
    for (let w = 1; w <= 20; w++) {
      for (let h = 1; h <= 14; h++) {
        const lights = planRoomLights([room('r', w, h)]);
        expect(lights).toHaveLength(Math.ceil((w * h) / ROOM_LIGHT_TILES));
        const keys = new Set(lights.map((l) => `${l.x},${l.y}`));
        expect(keys.size).toBe(lights.length);
        for (const l of lights) expect(l.x >= 3 && l.x < 3 + w && l.y >= 2 && l.y < 2 + h).toBe(true);
      }
    }
  });

  it('stairs get one light, halls one per 48 tiles', () => {
    expect(planRoomLights([room('s', 6, 6, 'stairs')])).toHaveLength(1);
    expect(planRoomLights([room('h', 12, 8, 'hall')])).toHaveLength(2);
  });

  it('is deterministic', () => {
    const rooms = [room('a', 9, 7), room('b', 5, 11)];
    expect(planRoomLights(rooms)).toEqual(planRoomLights(rooms));
  });
});

describe('generateMap lights', () => {
  it('emits valid lights for the default layout', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    expect(map.lights?.length).toBeGreaterThan(0);
    checkMap(map);
  });

  it('emits valid lights for 300 BSP seeds', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const input = generateRandomLayout({ width: 48, height: 30, seed });
      const layout: OfficeLayout = { ...input, background: input.background ?? 'hall', corridorWidth: input.corridorWidth ?? 2, id: `bsp${seed}`, builtin: false, createdAt: 0, updatedAt: 0 };
      checkMap(generateMap(layout));
    }
  }, 30_000); // 300-seed property run: correctness, not a timing budget (~2 s idle; slow under load)

  it('a Multiverse map has lights in every realm room', () => {
    const projects: MultiverseProjectInput[] = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      style: i % 2 === 0 ? 'guild' : 'modern',
      createdAt: i,
      lastActivityAt: 1000,
      liveAgents: 1,
      lastLiveAt: 1000,
    }));
    const plan = planMultiverse(projects, { maxRealms: MULTIVERSE_LIMITS.maxRealms, floorOrder: 'created', now: 1000, idleLeaveSec: 300 });
    const map = generateMap(plan.layout);
    checkMap(map);
    for (const realm of plan.realms) {
      expect(map.lights?.some((l) => realm.roomIds.includes(l.roomId))).toBe(true);
    }
  });
});
