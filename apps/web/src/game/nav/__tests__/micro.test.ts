import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../procgen/rng';
import type { Point } from '../../procgen/types';
import { CELL_PX, SUB } from '../constants';
import { anchorOfPoint, computeClearance, createNavGrid, fits, pointOfAnchor, setCell } from '../grid';
import { MACRO_DIAGONAL, MACRO_STRAIGHT } from '../macro';
import { hopWindow, lineOfSight, MICRO_MAX_NODES, microAStar, pullString, supercover } from '../micro';
import type { CellRect, NavGrid } from '../types';

// ------------------------------------------------------------------ helpers

/** An all-walkable grid of `cols x rows` tiles. */
function openGrid(cols: number, rows: number): NavGrid {
  const g = createNavGrid(cols, rows);
  for (let cy = 0; cy < g.crows; cy++) for (let cx = 0; cx < g.ccols; cx++) setCell(g, cx, cy, true);
  computeClearance(g);
  return g;
}

/** Random cells blocked with probability `p` (clearance recomputed). */
function randomGrid(rnd: () => number, cols: number, rows: number, p: number): NavGrid {
  const g = openGrid(cols, rows);
  for (let cy = 0; cy < g.crows; cy++) for (let cx = 0; cx < g.ccols; cx++) if (rnd() < p) setCell(g, cx, cy, false);
  computeClearance(g);
  return g;
}

const EPS = 1e-9;

/** Closed segment between cell centres vs the closed unit square of cell (cx, cy): Liang-Barsky. */
function segmentTouchesCell(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number): boolean {
  const px0 = x0 + 0.5;
  const py0 = y0 + 0.5;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, px0 - cx],
    [dx, cx + 1 - px0],
    [-dy, py0 - cy],
    [dy, cy + 1 - py0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < -EPS) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  return t0 <= t1 + EPS;
}

/** Every cell of the bounding box whose closed square the segment touches. */
function bruteSupercover(x0: number, y0: number, x1: number, y1: number): Set<string> {
  const out = new Set<string>();
  for (let cy = Math.min(y0, y1); cy <= Math.max(y0, y1); cy++) for (let cx = Math.min(x0, x1); cx <= Math.max(x0, x1); cx++) if (segmentTouchesCell(x0, y0, x1, y1, cx, cy)) out.add(`${cx},${cy}`);
  return out;
}

function collect(x0: number, y0: number, x1: number, y1: number): string[] {
  const out: string[] = [];
  supercover(x0, y0, x1, y1, (x, y) => {
    out.push(`${x},${y}`);
    return true;
  });
  return out;
}

/** Reference shortest cost over the micro graph (fitting anchors inside the window, 8-connected, no corner cuts, start always passable). */
function referenceMicroCost(g: NavGrid, s: Point, t: Point, k: number, win: CellRect): number {
  const x0 = Math.max(0, win.x0);
  const y0 = Math.max(0, win.y0);
  const x1 = Math.min(g.ccols, win.x1);
  const y1 = Math.min(g.crows, win.y1);
  const w = x1 - x0;
  const h = y1 - y0;
  const id = (x: number, y: number) => (y - y0) * w + (x - x0);
  const start = id(s.x, s.y);
  const pass = (x: number, y: number): boolean => x >= x0 && y >= y0 && x < x1 && y < y1 && (id(x, y) === start || fits(g, x, y, k));
  const dist = new Array<number>(w * h).fill(Infinity);
  dist[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    const ux = x0 + (u % w);
    const uy = y0 + (u - (u % w)) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const vx = ux + dx;
        const vy = uy + dy;
        if (!pass(vx, vy)) continue;
        if (dx !== 0 && dy !== 0 && !(pass(ux + dx, uy) && pass(ux, uy + dy))) continue;
        const v = id(vx, vy);
        const nd = dist[u]! + (dx !== 0 && dy !== 0 ? MACRO_DIAGONAL : MACRO_STRAIGHT);
        if (nd < dist[v]!) {
          dist[v] = nd;
          queue.push(v);
        }
      }
    }
  }
  return dist[id(t.x, t.y)]!;
}

/** Fixed-point cost of a micro result (anchor steps), asserting 8-adjacency. */
function microCost(pts: Point[], k: number): number {
  let cost = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = anchorOfPoint(pts[i - 1]!, k);
    const b = anchorOfPoint(pts[i]!, k);
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    expect(Math.max(dx, dy), `step ${i} is one anchor cell`).toBe(1);
    cost += dx === 1 && dy === 1 ? MACRO_DIAGONAL : MACRO_STRAIGHT;
  }
  return cost;
}

// ------------------------------------------------------------------ supercover / lineOfSight

