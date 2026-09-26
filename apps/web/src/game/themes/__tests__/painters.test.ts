import { describe, expect, it } from 'vitest';
import { ROOM_TYPES, type RoomType } from '@tagconn/shared';
import { APPLIANCE_SPECS, MAX_OVERDRAW_PX, TALL_AGAINST_WALL_KINDS, type ApplianceKind } from '../../procgen/backWallSpec';
import type { FurnitureKind, PlacedFurniture, WallDecorKind, WallDecorSlot } from '../../procgen/types';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { paintModernWallDecor, paintGuildWallDecor } from '../paint/wallDecor';
import { paintModernBackWall, paintGuildBackWall } from '../paint/walls';
import type { ThemeDefinition } from '../types';
import { makeBoundsGraphics, makeStubGraphics } from './testUtils';

// A compile-time-exhaustive list: adding a FurnitureKind without adding it here fails to typecheck.
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

const WALL_DECOR_KIND_SET: Record<WallDecorKind, true> = {
  window: true,
  clock: true,
  picture: true,
  board: true,
  chart: true,
  'wall-shelf': true,
  banner: true,
};
const WALL_DECOR_KINDS = Object.keys(WALL_DECOR_KIND_SET) as WallDecorKind[];
// M8 8p: 1-3 span per kind (see `WALL_DECOR_SPANS` in backWallSpec.ts) — every kind here allows at
// least span 1, and `window`/`picture` also allow span 2 (double window / two frames).
const DECOR_SPANS: Record<WallDecorKind, readonly number[]> = {
  window: [1, 2],
  clock: [1],
  picture: [1, 2],
  board: [2, 3],
  chart: [1, 2],
  'wall-shelf': [1, 2],
  banner: [1],
};

const FLOOR_KINDS: (RoomType | 'corridor')[] = [...ROOM_TYPES, 'corridor'];

// Kinds that get a different look per room (`f.roomType`); exercised for every room they appear in.
const ROOM_VARIANTS: Partial<Record<FurnitureKind, RoomType[]>> = {
  table: ['meeting-room', 'lounge'],
  shelf: ['pm-office', 'library'],
  armchair: ['library', 'lounge'],
  plant: ['entrance', 'lounge'],
  centerpiece: ['whiteboard', 'qa-lab'],
};

function furnitureFixture(kind: FurnitureKind, roomType: RoomType): PlacedFurniture {
  return { x: 2, y: 2, w: 2, h: 2, kind, blocking: kind !== 'rug' && kind !== 'mat' && kind !== 'sigil', roomId: 'r1', roomType, variant: 1 };
}

// M8 8n (furnishing engine): the sizes/orientations `recipes.ts` actually places each new kind at
// (tall for rack-row, wide for shelf-stack/lab-bench/reception-desk, a 2x2 block for equipment, 1x1
// for the decor kinds) - `furnitureFixture`'s fixed 2x2 doesn't exercise tiling/orientation at all.
const NEW_KIND_SHAPES: Record<
  'rack-row' | 'console' | 'lab-bench' | 'equipment' | 'shelf-stack' | 'reading-table' | 'standing-table' | 'reception-desk' | 'bench' | 'lamp' | 'crate' | 'wall-art' | 'bin' | 'cabinet' | 'chair' | 'banner',
  { w: number; h: number }[]
> = {
  'rack-row': [{ w: 1, h: 1 }, { w: 1, h: 3 }, { w: 1, h: 10 }],
  console: [{ w: 1, h: 1 }],
  'lab-bench': [{ w: 1, h: 1 }, { w: 4, h: 1 }, { w: 8, h: 1 }],
  equipment: [{ w: 2, h: 2 }],
  'shelf-stack': [{ w: 1, h: 1 }, { w: 3, h: 1 }],
  'reading-table': [{ w: 2, h: 1 }],
  'standing-table': [{ w: 2, h: 1 }],
  'reception-desk': [{ w: 1, h: 1 }, { w: 3, h: 1 }],
  bench: [{ w: 2, h: 1 }],
  lamp: [{ w: 1, h: 1 }],
  crate: [{ w: 1, h: 1 }],
  'wall-art': [{ w: 1, h: 1 }],
  bin: [{ w: 1, h: 1 }],
  cabinet: [{ w: 1, h: 1 }],
  chair: [{ w: 1, h: 1 }],
  banner: [{ w: 1, h: 1 }],
};

