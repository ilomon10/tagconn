import { describe, expect, it } from 'vitest';
import { BIT, cellOrigin, QUADRANTS, quadrantRect, type Quadrant } from '../dualGrid';
import { boundaryHalfEdges, cornerCut, HALF_EDGE_QUADRANTS, halfEdgeStrip, shapeOf, SIDES, type Shape } from '../dualGeom';

const T = 16;

/** The section 1.4 table, verbatim. */
const TABLE: Record<number, Shape> = {
  0: { kind: 'none' },
  15: { kind: 'none' },
  12: { kind: 'edge', side: 'n' },
  3: { kind: 'edge', side: 's' },
  10: { kind: 'edge', side: 'w' },
  5: { kind: 'edge', side: 'e' },
  8: { kind: 'convex', q: 'tl' },
  4: { kind: 'convex', q: 'tr' },
  2: { kind: 'convex', q: 'bl' },
  1: { kind: 'convex', q: 'br' },
  7: { kind: 'concave', notch: 'tl' },
  11: { kind: 'concave', notch: 'tr' },
  13: { kind: 'concave', notch: 'bl' },
  14: { kind: 'concave', notch: 'br' },
  9: { kind: 'diagonal', pair: 'tl-br' },
  6: { kind: 'diagonal', pair: 'tr-bl' },
};

function inside(r: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h;
}

describe('dualGeom', () => {
  it('shapeOf matches the 16-case table', () => {
    for (let mask = 0; mask < 16; mask++) expect(shapeOf(mask), `mask ${mask}`).toEqual(TABLE[mask]);
    expect(shapeOf(0x1f)).toEqual(TABLE[15]); // high bits are ignored
  });

  it('boundaryHalfEdges: 0 for none, 2 for edge/convex/concave, 4 for diagonal; each separates set from unset', () => {
    for (let mask = 0; mask < 16; mask++) {
      const sides = boundaryHalfEdges(mask);
      const shape = shapeOf(mask);
      const expected = shape.kind === 'none' ? 0 : shape.kind === 'diagonal' ? 4 : 2;
      expect(sides, `mask ${mask}`).toHaveLength(expected);
      for (const side of SIDES) {
        const [a, b] = HALF_EDGE_QUADRANTS[side];
        const differs = ((mask & BIT[a]) !== 0) !== ((mask & BIT[b]) !== 0);
        expect(sides.includes(side), `mask ${mask} side ${side}`).toBe(differs);
      }
    }
    expect(boundaryHalfEdges(12)).toEqual(['e', 'w']);
    expect(boundaryHalfEdges(8)).toEqual(['n', 'w']);
    expect(boundaryHalfEdges(7)).toEqual(['n', 'w']);
  });

  it('halfEdgeStrip lies inside the cell and inside the towards quadrant, hugging the centre cross', () => {
    const cell = { cx: 2, cy: 3 };
    const { px, py } = cellOrigin(cell, T);
    const bounds = { x: px, y: py, w: T, h: T };
    const c = { x: px + T / 2, y: py + T / 2 };
    for (const side of SIDES) {
      for (const towards of HALF_EDGE_QUADRANTS[side]) {
        for (const t of [1, 2] as const) {
          const r = halfEdgeStrip(px, py, T, side, towards, t);
          const label = `${side} towards ${towards} t=${t}`;
          expect(inside(r, bounds), `${label} leaves the cell`).toBe(true);
          expect(inside(r, quadrantRect(cell, towards, T)), `${label} leaves the quadrant`).toBe(true);
          // The strip is t px thick across the half-edge and T/2 long along it, touching the centre line.
          if (side === 'n' || side === 's') {
            expect(r.w).toBe(t);
            expect(r.h).toBe(T / 2);
            expect(r.x === c.x - t || r.x === c.x).toBe(true);
          } else {
            expect(r.h).toBe(t);
            expect(r.w).toBe(T / 2);
            expect(r.y === c.y - t || r.y === c.y).toBe(true);
          }
        }
      }
    }
    expect(halfEdgeStrip(px, py, T, 'n', 'tl', 1)).toEqual({ x: c.x - 1, y: py, w: 1, h: T / 2 });
    expect(halfEdgeStrip(px, py, T, 'n', 'tr', 2)).toEqual({ x: c.x, y: py, w: 2, h: T / 2 });
    expect(halfEdgeStrip(px, py, T, 'e', 'br', 1)).toEqual({ x: c.x, y: c.y, w: T / 2, h: 1 });
    expect(halfEdgeStrip(px, py, T, 'w', 'tl', 2)).toEqual({ x: px, y: c.y - 2, w: T / 2, h: 2 });
    expect(halfEdgeStrip(px, py, T, 's', 'bl', 1)).toEqual({ x: c.x - 1, y: c.y, w: 1, h: T / 2 });
    expect(() => halfEdgeStrip(px, py, T, 'n', 'br', 1)).toThrow();
  });

  it('cornerCut r=1 and r=2 pixels are inside the quadrant and touch the centre', () => {
    const cell = { cx: 1, cy: 1 };
    const c = { x: cell.cx * T, y: cell.cy * T };
    for (const q of QUADRANTS) {
      const quad = quadrantRect(cell, q, T);
      for (const r of [1, 2] as const) {
        const px = cornerCut(cell, q, r, T);
        expect(px, `${q} r=${r}`).toHaveLength(r === 1 ? 1 : 3);
        for (const p of px) {
          expect(p.w).toBe(1);
          expect(p.h).toBe(1);
          expect(inside(p, quad), `${q} r=${r} ${JSON.stringify(p)} leaves the quadrant`).toBe(true);
        }
        // The (0,0) pixel is the one diagonally adjacent to the centre point.
        const first = px[0]!;
        const touchesX = first.x === c.x || first.x + 1 === c.x;
        const touchesY = first.y === c.y || first.y + 1 === c.y;
        expect(touchesX && touchesY, `${q} r=${r} first pixel ${JSON.stringify(first)} does not touch the centre`).toBe(true);
        // The r=2 pixels form an L: one step out along x and one along y, each touching the centre line.
        if (r === 2) {
          expect(px[1]!.y).toBe(first.y);
          expect(Math.abs(px[1]!.x - first.x)).toBe(1);
          expect(px[2]!.x).toBe(first.x);
          expect(Math.abs(px[2]!.y - first.y)).toBe(1);
        }
      }
    }
    const expected: Record<Quadrant, { x: number; y: number }> = {
      tl: { x: c.x - 1, y: c.y - 1 },
      tr: { x: c.x, y: c.y - 1 },
      bl: { x: c.x - 1, y: c.y },
      br: { x: c.x, y: c.y },
    };
    for (const q of QUADRANTS) expect(cornerCut(cell, q, 1, T)).toEqual([{ ...expected[q], w: 1, h: 1 }]);
  });
});
