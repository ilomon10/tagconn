import { describe, expect, it } from 'vitest';
import { validateLayout, type LayoutRoom, type PinnedFurniture } from '@tagconn/shared';
import type { GeneratedMap } from '../../game/procgen';
import { clampPinPos, hitFurnitureAt, isPinnableItem, pinFits, pinFromPlaced, planLockAll, pinsForLockAll, prunePins, unpinnableReason } from './pins';

// A walled (explicit) desks room at (2,2) 10x8: interior (3,3) 8x6.
const room = (over: Partial<LayoutRoom> = {}): LayoutRoom => ({ id: 'a', type: 'desks', x: 2, y: 2, w: 10, h: 8, walled: true, ...over });
const pin = (over: Partial<PinnedFurniture> = {}): PinnedFurniture => ({ kind: 'plant', x: 0, y: 0, w: 1, h: 1, ...over });

const mapOf = (furniture: Partial<GeneratedMap['furniture'][number]>[]) => ({ furniture }) as unknown as GeneratedMap;

describe('pinnable items', () => {
  it('rejects stairs and items larger than 8', () => {
    expect(isPinnableItem({ kind: 'work-desk', w: 2, h: 1 })).toBe(true);
    expect(isPinnableItem({ kind: 'stairs-up', w: 1, h: 1 })).toBe(false);
    expect(isPinnableItem({ kind: 'rug', w: 9, h: 2 })).toBe(false);
    expect(unpinnableReason({ kind: 'rug', w: 2, h: 9 })).toBe('Too large to lock');
    expect(unpinnableReason({ kind: 'plant', w: 1, h: 1 })).toBeNull();
  });
  it('pinFromPlaced is interior-relative and keeps the variant', () => {
    expect(pinFromPlaced({ kind: 'sofa', x: 5, y: 4, w: 2, h: 1, variant: 3 }, { x: 3, y: 3, w: 8, h: 6 })).toEqual({ kind: 'sofa', x: 2, y: 1, w: 2, h: 1, variant: 3 });
  });
});

describe('pinFits / clampPinPos / prunePins', () => {
  it('requires the interior, no overlap, and clear explicit door aprons', () => {
    const r = room({ furniture: [pin({ x: 2, y: 2 })], doors: [{ side: 'n', offset: 4, width: 1 }] });
    expect(pinFits(r, pin({ x: 7, y: 5 }))).toBe(true);
    expect(pinFits(r, pin({ x: 8, y: 5 }))).toBe(false); // outside (interior is 8 wide)
    expect(pinFits(r, pin({ x: 2, y: 2 }))).toBe(false); // overlaps
    expect(pinFits(r, pin({ x: 2, y: 2 }), 0)).toBe(true); // ...unless it is the moved pin itself
    expect(pinFits(r, pin({ x: 3, y: 0 }))).toBe(false); // door n offset 4 -> interior x 3, y 0
  });
  it('clamps into the interior', () => {
    expect(clampPinPos(room(), pin({ w: 2, h: 2 }), { x: 99, y: -4 })).toEqual({ x: 6, y: 0 });
  });
  it('prunePins drops pins outside the new interior and is identity when nothing changes', () => {
    const r = room({ furniture: [pin({ x: 0, y: 0 }), pin({ x: 7, y: 5 })] });
    expect(prunePins(r)).toBe(r);
    const smaller = prunePins({ ...r, w: 6, h: 5 });
    expect(smaller.furniture).toEqual([pin({ x: 0, y: 0 })]);
    expect(prunePins({ ...r, w: 3, h: 3 }).furniture).toEqual([pin({ x: 0, y: 0 })]);
    expect(prunePins({ ...room({ furniture: [pin({ x: 7, y: 5 })] }), w: 4, h: 4 }).furniture).toBeUndefined();
  });
  it('prunes from a baseline source so a regrow restores pins', () => {
    const base = [pin({ x: 7, y: 5 })];
    const shrunk = prunePins({ ...room(), furniture: base, w: 4 }, base);
    expect(shrunk.furniture).toBeUndefined();
    expect(prunePins({ ...shrunk, w: 10 }, base).furniture).toEqual(base);
  });
});

