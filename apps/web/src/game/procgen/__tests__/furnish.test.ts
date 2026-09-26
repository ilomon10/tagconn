import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  hasLayoutErrors,
  type FurnishDensity,
  type LayoutRoom,
  type OfficeLayout,
  type RoomType,
} from '@tagconn/shared';
import { generateMap } from '../generate';
import { furnishRoom } from '../recipes';
import { mulberry32 } from '../rng';
import { reachableFrom } from '../regions';
import type { Rect } from '../types';

/**
 * M8 8n furnishing engine tests. Coverage bands are approximate ("sparse ~25-35%, normal ~45-55%,
 * dense ~60-70%, packed = as much as possible") per guild-hall.md; per-type ceilings differ (a lounge
 * or entrance legitimately has less blocking furniture than a server room even at `packed`, since
 * sofas/benches/mats are soft decor, not blocking), so the assertions below check that every density
 * step is clearly higher than the last, and land in a realistic band for that room type, rather than
 * pinning every type to the exact same numbers.
 */
function coverage(type: RoomType, w: number, h: number, density: FurnishDensity, seed = 1): number {
  const interior: Rect = { x: 0, y: 0, w, h };
  const { furniture } = furnishRoom(type, interior, mulberry32(seed), { density, decor: 0.35, aisle: 1 });
  const blockedTiles = furniture.filter((f) => f.blocking).reduce((s, f) => s + f.w * f.h, 0);
  return blockedTiles / (w * h);
}

const DENSITIES: FurnishDensity[] = ['sparse', 'normal', 'dense', 'packed'];
const TYPICAL_SIZES: [number, number][] = [[18, 14], [28, 18]];