describe('supercover', () => {
  it('matches a brute-force closed segment vs closed cell test on 2000 random segments', () => {
    const rnd = mulberry32(0x5c0);
    for (let n = 0; n < 2000; n++) {
      const x0 = Math.floor(rnd() * 16);
      const y0 = Math.floor(rnd() * 16);
      const x1 = Math.floor(rnd() * 16);
      const y1 = Math.floor(rnd() * 16);
      const got = collect(x0, y0, x1, y1);
      const want = bruteSupercover(x0, y0, x1, y1);
      expect(new Set(got), `${x0},${y0} -> ${x1},${y1}`).toEqual(want);
    }
  });

  it('a diagonal visits all four cells around every corner it passes; a straight line only its row', () => {
    expect(collect(0, 0, 2, 2)).toEqual(['0,0', '1,0', '0,1', '1,1', '2,1', '1,2', '2,2']);
    expect(collect(3, 1, 0, 1)).toEqual(['3,1', '2,1', '1,1', '0,1']);
    expect(collect(2, 2, 2, 2)).toEqual(['2,2']);
  });

  it('stops at the first rejected cell and reports it', () => {
    const seen: string[] = [];
    const ok = supercover(0, 0, 4, 0, (x, y) => {
      seen.push(`${x},${y}`);
      return x < 2;
    });
    expect(ok).toBe(false);
    expect(seen).toEqual(['0,0', '1,0', '2,0']);
  });
});

describe('lineOfSight', () => {
  it('holds on an open grid and fails when any touched anchor cell is blocked (k = 1)', () => {
    const g = openGrid(6, 6);
    const a = pointOfAnchor({ x: 0, y: 0 }, 1);
    const b = pointOfAnchor({ x: 10, y: 3 }, 1);
    expect(lineOfSight(g, a, b, 1)).toBe(true);
    setCell(g, 5, 1, false); // on the line (cells 0..10 x 0..3: around the middle, x = 5 is in row 1 or 2)
    setCell(g, 5, 2, false);
    computeClearance(g);
    expect(lineOfSight(g, a, b, 1)).toBe(false);
  });

  it('respects clearance: a person (k = 2) cannot pass a one-cell post a cat (k = 1) walks around', () => {
    const g = openGrid(6, 3);
    // Post at cell (6, 2): row 2 is the bottom cell row of tile row 0 (tiles 0..5 x 0..2; cells 12 x 6).
    setCell(g, 6, 2, false);
    computeClearance(g);
    // k = 2 anchors sliding along cell row 1 (block covers rows 1..2) from x = 0 to x = 10: the block at (5..6, 1..2) overlaps the post.
    const a2 = pointOfAnchor({ x: 0, y: 1 }, 2);
    const b2 = pointOfAnchor({ x: 10, y: 1 }, 2);
    expect(lineOfSight(g, a2, b2, 2)).toBe(false);
    // The same line one row up (block rows 0..1) is clear.
    expect(lineOfSight(g, pointOfAnchor({ x: 0, y: 0 }, 2), pointOfAnchor({ x: 10, y: 0 }, 2), 2)).toBe(true);
    // k = 1 along row 1 never touches the post.
    expect(lineOfSight(g, pointOfAnchor({ x: 0, y: 1 }, 1), pointOfAnchor({ x: 10, y: 1 }, 1), 1)).toBe(true);
    expect(lineOfSight(g, pointOfAnchor({ x: 0, y: 2 }, 1), pointOfAnchor({ x: 10, y: 2 }, 1), 1)).toBe(false);
  });

  it('is false outside the grid', () => {
    const g = openGrid(2, 2);
    expect(lineOfSight(g, { x: 4, y: 4 }, { x: 60, y: 4 }, 1)).toBe(false);
  });
});

// ------------------------------------------------------------------ hopWindow

describe('hopWindow', () => {
  it('is the two tiles cell rect grown by k - 1', () => {
    expect(hopWindow({ x: 3, y: 2 }, { x: 4, y: 2 }, 1)).toEqual({ x0: 6, y0: 4, x1: 10, y1: 6 });
    expect(hopWindow({ x: 3, y: 2 }, { x: 2, y: 3 }, 2)).toEqual({ x0: 3, y0: 3, x1: 9, y1: 9 });
    expect(hopWindow({ x: 0, y: 0 }, { x: 0, y: 0 }, 3)).toEqual({ x0: -2, y0: -2, x1: SUB + 2, y1: SUB + 2 });
  });
});

// ------------------------------------------------------------------ microAStar

