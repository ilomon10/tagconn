import { describe, expect, it } from 'vitest';
import { ROOM_TYPES, ZONES, type RoomType } from '@tagconn/shared';
import { APPLIANCE_SPECS, type ApplianceKind } from '../../procgen/backWallSpec';
import type { FurnitureKind, PlacedFurniture, WallDecorKind, WallDecorSlot } from '../../procgen/types';
import { riftTheme } from '../rift';
import { paintRiftBackWall, paintRiftWallDecor } from '../paint/riftWalls';
import { makeBoundsGraphics, makeStubGraphics } from './testUtils';

// A compile-time-exhaustive list, mirroring painters.test.ts's coverage for modern/guild — adding a
// FurnitureKind without adding it here fails to typecheck.
const FURNITURE_KIND_SET: Record<FurnitureKind, true> = {
  'work-desk': true,
  'lead-desk': true,
  table: true,
  board: true,
  workbench: true,
  booth: true,
  rack: true,
  shelf: true,
  sofa: true,
  armchair: true,
  rug: true,
  mat: true,
  counter: true,
  plant: true,
  centerpiece: true,
  pedestal: true,
  sigil: true,
  'stairs-up': true,
  'stairs-down': true,
  // M8 8n (furnishing engine): new kinds so rooms scale/fill by density instead of empty floor.
  'rack-row': true,
  console: true,
  'lab-bench': true,
  equipment: true,
  'shelf-stack': true,
  'reading-table': true,
  'standing-table': true,
  'reception-desk': true,
  bench: true,
  lamp: true,
  crate: true,
  'wall-art': true,
  bin: true,
  cabinet: true,
  chair: true,
  banner: true,
  // M8 8p (back wall + appliances): standing appliances, always against a north wall.
  printer: true,
  fridge: true,
  'water-cooler': true,
  'filing-cabinet': true,
  'coffee-machine': true,
  bookcase: true,
  fireplace: true,
  'coat-rack': true,
  'supply-stack': true,
  cage: true,
};
const FURNITURE_KINDS = Object.keys(FURNITURE_KIND_SET) as FurnitureKind[];
const APPLIANCE_KINDS = Object.keys(APPLIANCE_SPECS) as ApplianceKind[];

const WALL_DECOR_KINDS: WallDecorKind[] = ['window', 'clock', 'picture', 'board', 'chart', 'wall-shelf', 'banner'];
function wallDecorFixture(kind: WallDecorKind, span: number, variant: number): WallDecorSlot {
  return { kind, x: 2, y: 5, span, roomId: 'r1', variant };
}
const FLOOR_KINDS: (RoomType | 'corridor')[] = [...ROOM_TYPES, 'corridor'];

function furnitureFixture(kind: FurnitureKind): PlacedFurniture {
  return { x: 2, y: 2, w: 2, h: 2, kind, blocking: kind !== 'rug' && kind !== 'mat' && kind !== 'sigil', roomId: 'r1', roomType: 'desks', variant: 1 };
}