describe('hitFurnitureAt', () => {
  const rooms = [room({ furniture: [pin({ kind: 'lamp', x: 1, y: 1 })] })];
  it('hits a pin first, with its index', () => {
    const map = mapOf([{ roomId: 'a', kind: 'rug', x: 3, y: 3, w: 4, h: 4, variant: 0 }]);
    const hit = hitFurnitureAt(map, rooms, { x: 4, y: 4 });
    expect(hit?.pinIndex).toBe(0);
    expect(hit?.item).toMatchObject({ kind: 'lamp', x: 4, y: 4 });
  });
  it('falls back to the topmost generated item, skipping pinned ones', () => {
    const map = mapOf([
      { roomId: 'a', kind: 'rug', x: 3, y: 3, w: 4, h: 4, variant: 0 },
      { roomId: 'a', kind: 'table', x: 5, y: 5, w: 2, h: 2, variant: 1 },
      { roomId: 'a', kind: 'bin', x: 5, y: 5, w: 1, h: 1, variant: 0, pinned: true },
    ]);
    expect(hitFurnitureAt(map, rooms, { x: 5, y: 5 })).toMatchObject({ pinIndex: null, item: { kind: 'table' } });
    expect(hitFurnitureAt(map, rooms, { x: 3, y: 6 })).toMatchObject({ item: { kind: 'rug' } });
    expect(hitFurnitureAt(map, rooms, { x: 20, y: 20 })).toBeNull();
    expect(hitFurnitureAt(null, rooms, { x: 9, y: 8 })).toBeNull();
  });
});

describe('pinsForLockAll', () => {
  it('dedupes, skips stairs / oversized / overlapping and respects the cap', () => {
    const r = room({ furniture: [pin({ kind: 'lamp', x: 0, y: 0 })] });
    const map = mapOf([
      { roomId: 'a', kind: 'table', x: 5, y: 5, w: 2, h: 1, variant: 0 },
      { roomId: 'a', kind: 'table', x: 5, y: 5, w: 2, h: 1, variant: 0 },
      { roomId: 'a', kind: 'stairs-up', x: 6, y: 3, w: 1, h: 1, variant: 0 },
      { roomId: 'a', kind: 'rug', x: 3, y: 3, w: 2, h: 2, variant: 0 }, // overlaps the lamp pin
      { roomId: 'b', kind: 'sofa', x: 5, y: 5, w: 2, h: 1, variant: 0 },
    ]);
    expect(pinsForLockAll(map, r)).toEqual([{ kind: 'table', x: 2, y: 2, w: 2, h: 1, variant: 0 }]);
    expect(pinsForLockAll(null, r)).toEqual([]);
  });
  it('never produces a layout that fails validateLayout', () => {
    const r = room();
    const items = Array.from({ length: 80 }, (_, i) => ({ roomId: 'a', kind: 'plant' as const, x: 3 + (i % 8), y: 3 + Math.floor(i / 8) % 6, w: 1, h: 1, variant: 0 }));
    const pins = pinsForLockAll(mapOf(items), r);
    expect(pins.length).toBeLessThanOrEqual(48);
    const issues = validateLayout({ width: 30, height: 20, rooms: [{ ...r, furniture: pins }] });
    expect(issues.filter((i) => i.code === 'pinned-invalid')).toEqual([]);
  });
});

describe('planLockAll', () => {
  it('counts the items that fit but for the per-room cap', () => {
    const items = Array.from({ length: 54 }, (_, i) => ({ roomId: 'a', kind: 'plant' as const, x: 3 + (i % 8), y: 3 + Math.floor(i / 8), w: 1, h: 1 }));
    const r = room({ w: 12, h: 10 });
    const plan = planLockAll(mapOf(items), r);
    expect(plan.pins).toHaveLength(48);
    expect(plan.overflow).toBe(6);
    expect(planLockAll(null, r)).toEqual({ pins: [], overflow: 0 });
  });
});
