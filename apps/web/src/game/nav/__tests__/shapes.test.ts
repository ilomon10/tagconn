import { describe, expect, it } from 'vitest';
import { KIND_BLOCKING } from '../../procgen/pins';
import type { FurnitureKind } from '../../procgen/types';
import { blockedCells, KIND_SHAPE } from '../shapes';
import type { CellRect } from '../types';

const cells: CellRect = { x0: 4, y0: 6, x1: 8, y1: 10 }; // 4 x 4 cells

const blockedIn = (pred: (cx: number, cy: number) => boolean, r: CellRect): string[] => {
  const out: string[] = [];
  for (let cy = r.y0 - 1; cy <= r.y1; cy++) for (let cx = r.x0 - 1; cx <= r.x1; cx++) if (pred(cx, cy)) out.push(`${cx},${cy}`);
  return out;
};

describe('KIND_SHAPE', () => {
  it('has an entry for every FurnitureKind and matches KIND_BLOCKING in M15 (full or none, nothing else yet)', () => {
    const kinds = Object.keys(KIND_BLOCKING) as FurnitureKind[];
    expect(Object.keys(KIND_SHAPE).sort()).toEqual([...kinds].sort());
    for (const k of kinds) expect(KIND_SHAPE[k], k).toBe(KIND_BLOCKING[k] ? 'full' : 'none');
  });
});

describe('blockedCells', () => {
  it("'full' blocks exactly the rect, never outside it", () => {
    const pred = blockedCells('full', cells);
    expect(blockedIn(pred, cells)).toHaveLength(16);
    expect(pred(3, 6)).toBe(false);
    expect(pred(8, 6)).toBe(false);
    expect(pred(4, 5)).toBe(false);
    expect(pred(4, 10)).toBe(false);
  });

  it("'none' blocks nothing", () => {
    expect(blockedIn(blockedCells('none', cells), cells)).toEqual([]);
  });

  it('inset shrinks each edge by its cell count', () => {
    const pred = blockedCells({ inset: { n: 1, e: 0, s: 2, w: 1 } }, cells);
    // x 5..7, y 7..7
    expect(blockedIn(pred, cells)).toEqual(['5,7', '6,7', '7,7']);
  });

  it('an inset larger than the footprint blocks nothing', () => {
    expect(blockedIn(blockedCells({ inset: { n: 3, e: 0, s: 3, w: 0 } }, cells), cells)).toEqual([]);
  });

  it('a mask is sampled relative to the footprint and gets its size in cells', () => {
    let seen: [number, number] | undefined;
    const pred = blockedCells(
      {
        mask: (w, h) => {
          seen = [w, h];
          return Array.from({ length: h }, (_, cy) => Array.from({ length: w }, (_, cx) => cx === cy));
        },
      },
      cells,
    );
    expect(seen).toEqual([4, 4]);
    expect(blockedIn(pred, cells)).toEqual(['4,6', '5,7', '6,8', '7,9']);
    expect(pred(3, 5)).toBe(false); // outside the rect even though mask[-1] is undefined
  });
});
