import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../procgen/rng';
import type { Point } from '../../procgen/types';
import { CLASS_K } from '../classes';
import { SUB } from '../constants';
import { computeClearance, createNavGrid, fits, navGridFromWalkable, setCell } from '../grid';
import { createMacroSearch, MACRO_DIAGONAL, MACRO_STRAIGHT, MacroPlanner, tilePassable } from '../macro';
import type { NavGrid } from '../types';

// ------------------------------------------------------------------ helpers

function randomWalkable(rnd: () => number, cols: number, rows: number, pBlocked: number): number[][] {
  const w: number[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: number[] = [];
    for (let x = 0; x < cols; x++) row.push(rnd() < pBlocked ? 1 : 0);
    w.push(row);
  }
  return w;
}

function pickTile(rnd: () => number, w: number[][], blocked: boolean): Point {
  const rows = w.length;
  const cols = w[0]!.length;
  for (;;) {
    const p = { x: Math.floor(rnd() * cols), y: Math.floor(rnd() * rows) };
    if ((w[p.y]![p.x] === 1) === blocked) return p;
  }
}

/**
 * Reference shortest-path cost over the same graph as the macro planner (8 neighbours, a diagonal
 * needs both orthogonals passable, the start tile counts as passable). Label-correcting (SPFA) with
 * the planner's fixed-point costs, so equality is exact. Infinity when unreachable.
 */
function referenceCost(w: number[][], from: Point, to: Point): number {
  const rows = w.length;
  const cols = w[0]!.length;
  const start = from.y * cols + from.x;
  const pass = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < cols && y < rows && (y * cols + x === start || w[y]![x] === 0);
  const dist = new Array<number>(cols * rows).fill(Infinity);
  dist[start] = 0;
  const queue = [start];
  const inQueue = new Uint8Array(cols * rows);
  inQueue[start] = 1;
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    inQueue[u] = 0;
    const ux = u % cols;
    const uy = (u - ux) / cols;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const vx = ux + dx;
        const vy = uy + dy;
        if (!pass(vx, vy)) continue;
        if (dx !== 0 && dy !== 0 && !(pass(ux + dx, uy) && pass(ux, uy + dy))) continue;
        const v = vy * cols + vx;
        const nd = dist[u]! + (dx !== 0 && dy !== 0 ? MACRO_DIAGONAL : MACRO_STRAIGHT);
        if (nd < dist[v]!) {
          dist[v] = nd;
          if (inQueue[v] === 0) {
            inQueue[v] = 1;
            queue.push(v);
          }
        }
      }
    }
  }
  return dist[to.y * cols + to.x]!;
}

/** Fixed-point cost of a tile path; asserts 8-adjacency, passability (except the first tile) and no corner cuts. */
function pathCost(w: number[][], path: Point[]): number {
  let cost = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    expect(Math.max(dx, dy), `step ${i} is 8-adjacent`).toBe(1);
    expect(w[b.y]![b.x], `tile ${i} is walkable`).toBe(0);
    if (dx === 1 && dy === 1) {
      expect(w[a.y]![b.x], `step ${i} does not cut a corner (x side)`).toBe(0);
      expect(w[b.y]![a.x], `step ${i} does not cut a corner (y side)`).toBe(0);
      cost += MACRO_DIAGONAL;
    } else cost += MACRO_STRAIGHT;
  }
  return cost;
}

const gridWith = (cols: number, rows: number, blocked: Point[] = []): number[][] => {
  const w: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (const b of blocked) w[b.y]![b.x] = 1;
  return w;
};

// ------------------------------------------------------------------ optimality (property 9)

