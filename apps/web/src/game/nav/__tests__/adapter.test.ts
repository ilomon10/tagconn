import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../procgen/generate';
import { mulberry32 } from '../../procgen/rng';
import type { Point } from '../../procgen/types';
import { CELL_PX, TILE_PX } from '../constants';
import { buildNavGrid, isTileStandable, navPointOfTile } from '../grid';
import { collapseToTiles, PathFinder } from '../adapter';

const gridWith = (cols: number, rows: number, blocked: Point[] = []): number[][] => {
  const w: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (const b of blocked) w[b.y]![b.x] = 1;
  return w;
};

/** The old wrapper's contract on a path: both ends, 8-adjacent, no duplicates, no corner cut, every tile after the first standable. */
function checkPath(finder: PathFinder, path: Point[], from: Point, to: Point): void {
  expect(path[0]).toEqual({ x: from.x, y: from.y });
  expect(path[path.length - 1]).toEqual({ x: to.x, y: to.y });
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    expect(Math.max(dx, dy), `step ${i} is 8-adjacent and not a duplicate`).toBe(1);
    expect(finder.isWalkable(b), `tile ${i} is standable`).toBe(true);
    if (dx === 1 && dy === 1) {
      expect(finder.isWalkable({ x: b.x, y: a.y }), `step ${i} corner (x side)`).toBe(true);
      expect(finder.isWalkable({ x: a.x, y: b.y }), `step ${i} corner (y side)`).toBe(true);
    }
  }
}

