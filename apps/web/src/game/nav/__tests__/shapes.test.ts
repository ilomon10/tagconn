import { describe, expect, it } from 'vitest';
import { KIND_BLOCKING } from '../../procgen/pins';
import type { FurnitureKind } from '../../procgen/types';
import { blockedCells, insetFor, KIND_SHAPE, rotateShape } from '../shapes';
import type { CellRect } from '../types';

const cells: CellRect = { x0: 4, y0: 6, x1: 8, y1: 10 }; // 4 x 4 cells

const blockedIn = (pred: (cx: number, cy: number) => boolean, r: CellRect): string[] => {
  const out: string[] = [];
  for (let cy = r.y0 - 1; cy <= r.y1; cy++) for (let cx = r.x0 - 1; cx <= r.x1; cx++) if (pred(cx, cy)) out.push(`${cx},${cy}`);
  return out;
};

const TUNED: Partial<Record<FurnitureKind, unknown>> = {
  'work-desk': { inset: { n: 0, e: 0, s: 1, w: 0 } },
  'lead-desk': { inset: { n: 0, e: 0, s: 1, w: 0 } },
  'reading-table': { inset: { n: 0, e: 0, s: 1, w: 0 } },
  booth: { inset: { n: 0, e: 0, s: 1, w: 0 } },
  'standing-table': { inset: { n: 1, e: 0, s: 1, w: 0 } },
  plant: { inset: { n: 1, e: 1, s: 1, w: 1 } },
  lamp: { inset: { n: 1, e: 1, s: 1, w: 1 } },
};

describe('KIND_SHAPE', () => {
  it('has an entry for every FurnitureKind; untuned kinds are full or none per KIND_BLOCKING; the tuned table matches furnishing.md 4.1', () => {
    const kinds = Object.keys(KIND_BLOCKING) as FurnitureKind[];
    expect(Object.keys(KIND_SHAPE).sort()).toEqual([...kinds].sort());
    for (const k of kinds) {
      if (k in TUNED) expect(KIND_SHAPE[k], k).toEqual(TUNED[k]);
      else if (k !== 'centerpiece') expect(KIND_SHAPE[k], k).toBe(KIND_BLOCKING[k] ? 'full' : 'none');
    }
    expect(KIND_SHAPE.table).toBe('full');
  });

  it('every inset is >= 0 cells', () => {
    for (const shape of Object.values(KIND_SHAPE)) {
      if (typeof shape === 'object' && 'inset' in shape) for (const v of Object.values(shape.inset)) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('the centerpiece is round: corner cells open, the rest blocked', () => {
    const pred = blockedCells(KIND_SHAPE.centerpiece, cells);
    expect(blockedIn(pred, cells)).toHaveLength(12);
    for (const [x, y] of [[4, 6], [7, 6], [4, 9], [7, 9]] as const) expect(pred(x, y)).toBe(false);
  });
});

describe('insetFor', () => {
  const desk = (f: 's' | 'n' | 'e' | 'w') => insetFor('work-desk', f);
  it('rotates the chair side with the facing', () => {
    expect(desk('s')).toEqual({ inset: { n: 0, e: 0, s: 1, w: 0 } });
    expect(desk('n')).toEqual({ inset: { n: 1, e: 0, s: 0, w: 0 } });
    expect(desk('e')).toEqual({ inset: { n: 0, e: 1, s: 0, w: 0 } });
    expect(desk('w')).toEqual({ inset: { n: 0, e: 0, s: 0, w: 1 } });
  });

  it('defaults to s and leaves full / none / mask shapes alone', () => {
    expect(insetFor('work-desk')).toEqual(desk('s'));
    expect(insetFor('counter', 'e')).toBe('full');
    expect(insetFor('chair', 'n')).toBe('none');
    expect(rotateShape(KIND_SHAPE.centerpiece, 'w')).toBe(KIND_SHAPE.centerpiece);
  });

  it('an inset keeps its total thickness under rotation', () => {
    const total = (sh: ReturnType<typeof insetFor>) => (typeof sh === 'object' && 'inset' in sh ? Object.values(sh.inset).reduce((a, b) => a + b, 0) : -1);
    for (const f of ['n', 'e', 's', 'w'] as const) expect(total(insetFor('standing-table', f))).toBe(2);
  });

  it('a kind that is not an own key gets no inset (full block), never an inherited value', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope']) expect(insetFor(k, 'e'), k).toBe('full');
  });

  it('a desk frees exactly its chair-side cell row', () => {
    const pred = blockedCells(desk('e') as never, cells);
    expect(blockedIn(pred, cells)).toHaveLength(12); // east column open
    expect(pred(7, 6)).toBe(false);
    expect(pred(6, 6)).toBe(true);
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