describe('MacroPlanner optimality vs a reference search (navigation.md section 5, property 9)', () => {
  it('matches the reference on 500 random grids: same reachability, equal cost, legal steps', () => {
    const rnd = mulberry32(0x5eed);
    const densities = [0.2, 0.35, 0.5];
    let reachable = 0;
    let unreachable = 0;
    for (let i = 0; i < 500; i++) {
      const cols = 20 + Math.floor(rnd() * 29);
      const rows = 20 + Math.floor(rnd() * 29);
      const w = randomWalkable(rnd, cols, rows, densities[i % densities.length]!);
      const planner = new MacroPlanner(navGridFromWalkable(w));
      const from = pickTile(rnd, w, false);
      const to = pickTile(rnd, w, false);
      const path = planner.search(from, to, 'person');
      const ref = referenceCost(w, from, to);
      if (path === null) {
        expect(ref, `grid ${i}: planner null but reference reaches`).toBe(Infinity);
        unreachable++;
        continue;
      }
      expect(ref, `grid ${i}: reference unreachable but planner found a path`).not.toBe(Infinity);
      expect(path[0]).toEqual(from);
      expect(path[path.length - 1]).toEqual(to);
      expect(pathCost(w, path), `grid ${i}: optimal cost`).toBe(ref);
      reachable++;
    }
    // Both branches are exercised (dense grids are often disconnected, sparse ones rarely).
    expect(reachable).toBeGreaterThan(100);
    expect(unreachable).toBeGreaterThan(50);
  });

  it('allowBlockedStart (default true): a blocked start is left once, the rest is optimal and standable', () => {
    const rnd = mulberry32(42);
    let checked = 0;
    for (let i = 0; i < 200 && checked < 60; i++) {
      const w = randomWalkable(rnd, 24, 24, 0.3);
      const planner = new MacroPlanner(navGridFromWalkable(w));
      const from = pickTile(rnd, w, true);
      const to = pickTile(rnd, w, false);
      const path = planner.search(from, to, 'person');
      const ref = referenceCost(w, from, to);
      if (path === null) {
        expect(ref).toBe(Infinity);
        continue;
      }
      expect(path[0]).toEqual(from);
      expect(pathCost(w, path)).toBe(ref); // pathCost checks tiles 1.. are walkable
      expect(planner.search(from, to, 'person', { allowBlockedStart: false })).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

// ------------------------------------------------------------------ semantics

describe('MacroPlanner.search semantics', () => {
  it('returns [from] (the same object) when from equals to, null outside the grid or on an impassable target', () => {
    const planner = new MacroPlanner(navGridFromWalkable(gridWith(6, 6, [{ x: 3, y: 3 }])));
    const from = { x: 1, y: 1 };
    const same = planner.search(from, { x: 1, y: 1 }, 'person');
    expect(same).toHaveLength(1);
    expect(same![0]).toBe(from);
    expect(planner.search({ x: -1, y: 0 }, { x: 1, y: 1 }, 'person')).toBeNull();
    expect(planner.search({ x: 0, y: 0 }, { x: 6, y: 1 }, 'person')).toBeNull();
    expect(planner.search({ x: 0, y: 0 }, { x: 3, y: 3 }, 'person')).toBeNull();
  });

  it('never cuts a corner: a diagonal gap between two blocked tiles is not a passage', () => {
    // 3 x 3: the centre column is blocked except the middle tile; diagonals through (1,1) need (1,0)/(1,2) or (0,*)/(2,*).
    //  . X .
    //  . . .
    //  . X .
    const w = gridWith(3, 3, [
      { x: 1, y: 0 },
      { x: 1, y: 2 },
    ]);
    const planner = new MacroPlanner(navGridFromWalkable(w));
    const path = planner.search({ x: 0, y: 0 }, { x: 2, y: 0 }, 'person')!;
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 0 },
    ]);
    // Fully sealed diagonal: the only route (0,0) -> (1,1) would cut both corners.
    const sealed = new MacroPlanner(
      navGridFromWalkable(
        gridWith(2, 2, [
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ]),
      ),
    );
    expect(sealed.search({ x: 0, y: 0 }, { x: 1, y: 1 }, 'person')).toBeNull();
  });

  it('is deterministic: equal inputs give equal paths, and an open grid costs the octile distance', () => {
    const rnd = mulberry32(3);
    const w = randomWalkable(rnd, 32, 32, 0.25);
    const a = new MacroPlanner(navGridFromWalkable(w));
    const b = createMacroSearch(navGridFromWalkable(w));
    for (let i = 0; i < 30; i++) {
      const from = pickTile(rnd, w, false);
      const to = pickTile(rnd, w, false);
      expect(a.search(from, to, 'person')).toEqual(b.search(from, to, 'person'));
      expect(a.search(from, to, 'person')).toEqual(a.search(from, to, 'person'));
    }
    const open = new MacroPlanner(navGridFromWalkable(gridWith(10, 10)));
    const path = open.search({ x: 0, y: 0 }, { x: 9, y: 4 }, 'person')!;
    expect(pathCost(gridWith(10, 10), path)).toBe(4 * MACRO_DIAGONAL + 5 * MACRO_STRAIGHT);
    expect(path).toHaveLength(10);
  });

  it('blockedOverride excludes tiles for one query; an overridden target is null', () => {
    //  . . .
    //  X . X   -> the only way down is through (1,1)
    //  . . .
    const w = gridWith(3, 3, [
      { x: 0, y: 1 },
      { x: 2, y: 1 },
    ]);
    const planner = new MacroPlanner(navGridFromWalkable(w));
    const g = planner.grid;
    expect(planner.search({ x: 0, y: 0 }, { x: 0, y: 2 }, 'person')).not.toBeNull();
    const override = new Set([1 * g.cols + 1]);
    expect(planner.search({ x: 0, y: 0 }, { x: 0, y: 2 }, 'person', { blockedOverride: override })).toBeNull();
    expect(planner.search({ x: 0, y: 0 }, { x: 1, y: 1 }, 'person', { blockedOverride: override })).toBeNull();
    // The override does not stick.
    expect(planner.search({ x: 0, y: 0 }, { x: 0, y: 2 }, 'person')).not.toBeNull();
  });

  it('invalidate() drops the passability cache after a grid edit', () => {
    const w = gridWith(5, 1);
    const g = navGridFromWalkable(w);
    const planner = new MacroPlanner(g);
    expect(planner.search({ x: 0, y: 0 }, { x: 4, y: 0 }, 'person')).toHaveLength(5);
    for (let cy = 0; cy < SUB; cy++) for (let cx = 2 * SUB; cx < 3 * SUB; cx++) setCell(g, cx, cy, false);
    computeClearance(g);
    // Stale cache: the planner still believes tile 2 is passable.
    expect(planner.search({ x: 0, y: 0 }, { x: 4, y: 0 }, 'person')).toHaveLength(5);
    planner.invalidate();
    expect(planner.search({ x: 0, y: 0 }, { x: 4, y: 0 }, 'person')).toBeNull();
  });
});

// ------------------------------------------------------------------ per-class passability

describe('tilePassable', () => {
  function gridWithHalfTile(): NavGrid {
    // 5 x 5 tiles, all open, then the left half of tile (2,2) is blocked.
    const g = createNavGrid(5, 5);
    for (let cy = 0; cy < g.crows; cy++) for (let cx = 0; cx < g.ccols; cx++) setCell(g, cx, cy, true);
    for (let cy = 2 * SUB; cy < 3 * SUB; cy++) setCell(g, 2 * SUB, cy, false);
    computeClearance(g);
    return g;
  }

  it('person needs the whole tile, small needs one cell, large needs clearance for its block', () => {
    const g = gridWithHalfTile();
    expect(tilePassable(g, 'person', 2, 2)).toBe(false);
    expect(tilePassable(g, 'small', 2, 2)).toBe(true);
    expect(tilePassable(g, 'large', 2, 2)).toBe(false);
    expect(tilePassable(g, 'person', 1, 1)).toBe(true);
    expect(tilePassable(g, 'small', 1, 1)).toBe(true);
    // (0,0) is standable but a 3-cell block at its top-left cell is cut by the half-blocked tile? No: it spans
    // cells 0..2, tile (2,2)'s blocked cells are 4..5. Clearance is 4 there: large fits.
    expect(fits(g, 0, 0, CLASS_K.large)).toBe(true);
    expect(tilePassable(g, 'large', 0, 0)).toBe(true);
    // (1,1) spans cells 2..4 in both axes and cell (4,4) is blocked: large does not fit, person does.
    expect(tilePassable(g, 'large', 1, 1)).toBe(false);
    // A fully blocked tile passes no class; outside the grid passes no class.
    for (let cy = 0; cy < SUB; cy++) for (let cx = 0; cx < SUB; cx++) setCell(g, cx, cy, false);
    computeClearance(g);
    for (const cls of ['person', 'small', 'large'] as const) {
      expect(tilePassable(g, cls, 0, 0), cls).toBe(false);
      expect(tilePassable(g, cls, 5, 0), cls).toBe(false);
      expect(tilePassable(g, cls, 0, -1), cls).toBe(false);
    }
  });

  it('small routes through a half-tile gap a person cannot pass', () => {
    // 3 x 1 tiles; the middle tile keeps only its right column of cells.
    const g = createNavGrid(3, 1);
    for (let cy = 0; cy < g.crows; cy++) for (let cx = 0; cx < g.ccols; cx++) setCell(g, cx, cy, true);
    for (let cy = 0; cy < SUB; cy++) setCell(g, SUB, cy, false);
    computeClearance(g);
    const planner = new MacroPlanner(g);
    expect(planner.search({ x: 0, y: 0 }, { x: 2, y: 0 }, 'person')).toBeNull();
    expect(planner.search({ x: 0, y: 0 }, { x: 2, y: 0 }, 'small')).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });
});