describe('furnishRoom: density -> coverage bands (M8 8n)', () => {
  it('every density level for every room type is monotonically non-decreasing coverage, at typical sizes', () => {
    const types: RoomType[] = ['desks', 'server-room', 'qa-lab', 'library', 'meeting-room', 'lounge', 'review-booth', 'whiteboard', 'entrance', 'pm-office'];
    for (const type of types) {
      for (const [w, h] of TYPICAL_SIZES) {
        const covs = DENSITIES.map((d) => coverage(type, w, h, d));
        for (let i = 1; i < covs.length; i++) {
          expect(covs[i]!, `${type} ${w}x${h} ${DENSITIES[i]} vs ${DENSITIES[i - 1]}`).toBeGreaterThanOrEqual(covs[i - 1]! - 0.01);
        }
        // packed is always the fullest (or tied with dense for a mostly-decor room type).
        expect(covs[3]!, `${type} ${w}x${h} packed >= sparse`).toBeGreaterThan(covs[0]!);
      }
    }
  });

  it('the user-reported room (server-room) goes from visibly empty to full rows of racks', () => {
    // The literal bug report: "the server racks in the server room are mostly empty even though the
    // room is large". `dense`/`packed` must land in the documented 60-70%+ band, not stay near-empty.
    for (const [w, h] of TYPICAL_SIZES) {
      expect(coverage('server-room', w, h, 'sparse')).toBeLessThan(0.3);
      expect(coverage('server-room', w, h, 'dense')).toBeGreaterThanOrEqual(0.55);
      expect(coverage('server-room', w, h, 'packed')).toBeGreaterThanOrEqual(coverage('server-room', w, h, 'dense'));
    }
  });

  it('desks: sparse ~25-35%, normal climbs, dense ~55-70% (guild-hall.md 8n bands)', () => {
    expect(coverage('desks', 28, 18, 'sparse')).toBeGreaterThan(0.15);
    expect(coverage('desks', 28, 18, 'sparse')).toBeLessThan(0.35);
    expect(coverage('desks', 28, 18, 'dense')).toBeGreaterThan(0.5);
    expect(coverage('desks', 28, 18, 'dense')).toBeLessThan(0.75);
  });

  it('qa-lab, library, meeting-room, review-booth, whiteboard all clear 55% at dense on a typical room', () => {
    for (const type of ['qa-lab', 'library', 'meeting-room', 'review-booth', 'whiteboard'] as RoomType[]) {
      expect(coverage(type, 28, 18, 'dense'), type).toBeGreaterThanOrEqual(0.55);
    }
  });

  it('is deterministic: the same room type/size/density/seed gives byte-identical furniture', () => {
    const interior: Rect = { x: 2, y: 3, w: 20, h: 14 };
    const a = furnishRoom('server-room', interior, mulberry32(42), { density: 'dense', decor: 0.5, aisle: 1 });
    const b = furnishRoom('server-room', interior, mulberry32(42), { density: 'dense', decor: 0.5, aisle: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('furnishRoom: seats target', () => {
  it('places exactly the requested seat count when it fits', () => {
    const interior: Rect = { x: 0, y: 0, w: 30, h: 20 };
    const { seats, seatsShortfall } = furnishRoom('desks', interior, mulberry32(1), { density: 'normal', decor: 0.35, aisle: 1, seatsTarget: 8 });
    // The recipe naturally produces more than 8 seats at this size/density; seatsTarget only reports
    // a shortfall, it doesn't truncate extra capacity (an office isn't obligated to waste floor space).
    expect(seats.length).toBeGreaterThanOrEqual(8);
    expect(seatsShortfall).toBeUndefined();
  });

  it('reports a shortfall when the room is too small for the requested seat count', () => {
    const interior: Rect = { x: 0, y: 0, w: 4, h: 3 };
    const { seats, seatsShortfall } = furnishRoom('review-booth', interior, mulberry32(1), { density: 'sparse', decor: 0, aisle: 1, seatsTarget: 100 });
    expect(seatsShortfall).toBeDefined();
    expect(seatsShortfall!.wanted).toBe(100);
    expect(seatsShortfall!.fit).toBe(seats.length);
    expect(seats.length).toBeLessThan(100);
  });

  it('generateMap turns a seat shortfall into an unreachable-seat warning issue naming the room', () => {
    const room: LayoutRoom = { id: 'booth', type: 'review-booth', x: 1, y: 1, w: 5, h: 5, furnish: { seats: 50 } };
    const entrance: LayoutRoom = { id: 'entrance', type: 'entrance', x: 1, y: 7, w: 6, h: 4 };
    const stairs: LayoutRoom = { id: 'stairs', type: 'stairs', x: 8, y: 7, w: 3, h: 3 };
    const layout: OfficeLayout = {
      id: 'test', name: 'test', width: 16, height: 14, seed: 1, background: 'hall', corridorWidth: 2,
      builtin: false, createdAt: 0, updatedAt: 0,
      rooms: [room, entrance, stairs],
    };
    const map = generateMap(layout);
    const warning = map.issues.find((i) => i.code === 'unreachable-seat' && i.roomIds?.includes('booth') && i.message.includes('50'));
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });
});

describe('generateMap: furnishDefaults vs per-room furnish precedence', () => {
  function layoutWith(furnishDefaults: OfficeLayout['furnishDefaults'], roomFurnish?: LayoutRoom['furnish']): OfficeLayout {
    const room: LayoutRoom = { id: 'r', type: 'desks', x: 1, y: 1, w: 26, h: 16, ...(roomFurnish && { furnish: roomFurnish }) };
    const entrance: LayoutRoom = { id: 'entrance', type: 'entrance', x: 1, y: 18, w: 6, h: 4 };
    const stairs: LayoutRoom = { id: 'stairs', type: 'stairs', x: 8, y: 18, w: 3, h: 3 };
    return {
      id: 'test', name: 'test', width: 28, height: 23, seed: 5, background: 'hall', corridorWidth: 2,
      builtin: false, createdAt: 0, updatedAt: 0,
      ...(furnishDefaults && { furnishDefaults }),
      rooms: [room, entrance, stairs],
    };
  }
  function blockingTiles(layout: OfficeLayout): number {
    const map = generateMap(layout);
    return map.furniture.filter((f) => f.roomId === 'r' && f.blocking).reduce((s, f) => s + f.w * f.h, 0);
  }

  it('a room with no furnish falls back to furnishDefaults', () => {
    const sparse = blockingTiles(layoutWith({ density: 'sparse' }));
    const packed = blockingTiles(layoutWith({ density: 'packed' }));
    expect(packed).toBeGreaterThan(sparse);
  });

  it("a room's own furnish overrides furnishDefaults", () => {
    const roomOverridesToSparse = blockingTiles(layoutWith({ density: 'packed' }, { density: 'sparse' }));
    const layoutDefaultPacked = blockingTiles(layoutWith({ density: 'packed' }));
    expect(roomOverridesToSparse).toBeLessThan(layoutDefaultPacked);
  });

  it('with neither set, falls back to the normal built-in default', () => {
    const noneSet = blockingTiles(layoutWith(undefined));
    const explicitNormal = blockingTiles(layoutWith(undefined, { density: 'normal' }));
    // Same built-in default either way (undefined furnish === explicit 'normal').
    expect(noneSet).toBe(explicitNormal);
  });
});

describe('generateMap: furnish.seed re-rolls one room without touching the layout seed or other rooms', () => {
  it('changing one room\'s furnish.seed changes only that room\'s furniture', () => {
    const base: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === 'server-room' ? { ...r, furnish: { seed: 1 } } : r)),
    };
    const rerolled: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === 'server-room' ? { ...r, furnish: { seed: 2 } } : r)),
    };
    const mapA = generateMap(base);
    const mapB = generateMap(rerolled);
    expect(hasLayoutErrors(mapA.issues)).toBe(false);
    expect(hasLayoutErrors(mapB.issues)).toBe(false);
    const otherRoomIds = DEFAULT_LAYOUT.rooms.map((r) => r.id).filter((id) => id !== 'server-room');
    for (const id of otherRoomIds) {
      expect(mapA.furniture.filter((f) => f.roomId === id), id).toEqual(mapB.furniture.filter((f) => f.roomId === id));
    }
    // The reseeded room itself is very likely to differ in at least the decor/variant pass.
    expect(JSON.stringify(mapA.furniture.filter((f) => f.roomId === 'server-room'))).not.toBe(
      JSON.stringify(mapB.furniture.filter((f) => f.roomId === 'server-room')),
    );
  });

  it('generating the same layout twice (with furnish set) is byte-identical', () => {
    const layout: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      furnishDefaults: { density: 'dense', decor: 0.6, aisle: 2 },
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === 'desks' ? { ...r, furnish: { density: 'packed', seats: 20, seed: 7 } } : r)),
    };
    const a = generateMap(layout);
    const b = generateMap(layout);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
