import { describe, expect, it } from 'vitest';
import { validateLayout, type LayoutRoom, type PinnedFurniture } from '@tagconn/shared';
import type { GeneratedMap } from '../../game/procgen';
import { clampPinPos, hitFurnitureAt, isPinnableItem, isSuppressibleKind, pinFits, pinFromPlaced, planLockAll, pinsForLockAll, prunePins, rotatedPin, snapHalf, unpinnableReason } from './pins';

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
  it('snapHalf rounds to the nearest half tile (M15)', () => {
    expect(snapHalf(2)).toBe(2);
    expect(snapHalf(2.5)).toBe(2.5);
    expect(snapHalf(2.3)).toBe(2.5);
    expect(snapHalf(2.74)).toBe(2.5);
    expect(snapHalf(2.76)).toBe(3);
    expect(snapHalf(0.2)).toBe(0);
    expect(snapHalf(-0.2)).toBe(0);
  });
  it('clampPinPos snaps to halves first, and the clamp bound (inner.w - pin.w) keeps the alignment', () => {
    expect(clampPinPos(room(), pin(), { x: 2.3, y: 1.7 })).toEqual({ x: 2.5, y: 1.5 });
    expect(clampPinPos(room(), pin(), { x: 7.4, y: 5.2 })).toEqual({ x: 7, y: 5 }); // 7.5 would poke out of the 8x6 interior
    expect(clampPinPos(room(), pin({ w: 2, h: 2 }), { x: 6.4, y: -0.3 })).toEqual({ x: 6, y: 0 });
    expect(clampPinPos(room(), pin({ w: 2, h: 2 }), { x: 5.6, y: 3.9 })).toEqual({ x: 5.5, y: 4 });
    const at = clampPinPos(room(), pin({ w: 3 }), { x: 4.9, y: 0.4 });
    expect([at.x * 2, at.y * 2].every(Number.isInteger)).toBe(true);
    expect(at).toEqual({ x: 5, y: 0.5 });
  });
  it('pinFits uses real rect bounds with half pins and seals a door from any covered apron tile', () => {
    const r = room({ furniture: [pin({ x: 2, y: 2 })], doors: [{ side: 'n', offset: 4, width: 1 }] });
    expect(pinFits(r, pin({ x: 2.5, y: 2 }))).toBe(false); // half overlap with the (2,2) pin
    expect(pinFits(r, pin({ x: 2.5, y: 3 }))).toBe(true);
    expect(pinFits(r, pin({ x: 3, y: 2 }))).toBe(true); // edge-adjacent
    expect(pinFits(r, pin({ x: 7.5, y: 0 }))).toBe(false); // 7.5 + 1 > 8
    expect(pinFits(r, pin({ x: 7, y: 5.5 }))).toBe(false);
    // Door n offset 4 -> apron tile (3,0): a pin at 2.5 covers tiles 2 and 3, one at 3.5 covers 3 and 4, both seal it.
    expect(pinFits(r, pin({ x: 2.5, y: 0 }))).toBe(false);
    expect(pinFits(r, pin({ x: 3.5, y: 0 }))).toBe(false);
    expect(pinFits(r, pin({ x: 3, y: 0.5 }))).toBe(false); // covers rows 0 and 1
    expect(pinFits(r, pin({ x: 1.5, y: 0 }))).toBe(true); // tiles 1 and 2
    expect(pinFits(r, pin({ x: 4, y: 0 }))).toBe(true);
  });
  it('prunePins keeps half pins that still fit and drops those poking out', () => {
    const r = room({ furniture: [pin({ x: 6.5, y: 4.5 }), pin({ kind: 'lamp', x: 0.5, y: 0.5 })] });
    expect(prunePins(r)).toBe(r);
    expect(prunePins({ ...r, w: 9 }).furniture).toEqual([pin({ kind: 'lamp', x: 0.5, y: 0.5 })]); // interior 7 wide: 6.5 + 1 > 7
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
  it('tells two half-offset items sharing a tile apart at a fractional point (M15 half-cell resolution)', () => {
    // Interior starts at world (3,3): pin A spans world x 3.5..4.5, pin B 4.5..5.5; both cover tile x=4.
    const halves = [room({ furniture: [pin({ kind: 'a-lamp', x: 0.5, y: 1 }), pin({ kind: 'b-lamp', x: 1.5, y: 1 })] })];
    expect(hitFurnitureAt(null, halves, { x: 4.25, y: 4.5 })).toMatchObject({ pinIndex: 0, item: { kind: 'a-lamp', x: 3.5 } });
    expect(hitFurnitureAt(null, halves, { x: 4.75, y: 4.5 })).toMatchObject({ pinIndex: 1, item: { kind: 'b-lamp', x: 4.5 } });
    expect(hitFurnitureAt(null, halves, { x: 4.5, y: 4.5 })).toMatchObject({ pinIndex: 1 }); // the start edge is inclusive
    expect(hitFurnitureAt(null, halves, { x: 3.25, y: 4.5 })).toBeNull(); // the tile's empty left half
    expect(hitFurnitureAt(null, halves, { x: 4.25, y: 3.9 })).toBeNull(); // the row above
    // A whole-tile point still works (and a fractional point still finds a generated item).
    const map = mapOf([{ roomId: 'a', kind: 'rug', x: 6, y: 6, w: 2, h: 2, variant: 0 }]);
    expect(hitFurnitureAt(map, halves, { x: 7, y: 7 })).toMatchObject({ pinIndex: null, item: { kind: 'rug' } });
    expect(hitFurnitureAt(map, halves, { x: 7.9, y: 6.1 })).toMatchObject({ item: { kind: 'rug' } });
    expect(hitFurnitureAt(map, halves, { x: 8.1, y: 6.1 })).toBeNull();
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

describe('M16: ghosts, rotation, slots', () => {
  it('pinFromPlaced keeps slotId as fromSlot and facing', () => {
    expect(pinFromPlaced({ kind: 'chair', x: 5, y: 4, w: 1, h: 1, facing: 'n', slotId: 'desk:2' }, { x: 3, y: 3, w: 8, h: 6 })).toEqual({
      kind: 'chair', x: 2, y: 1, w: 1, h: 1, facing: 'n', fromSlot: 'desk:2',
    });
  });
  it('hitFurnitureAt carries slotId and facing of a generated item', () => {
    const hit = hitFurnitureAt(mapOf([{ roomId: 'a', kind: 'chair', x: 4, y: 4, w: 1, h: 1, facing: 'e', slotId: 'desk:1' }]), [room()], { x: 4.2, y: 4.2 });
    expect(hit?.item).toMatchObject({ facing: 'e', slotId: 'desk:1' });
  });
  it('a ghost is hit-testable and overlaps/aprons do not apply to it', () => {
    const ghost = pin({ kind: 'chair', x: 1, y: 0, suppressed: true, fromSlot: 'chair:0' });
    const r = room({ furniture: [ghost], doors: [{ side: 'n', offset: 2, width: 1 }] });
    expect(hitFurnitureAt(null, [r], { x: 4.5, y: 3.5 })?.pinIndex).toBe(0);
    expect(pinFits(r, ghost)).toBe(true); // a ghost on a door apron is fine
    expect(pinFits(room({ furniture: [ghost] }), pin({ x: 1, y: 0 }))).toBe(true); // a real pin may overlap a ghost
    expect(prunePins(r)).toBe(r);
  });
  it('isSuppressibleKind is own-property and rejects stairs', () => {
    expect(isSuppressibleKind('work-desk')).toBe(true);
    expect(isSuppressibleKind('stairs-up')).toBe(false);
    expect(isSuppressibleKind('constructor')).toBe(false);
    expect(isSuppressibleKind('__proto__')).toBe(false);
  });
  it('rotatedPin cycles with the swap, keeps the centre, and refuses fixed kinds, ghosts and misfits', () => {
    const r = room();
    const sofa = rotatedPin(r, pin({ kind: 'sofa', x: 2, y: 2, w: 3, h: 1 }));
    expect(sofa).toMatchObject({ facing: 'w', w: 1, h: 3, x: 3, y: 1 });
    expect(rotatedPin(r, pin({ kind: 'work-desk', w: 2 }))).toBeNull();
    expect(rotatedPin(r, pin({ kind: 'bench', w: 2, suppressed: true, fromSlot: 'bench:0' }))).toBeNull();
    expect(rotatedPin(r, pin({ kind: 'constructor', w: 2 }))).toBeNull();
    // 'n' -> back to canonical size, from an 'e' pin
    expect(rotatedPin(r, pin({ kind: 'bench', x: 1, y: 1, w: 1, h: 2, facing: 'w' }))).toMatchObject({ facing: 'n', w: 2, h: 1 });
  });
  it('planLockAll copies the slot, so Lock all never duplicates', () => {
    const out = planLockAll(mapOf([{ roomId: 'a', kind: 'work-desk', x: 4, y: 4, w: 2, h: 1, slotId: 'desk:0' }]), room());
    expect(out.pins[0]).toMatchObject({ fromSlot: 'desk:0' });
  });
  it('ghosts count toward the planLockAll cap', () => {
    const ghosts = Array.from({ length: 48 }, (_, i) => pin({ kind: 'crate', x: i % 8, y: Math.floor(i / 8), suppressed: true, fromSlot: `crate:${i}` }));
    const out = planLockAll(mapOf([{ roomId: 'a', kind: 'plant', x: 9, y: 8, w: 1, h: 1 }]), room({ furniture: ghosts }));
    expect(out.pins).toEqual([]);
    expect(out.overflow).toBe(1);
  });
});