// M8 8p: every standing appliance at its real footprint width (`APPLIANCE_SPECS`, h is always 1).
const APPLIANCE_KINDS = Object.keys(APPLIANCE_SPECS) as ApplianceKind[];

function wallDecorFixture(kind: WallDecorKind, span: number, variant: number): WallDecorSlot {
  return { kind, x: 2, y: 5, span, roomId: 'r1', variant };
}

const THEMES: [string, ThemeDefinition][] = [
  ['modern', modernTheme],
  ['guild', guildTheme],
];

// M8 8p: the back-wall face and wall-decor painters aren't (yet) fields on `ThemeDefinition` — keyed
// here by theme name so the shared `describe.each` below can still exercise both themes' versions.
const BACK_WALL_PAINTERS: Record<string, typeof paintModernBackWall> = {
  modern: paintModernBackWall,
  guild: paintGuildBackWall,
};
const WALL_DECOR_PAINTERS: Record<string, typeof paintModernWallDecor> = {
  modern: paintModernWallDecor,
  guild: paintGuildWallDecor,
};

describe.each(THEMES)('%s theme painters', (name, theme) => {
  it('paints every floor/corridor kind without throwing', () => {
    for (const kind of FLOOR_KINDS) {
      const { g, calls } = makeStubGraphics();
      expect(() => theme.paintFloor(g, kind, 32, 48, () => 0.42)).not.toThrow();
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it('paints walls (both a blank and a floor-visible face) without throwing', () => {
    for (const faceVisible of [false, true]) {
      const { g, calls } = makeStubGraphics();
      expect(() => theme.paintWall(g, 16, 16, faceVisible, () => 0.5)).not.toThrow();
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it('paints void tiles without throwing', () => {
    const { g, calls } = makeStubGraphics();
    expect(() => theme.paintVoid(g, 0, 0, () => 0.5)).not.toThrow();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('paints narrow and wide doors for every kind without throwing', () => {
    for (const kind of FLOOR_KINDS) {
      for (const wide of [false, true]) {
        const { g } = makeStubGraphics();
        expect(() => theme.paintDoor(g, kind, 0, 0, wide, () => 0.5)).not.toThrow();
      }
    }
  });

  it('paints every FurnitureKind (and every themed room variant) without throwing', () => {
    for (const kind of FURNITURE_KINDS) {
      const roomTypes = ROOM_VARIANTS[kind] ?? (['desks'] as RoomType[]);
      for (const roomType of roomTypes) {
        const { g, calls } = makeStubGraphics();
        const f = furnitureFixture(kind, roomType);
        expect(() => theme.paintFurniture(g, f, 16)).not.toThrow();
        expect(calls.length).toBeGreaterThan(0);
      }
    }
  });

  it('paints every new furnishing-engine kind at its real size/orientation and every seeded variant without throwing', () => {
    for (const [kind, shapes] of Object.entries(NEW_KIND_SHAPES) as [FurnitureKind, { w: number; h: number }[]][]) {
      for (const { w, h } of shapes) {
        for (let variant = 0; variant < 4; variant++) {
          const { g, calls } = makeStubGraphics();
          const f: PlacedFurniture = { x: 2, y: 2, w, h, kind, blocking: true, roomId: 'r1', roomType: 'desks', variant };
          expect(() => theme.paintFurniture(g, f, 16)).not.toThrow();
          expect(calls.length).toBeGreaterThan(0);
        }
      }
    }
  });

  // M8 8p (back wall + appliances) --------------------------------------------------------------

  it('paints every appliance kind at its real footprint width and every seeded variant without throwing', () => {
    for (const kind of APPLIANCE_KINDS) {
      const { w } = APPLIANCE_SPECS[kind];
      for (let variant = 0; variant < 4; variant++) {
        const { g, calls } = makeStubGraphics();
        const f: PlacedFurniture = { x: 2, y: 5, w, h: 1, kind, blocking: true, roomId: 'r1', roomType: 'desks', variant, againstNorthWall: true };
        expect(() => theme.paintFurniture(g, f, 16)).not.toThrow();
        expect(calls.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every appliance rect inside its x-range and within its overdrawPx above the footprint', () => {
    const T = 16;
    for (const kind of APPLIANCE_KINDS) {
      const spec = APPLIANCE_SPECS[kind];
      const f: PlacedFurniture = { x: 2, y: 5, w: spec.w, h: 1, kind, blocking: true, roomId: 'r1', roomType: 'desks', variant: 2, againstNorthWall: true };
      const { g, rects } = makeBoundsGraphics();
      theme.paintFurniture(g, f, T);
      expect(rects.length).toBeGreaterThan(0);
      const minX = Math.min(...rects.map((r) => r.x));
      const maxX = Math.max(...rects.map((r) => r.x + r.w));
      const minY = Math.min(...rects.map((r) => r.y));
      const maxY = Math.max(...rects.map((r) => r.y + r.h));
      // A couple of px of slack: a handful of existing (pre-8p) painters tile bx/bw loops that can
      // overshoot their own tile by a px, same as this file's other bounds-adjacent kinds.
      expect(minX).toBeGreaterThanOrEqual(f.x * T - 2);
      expect(maxX).toBeLessThanOrEqual((f.x + f.w) * T + 2);
      expect(minY).toBeGreaterThanOrEqual(f.y * T - spec.overdrawPx - 2);
      expect(maxY).toBeLessThanOrEqual((f.y + 1) * T + 2);
    }
  });

  it('never draws a TALL_AGAINST_WALL_KINDS item above its footprint unless againstNorthWall is set', () => {
    const T = 16;
    for (const kind of TALL_AGAINST_WALL_KINDS) {
      for (const against of [false, true]) {
        const f: PlacedFurniture = { x: 2, y: 5, w: 2, h: 1, kind, blocking: true, roomId: 'r1', roomType: 'desks', variant: 1, againstNorthWall: against };
        const { g, rects } = makeBoundsGraphics();
        theme.paintFurniture(g, f, T);
        const minY = Math.min(...rects.map((r) => r.y));
        expect(minY).toBeGreaterThanOrEqual(f.y * T - (against ? MAX_OVERDRAW_PX : 0));
      }
    }
  });

  it('paints every WallDecorKind at every allowed span and seeded variant, inside the face, without throwing', () => {
    const paint = WALL_DECOR_PAINTERS[name]!;
    const T = 16;
    const face = { top: 5 * T + 3, bottom: 6 * T + 8 }; // a representative capPx/bandPx face
    for (const kind of WALL_DECOR_KINDS) {
      for (const span of DECOR_SPANS[kind]) {
        for (let variant = 0; variant < 3; variant++) {
          const slot = wallDecorFixture(kind, span, variant);
          const { g, rects } = makeBoundsGraphics();
          expect(() => paint(g, slot, T, face)).not.toThrow();
          expect(rects.length).toBeGreaterThan(0);
          const minX = Math.min(...rects.map((r) => r.x));
          const maxX = Math.max(...rects.map((r) => r.x + r.w));
          const minY = Math.min(...rects.map((r) => r.y));
          const maxY = Math.max(...rects.map((r) => r.y + r.h));
          expect(minX).toBeGreaterThanOrEqual(slot.x * T - 1);
          expect(maxX).toBeLessThanOrEqual((slot.x + span) * T + 1);
          expect(minY).toBeGreaterThanOrEqual(face.top - 1);
          expect(maxY).toBeLessThanOrEqual(face.bottom + 1);
        }
      }
    }
  });

  it('paints the back-wall face (cap, face, band-with-baseboard, and door gap) without throwing', () => {
    const paint = BACK_WALL_PAINTERS[name]!;
    const capPx = name === 'guild' ? 2 : 3;
    const bandPx = name === 'guild' ? 10 : 8;
    for (const band of [true, false]) {
      for (const openLeft of [false, true]) {
        for (const openRight of [false, true]) {
          const { g, calls } = makeStubGraphics();
          expect(() => paint(g, 32, 80, { kind: 'desks', band, openLeft, openRight, capPx, bandPx }, () => 0.5)).not.toThrow();
          expect(calls.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