describe('PathFinder (nav adapter, navigation.md section 4.5 semantics)', () => {
  //  . . . . .
  //  . X X X .
  //  . . . . .
  const walkable = gridWith(5, 3, [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
  ]);

  it('accepts a legacy number[][] grid and a NavGrid, and isWalkable mirrors walkable === 0', () => {
    const legacy = new PathFinder(walkable);
    const map = generateMap(DEFAULT_LAYOUT);
    const fromNav = new PathFinder(map.nav!);
    expect(legacy.nav.cols).toBe(5);
    expect(legacy.nav.rows).toBe(3);
    expect(fromNav.nav).toBe(map.nav);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) expect(legacy.isWalkable({ x, y })).toBe(walkable[y]![x] === 0);
    for (let y = 0; y < map.rows; y++) for (let x = 0; x < map.cols; x++) expect(fromNav.isWalkable({ x, y })).toBe(map.walkable[y]![x] === 0);
    expect(legacy.isWalkable({ x: -1, y: 0 })).toBe(false);
    expect(legacy.isWalkable({ x: 5, y: 0 })).toBe(false);
  });

  it('semantic 1: null when either end is outside the grid or the target is not standable', () => {
    const finder = new PathFinder(walkable);
    expect(finder.find({ x: -1, y: 0 }, { x: 0, y: 0 })).toBeNull();
    expect(finder.find({ x: 0, y: 3 }, { x: 0, y: 0 })).toBeNull();
    expect(finder.find({ x: 0, y: 0 }, { x: 5, y: 0 })).toBeNull();
    expect(finder.find({ x: 0, y: 0 }, { x: 0, y: -1 })).toBeNull();
    expect(finder.find({ x: 0, y: 0 }, { x: 2, y: 1 })).toBeNull();
    // The old wrapper checked the target before equality: a blocked tile is null even from itself.
    expect(finder.find({ x: 2, y: 1 }, { x: 2, y: 1 })).toBeNull();
  });

  it('semantic 2: [from] (the same object) when from equals to', () => {
    const finder = new PathFinder(walkable);
    const from = { x: 4, y: 2 };
    const path = finder.find(from, { x: 4, y: 2 });
    expect(path).toHaveLength(1);
    expect(path![0]).toBe(from);
  });

  it('semantic 3: a blocked start is allowed; every later tile is standable', () => {
    const finder = new PathFinder(walkable);
    const path = finder.find({ x: 2, y: 1 }, { x: 4, y: 2 })!;
    expect(path).not.toBeNull();
    expect(finder.isWalkable(path[0]!)).toBe(false);
    checkPath(finder, path, { x: 2, y: 1 }, { x: 4, y: 2 });
    // The grid is left untouched (the old wrapper flipped the start tile and restored it).
    expect(walkable[1]![2]).toBe(1);
    expect(finder.isWalkable({ x: 2, y: 1 })).toBe(false);
  });

  it('semantic 4: both ends included, 8-adjacent, no duplicates, never a corner cut (around the wall)', () => {
    const finder = new PathFinder(walkable);
    const path = finder.find({ x: 0, y: 2 }, { x: 4, y: 2 })!;
    checkPath(finder, path, { x: 0, y: 2 }, { x: 4, y: 2 });
    expect(path).toEqual([
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ]);
    const over = finder.find({ x: 0, y: 2 }, { x: 4, y: 0 })!;
    checkPath(finder, over, { x: 0, y: 2 }, { x: 4, y: 0 });
    // No diagonal is legal here ((0,1)->(1,0) would cut (1,1)); either way around the wall is 6 straight steps.
    expect(over).toHaveLength(7);
    expect(over.every((p, i) => i === 0 || Math.abs(p.x - over[i - 1]!.x) + Math.abs(p.y - over[i - 1]!.y) === 1)).toBe(true);
    const sealed = new PathFinder(
      gridWith(2, 2, [
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]),
    );
    expect(sealed.find({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it('semantic 6: deterministic, and the result is a fresh array of fresh points', () => {
    const finder = new PathFinder(walkable);
    const from = { x: 0, y: 0 };
    const to = { x: 4, y: 2 };
    const a = finder.find(from, to)!;
    const b = finder.find(from, to)!;
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(from);
    expect(a[a.length - 1]).not.toBe(to);
  });

  it('property 7 on a generated map: spawn -> every seat crosses only standable tiles; the same from a blocked start', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const finder = new PathFinder(map.nav ?? buildNavGrid(map));
    const legacy = new PathFinder(map.walkable);
    let seats = 0;
    for (const room of map.rooms) {
      for (const seat of room.seats) {
        const path = finder.find(map.spawn, seat);
        expect(path, `${room.id} seat ${seat.x},${seat.y}`).not.toBeNull();
        checkPath(finder, path!, map.spawn, seat);
        expect(legacy.find(map.spawn, seat)).toEqual(path);
        seats++;
      }
    }
    expect(seats).toBeGreaterThan(10);
    // A blocked start next to a corridor (a desk tile) still reaches the spawn.
    const desk = map.furniture.find((f) => f.kind === 'work-desk' && !isTileStandable(map.nav!, Math.floor(f.x), Math.floor(f.y)));
    expect(desk).toBeDefined();
    const start = { x: Math.floor(desk!.x), y: Math.floor(desk!.y) };
    const path = finder.find(start, map.spawn);
    expect(path).not.toBeNull();
    checkPath(finder, path!, start, map.spawn);
  });
});

describe('collapseToTiles', () => {
  it('maps nav points to tiles and drops consecutive duplicates, keeping both ends', () => {
    const pts: Point[] = [
      { x: 8, y: 8 }, // tile 0,0
      { x: 12, y: 9 }, // tile 0,0 again
      { x: 24, y: 8 }, // tile 1,0
      { x: 24, y: 24 }, // tile 1,1
      { x: 25, y: 26 }, // tile 1,1 again
      { x: 40, y: 40 }, // tile 2,2
    ];
    expect(collapseToTiles(pts)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(collapseToTiles([])).toEqual([]);
    expect(collapseToTiles([{ x: 3, y: 3 }])).toEqual([{ x: 0, y: 0 }]);
    // Non-consecutive repeats are kept (a path may come back).
    expect(collapseToTiles([{ x: 8, y: 8 }, { x: 24, y: 8 }, { x: 8, y: 8 }])).toHaveLength(3);
  });

  it('is idempotent through navPointOfTile: collapse(tiles.map(navPointOfTile)) === tiles for a duplicate-free tile path', () => {
    const rnd = mulberry32(11);
    for (let round = 0; round < 50; round++) {
      // A random 8-connected walk starting well inside the positive quadrant (no step is a duplicate).
      const tiles: Point[] = [{ x: 40 + Math.floor(rnd() * 20), y: 40 + Math.floor(rnd() * 20) }];
      for (let i = 0; i < 30; i++) {
        const last = tiles[tiles.length - 1]!;
        const dx = Math.floor(rnd() * 3) - 1;
        const dy = Math.floor(rnd() * 3) - 1;
        if (dx === 0 && dy === 0) continue;
        tiles.push({ x: last.x + dx, y: last.y + dy });
      }
      const once = collapseToTiles(tiles.map((t) => navPointOfTile(t)));
      // Any k: every anchor point of a tile lies inside it.
      const smallOnce = collapseToTiles(tiles.map((t) => navPointOfTile(t, 1)));
      expect(once).toEqual(tiles);
      expect(smallOnce).toEqual(tiles);
      expect(collapseToTiles(once.map((t) => navPointOfTile(t)))).toEqual(once);
      // Points sampled every CELL_PX along a segment collapse to the same tiles as the segment's ends when they are adjacent.
      const a = navPointOfTile(tiles[0]!);
      const b = navPointOfTile(tiles[1]!);
      const samples: Point[] = [];
      const steps = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / CELL_PX);
      for (let s = 0; s <= steps; s++) samples.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
      const collapsed = collapseToTiles(samples);
      expect(collapsed[0]).toEqual(tiles[0]);
      expect(collapsed[collapsed.length - 1]).toEqual(tiles[1]);
      expect(collapsed.length).toBeLessThanOrEqual(TILE_PX / CELL_PX + 1);
    }
  });
});
