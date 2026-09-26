import { describe, expect, it } from 'vitest';
import { ROOM_TYPES, type RoomType } from '@tagconn/shared';
import type { FurnitureKind, PlacedFurniture } from '../../procgen/types';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import type { ThemeDefinition } from '../types';
import { makeStubGraphics } from './testUtils';

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
};
const FURNITURE_KINDS = Object.keys(FURNITURE_KIND_SET) as FurnitureKind[];

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

const THEMES: [string, ThemeDefinition][] = [
  ['modern', modernTheme],
  ['guild', guildTheme],
];

describe.each(THEMES)('%s theme painters', (_name, theme) => {
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
});