describe('rift theme painters (implements every FurnitureKind/RoomType exhaustively)', () => {
  it('has a zone name for every Zone and a room name for every RoomType', () => {
    for (const zone of ZONES) expect(riftTheme.zoneNames[zone]).toBeTruthy();
    for (const type of ROOM_TYPES) expect(riftTheme.roomNames[type]).toBeTruthy();
  });

  it('has floor colours for every RoomType and corridor', () => {
    for (const kind of FLOOR_KINDS) {
      expect(riftTheme.palette.floorBase[kind]).toBeTypeOf('number');
      expect(riftTheme.palette.floorAccent[kind]).toBeTypeOf('number');
    }
  });

  it('paints every floor/corridor kind without throwing', () => {
    for (const kind of FLOOR_KINDS) {
      const { g, calls } = makeStubGraphics();
      expect(() => riftTheme.paintFloor(g, kind, 32, 48, () => 0.42)).not.toThrow();
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it('paints walls (blank and floor-visible face) without throwing', () => {
    for (const faceVisible of [false, true]) {
      const { g, calls } = makeStubGraphics();
      expect(() => riftTheme.paintWall(g, 16, 16, faceVisible, () => 0.5)).not.toThrow();
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it('paints void tiles (starfield) without throwing, for every rand roll', () => {
    for (const roll of [0, 0.05, 0.3, 0.5, 0.8, 0.99]) {
      const { g, calls } = makeStubGraphics();
      let i = 0;
      const seq = [roll, roll, roll];
      expect(() => riftTheme.paintVoid(g, 0, 0, () => seq[i++ % seq.length]!)).not.toThrow();
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it('paints the floating-island rock underside at both depths without throwing', () => {
    for (const depth of [1, 2] as const) {
      const { g, calls } = makeStubGraphics();
      expect(() => riftTheme.paintIslandEdge?.(g, 0, 0, depth, () => 0.5)).not.toThrow();
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it('paints narrow and wide doors for every kind without throwing (the Nexus Gate for entrance)', () => {
    for (const kind of FLOOR_KINDS) {
      for (const wide of [false, true]) {
        const { g } = makeStubGraphics();
        expect(() => riftTheme.paintDoor(g, kind, 0, 0, wide, () => 0.5)).not.toThrow();
      }
    }
  });

  it('paints every FurnitureKind without throwing (Rift Stairs for stairs-up/down)', () => {
    for (const kind of FURNITURE_KINDS) {
      const { g, calls } = makeStubGraphics();
      const f = furnitureFixture(kind);
      expect(() => riftTheme.paintFurniture(g, f, 16)).not.toThrow();
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it('paints every new furnishing-engine kind at tall/wide orientations and every seeded variant without throwing', () => {
    // M8 8n: `recipes.ts` places rack-row tall (w=1,h=N) and shelf-stack/lab-bench/reception-desk
    // wide (w=N,h=1); exercise both orientations plus the decor kinds' 1x1 seeded variants.
    const shapes: [FurnitureKind, { w: number; h: number }][] = [
      ['rack-row', { w: 1, h: 8 }],
      ['console', { w: 1, h: 1 }],
      ['lab-bench', { w: 6, h: 1 }],
      ['equipment', { w: 2, h: 2 }],
      ['shelf-stack', { w: 3, h: 1 }],
      ['reading-table', { w: 2, h: 1 }],
      ['standing-table', { w: 2, h: 1 }],
      ['reception-desk', { w: 3, h: 1 }],
      ['bench', { w: 2, h: 1 }],
      ['lamp', { w: 1, h: 1 }],
      ['crate', { w: 1, h: 1 }],
      ['wall-art', { w: 1, h: 1 }],
      ['bin', { w: 1, h: 1 }],
      ['cabinet', { w: 1, h: 1 }],
      ['chair', { w: 1, h: 1 }],
      ['banner', { w: 1, h: 1 }],
    ];
    for (const [kind, { w, h }] of shapes) {
      for (let variant = 0; variant < 4; variant++) {
        const { g, calls } = makeStubGraphics();
        const f: PlacedFurniture = { x: 2, y: 2, w, h, kind, blocking: true, roomId: 'r1', roomType: 'desks', variant };
        expect(() => riftTheme.paintFurniture(g, f, 16)).not.toThrow();
        expect(calls.length).toBeGreaterThan(0);
      }
    }
  });

  it('paints every appliance kind at its real footprint width and every seeded variant without throwing (M8 8p)', () => {
    for (const kind of APPLIANCE_KINDS) {
      const { w } = APPLIANCE_SPECS[kind];
      for (let variant = 0; variant < 4; variant++) {
        const { g, calls } = makeStubGraphics();
        const f: PlacedFurniture = { x: 2, y: 5, w, h: 1, kind, blocking: true, roomId: 'r1', roomType: 'desks', variant, againstNorthWall: true };
        expect(() => riftTheme.paintFurniture(g, f, 16)).not.toThrow();
        expect(calls.length).toBeGreaterThan(0);
      }
    }
  });

  it('paints the back-wall face (cap, face, band-with-baseboard, and door gap) without throwing (M8 8p)', () => {
    for (const band of [true, false]) {
      for (const openLeft of [false, true]) {
        for (const openRight of [false, true]) {
          const { g, calls } = makeStubGraphics();
          expect(() =>
            paintRiftBackWall(g, 32, 80, { kind: 'desks', band, openLeft, openRight, capPx: 3, bandPx: 6 }, () => 0.5),
          ).not.toThrow();
          expect(calls.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('paints every WallDecorKind at a representative span/variant, inside the face, without throwing (M8 8p)', () => {
    const T = 16;
    const face = { top: 5 * T + 3, bottom: 6 * T + 6 };
    for (const kind of WALL_DECOR_KINDS) {
      for (const span of [1, 2]) {
        const slot = wallDecorFixture(kind, span, 1);
        const { g, rects } = makeBoundsGraphics();
        expect(() => paintRiftWallDecor(g, slot, T, face)).not.toThrow();
        expect(rects.length).toBeGreaterThan(0);
      }
    }
  });

  it('reuses the guild role titles and costumes (heroes keep their look in the Nexus)', () => {
    expect(riftTheme.roleTitles.pm).toBe('Guild Master');
    expect(riftTheme.costumes.developer).toBeDefined();
  });

  it('floorLabel always reads "The Multiverse"', () => {
    expect(riftTheme.floorLabel(0, 'tagconn')).toBe('The Multiverse');
    expect(riftTheme.floorLabel(5, 'anything')).toBe('The Multiverse');
  });
});