describe('microAStar', () => {
  it('is optimal within its window on random grids for k = 1 and k = 2, and every point fits', () => {
    const rnd = mulberry32(0x3a7);
    let found = 0;
    for (let n = 0; n < 300; n++) {
      const k = n % 2 === 0 ? 1 : 2;
      const g = randomGrid(rnd, 6, 6, 0.2);
      const win: CellRect = { x0: 1, y0: 1, x1: 9, y1: 9 };
      const s = { x: 1 + Math.floor(rnd() * 8), y: 1 + Math.floor(rnd() * 8) };
      const t = { x: 1 + Math.floor(rnd() * 8), y: 1 + Math.floor(rnd() * 8) };
      const from = pointOfAnchor(s, k);
      const to = pointOfAnchor(t, k);
      const got = microAStar(g, from, to, k, win);
      if (s.x === t.x && s.y === t.y) {
        expect(got, `${n}: same anchor`).toEqual(fits(g, t.x, t.y, k) ? [from, to] : null);
        continue;
      }
      const want = fits(g, t.x, t.y, k) ? referenceMicroCost(g, s, t, k, win) : Infinity;
      if (got === null) {
        expect(want, `${n}: null only when unreachable`).toBe(Infinity);
        continue;
      }
      found++;
      expect(got[0]).toEqual(from);
      expect(got[got.length - 1]).toEqual(to);
      expect(microCost(got, k), `${n}: optimal`).toBe(want);
      for (let i = 1; i < got.length; i++) {
        const a = anchorOfPoint(got[i]!, k);
        expect(fits(g, a.x, a.y, k), `${n}: point ${i} fits`).toBe(true);
        expect(a.x >= win.x0 && a.x < win.x1 && a.y >= win.y0 && a.y < win.y1, `${n}: point ${i} inside the window`).toBe(true);
        expect(lineOfSight(g, got[i - 1]!, got[i]!, k), `${n}: step ${i} has line of sight`).toBe(i > 1 || fits(g, s.x, s.y, k));
      }
    }
    expect(found).toBeGreaterThan(100);
  });

  it('returns [from, to] for one anchor cell, null for an end outside the window or a target that does not fit', () => {
    const g = openGrid(4, 4);
    const win: CellRect = { x0: 0, y0: 0, x1: 4, y1: 4 };
    const p = pointOfAnchor({ x: 1, y: 1 }, 1);
    expect(microAStar(g, p, { x: p.x + 1, y: p.y + 1 }, 1, win)).toEqual([p, { x: p.x + 1, y: p.y + 1 }]);
    expect(microAStar(g, p, pointOfAnchor({ x: 6, y: 1 }, 1), 1, win)).toBeNull();
    setCell(g, 3, 3, false);
    computeClearance(g);
    expect(microAStar(g, p, pointOfAnchor({ x: 3, y: 3 }, 1), 1, win)).toBeNull();
  });

  it('stops after maxNodes expansions and never cuts a corner', () => {
    const g = openGrid(8, 1);
    const win: CellRect = { x0: 0, y0: 0, x1: 16, y1: 2 };
    const from = pointOfAnchor({ x: 0, y: 0 }, 1);
    const to = pointOfAnchor({ x: 15, y: 0 }, 1);
    expect(microAStar(g, from, to, 1, win, MICRO_MAX_NODES)).not.toBeNull();
    expect(microAStar(g, from, to, 1, win, 4)).toBeNull();
    // A wall with a diagonal-only passage: (1,0) and (0,1) blocked, so (0,0) -> (1,1) would cut both corners.
    const c = openGrid(2, 2);
    setCell(c, 1, 0, false);
    setCell(c, 0, 1, false);
    computeClearance(c);
    expect(microAStar(c, pointOfAnchor({ x: 0, y: 0 }, 1), pointOfAnchor({ x: 1, y: 1 }, 1), 1, { x0: 0, y0: 0, x1: 2, y1: 2 })).toBeNull();
  });

  it('is deterministic', () => {
    const rnd = mulberry32(0x77);
    const g = randomGrid(rnd, 8, 8, 0.25);
    const win: CellRect = { x0: 0, y0: 0, x1: 16, y1: 16 };
    const from = pointOfAnchor({ x: 0, y: 0 }, 1);
    const to = pointOfAnchor({ x: 15, y: 15 }, 1);
    expect(microAStar(g, from, to, 1, win)).toEqual(microAStar(g, from, to, 1, win));
  });
});

// ------------------------------------------------------------------ pullString

describe('pullString', () => {
  it('collapses a straight corridor to its ends and keeps a corner', () => {
    const g = openGrid(8, 8);
    const row = Array.from({ length: 8 }, (_, i) => pointOfAnchor({ x: i, y: 2 }, 1));
    expect(pullString(g, row, 1)).toEqual([row[0], row[7]]);
    // Block the diagonal: an L around a blocked square must keep the corner point.
    for (let cy = 3; cy < 8; cy++) for (let cx = 0; cx < 5; cx++) setCell(g, cx, cy, false);
    computeClearance(g);
    const l = [...row, ...Array.from({ length: 5 }, (_, i) => pointOfAnchor({ x: 7, y: 3 + i }, 1))];
    const pulled = pullString(g, l, 1);
    expect(pulled[0]).toEqual(l[0]);
    expect(pulled[pulled.length - 1]).toEqual(l[l.length - 1]);
    expect(pulled.length).toBeGreaterThan(2);
    expect(pulled.length).toBeLessThan(l.length);
    for (let i = 1; i < pulled.length; i++) expect(lineOfSight(g, pulled[i - 1]!, pulled[i]!, 1)).toBe(true);
    expect(pullString(g, [], 1)).toEqual([]);
    expect(pullString(g, [row[0]!], 1)).toEqual([row[0]]);
  });

  it('uses anchor cells of the class: CELL_PX-sized steps for k = 1', () => {
    expect(pointOfAnchor({ x: 3, y: 0 }, 1)).toEqual({ x: 3.5 * CELL_PX, y: 0.5 * CELL_PX });
  });
});
