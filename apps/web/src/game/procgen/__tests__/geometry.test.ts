import { describe, expect, it } from 'vitest';
import { cellKeys, coveredTileRect, isHalfAligned, overlapsAny, rectCells, snapHalf, tileKey } from '../geometry';
import { mulberry32 } from '../rng';
import type { Point, Rect } from '../types';

/** The integer loop every procgen site used before M15 (generate.ts / pins.ts / triggers.ts). */
function legacyRectCells(r: Rect): Point[] {
  const out: Point[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  return out;
}

describe('geometry: rectCells / cellKeys (M15 rasterizer)', () => {
  it('integer rects produce exactly the legacy loop output, in the same order', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const r: Rect = { x: Math.floor(rand() * 40), y: Math.floor(rand() * 30), w: Math.floor(rand() * 8), h: Math.floor(rand() * 8) };
      expect(rectCells(r)).toEqual(legacyRectCells(r));
      expect(cellKeys(r)).toEqual(legacyRectCells(r).map(tileKey));
    }
  });

  it('a half-offset rect covers every tile it touches (one more column/row on the offset axis)', () => {
    expect(rectCells({ x: 2.5, y: 1, w: 2, h: 1 })).toEqual([{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }]);
    expect(rectCells({ x: 2, y: 1.5, w: 1, h: 1 })).toEqual([{ x: 2, y: 1 }, { x: 2, y: 2 }]);
    expect(cellKeys({ x: 0.5, y: 0.5, w: 1, h: 1 })).toEqual(['0,0', '1,0', '0,1', '1,1']);
    expect(coveredTileRect({ x: 2.5, y: 3, w: 3, h: 2 })).toEqual({ x: 2, y: 3, w: 4, h: 2 });
  });

  it('empty rects cover nothing', () => {
    expect(rectCells({ x: 2.5, y: 1, w: 0, h: 1 })).toEqual([]);
    expect(cellKeys({ x: 1, y: 1, w: 2, h: 0 })).toEqual([]);
  });
});

describe('geometry: overlapsAny is exact, not tile-rounded', () => {
  it('two half-offset pins can share a tile without overlapping', () => {
    const a: Rect = { x: 2, y: 1, w: 1, h: 1 };
    const b: Rect = { x: 3, y: 1, w: 1, h: 1 };
    // `b` ends at 4 and `c` starts at 2.5: they overlap; `a` ends at 3 where `b` starts: they do not.
    expect(overlapsAny(b, [a])).toBe(false);
    expect(overlapsAny({ x: 2.5, y: 1, w: 1, h: 1 }, [b])).toBe(true);
    // `d` at 3.5 touches tile 3 that `a2` (2.5..3.5) also covers, yet the rects only meet at an edge.
    const a2: Rect = { x: 2.5, y: 1, w: 1, h: 1 };
    const d: Rect = { x: 3.5, y: 1, w: 1, h: 1 };
    expect(overlapsAny(d, [a2])).toBe(false);
    expect(cellKeys(a2).filter((k) => cellKeys(d).includes(k))).toEqual(['3,1']);
    expect(overlapsAny(d, [])).toBe(false);
    expect(overlapsAny({ x: 0, y: 0, w: 0, h: 1 }, [a])).toBe(false);
  });
});

describe('geometry: snapHalf / isHalfAligned', () => {
  it('snaps to the nearest half tile', () => {
    expect(snapHalf(2.3)).toBe(2.5);
    expect(snapHalf(2.2)).toBe(2);
    expect(snapHalf(2.76)).toBe(3);
    expect(snapHalf(-0.3)).toBe(-0.5);
    expect(snapHalf(4)).toBe(4);
  });
  it('accepts half positions with whole sizes only', () => {
    expect(isHalfAligned({ x: 2.5, y: 1, w: 2, h: 1 })).toBe(true);
    expect(isHalfAligned({ x: 2, y: 1, w: 2, h: 1 })).toBe(true);
    expect(isHalfAligned({ x: 2.25, y: 1, w: 2, h: 1 })).toBe(false);
    expect(isHalfAligned({ x: 2, y: 1.1, w: 2, h: 1 })).toBe(false);
    expect(isHalfAligned({ x: 2.5, y: 1, w: 1.5, h: 1 })).toBe(false);
    expect(isHalfAligned({ x: 2.5, y: 1, w: 1, h: 0.5 })).toBe(false);
  });
});
