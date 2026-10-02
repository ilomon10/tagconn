import { describe, expect, it } from 'vitest';
import { TILE_PX } from '../../nav/constants';
import { KIND_HEIGHT, kindHeight } from '../../lighting/heights';
import type { FurnitureKind, PlacedFurniture } from '../../procgen/types';
import { FRONT_STRIP_PX, frameKey, isSitInKind, spriteClassOf } from '../tables';

const kinds = Object.keys(KIND_HEIGHT) as FurnitureKind[];

const base: PlacedFurniture = {
  kind: 'work-desk', blocking: true, roomId: 'r', roomType: 'desks', variant: 0, x: 3, y: 4, w: 2, h: 1,
};

describe('spriteClassOf', () => {
  it('classifies every FurnitureKind consistently with the tables', () => {
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) {
      const c = spriteClassOf(k);
      if (Object.hasOwn(FRONT_STRIP_PX, k)) expect(c, k).toBe('sit-in');
      else expect(c, k).toBe(KIND_HEIGHT[k] > 0 ? 'sprite' : 'baked');
    }
  });
  it('sends prototype names and unknown kinds to baked', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope']) {
      expect(spriteClassOf(k), k).toBe('baked');
      expect(isSitInKind(k), k).toBe(false);
      expect(kindHeight(k), k).toBe(0);
    }
  });
  it('known examples', () => {
    expect(spriteClassOf('chair')).toBe('sit-in');
    expect(spriteClassOf('shelf')).toBe('sprite');
    expect(spriteClassOf('rug')).toBe('baked');
  });
});

describe('FRONT_STRIP_PX', () => {
  it('never exceeds a tile and every sit-in kind is a real FurnitureKind', () => {
    for (const [k, byFacing] of Object.entries(FRONT_STRIP_PX)) {
      expect(kinds, k).toContain(k);
      for (const px of Object.values(byFacing)) {
        expect(px).toBeGreaterThanOrEqual(0);
        expect(px).toBeLessThanOrEqual(TILE_PX);
      }
    }
  });
});

describe('frameKey', () => {
  it('is stable and distinguishes everything a painter reads', () => {
    const k = frameKey(base);
    expect(frameKey({ ...base })).toBe(k);
    expect(frameKey({ ...base, x: 9, y: 9, roomId: 'other' })).toBe(k);
    const variants: Partial<PlacedFurniture>[] = [
      { kind: 'table' }, { variant: 1 }, { facing: 'n' }, { w: 3 }, { h: 2 },
      { againstNorthWall: true }, { roomType: 'meeting-room' }, { trigger: 'board' },
    ];
    const keys = new Set([k, ...variants.map((v) => frameKey({ ...base, ...v }))]);
    expect(keys.size).toBe(variants.length + 1);
    expect(frameKey({ ...base, facing: 's' })).toBe(k);
  });
});
