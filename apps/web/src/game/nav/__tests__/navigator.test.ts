import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, hasLayoutErrors, type OfficeLayout } from '@tagconn/shared';
import { generateRandomLayout } from '../../procgen/bsp';
import { generateMap } from '../../procgen/generate';
import { mulberry32 } from '../../procgen/rng';
import type { PlacedFurniture, Point, Rect } from '../../procgen/types';
import { PathFinder } from '../adapter';
import { CLASS_K } from '../classes';
import { CELL_PX, SUB, TILE_FLAG_FLOOR } from '../constants';
import { anchorOfPoint, applyFurniture, computeClearance, createNavGrid, fits, isTileStandable, navPointOfTile, pointOfAnchor, setCell, setTileFlags, tileOfNavPoint } from '../grid';
import { MAX_REPAIRS, Navigator, tileAnchorPoint, type NavPath } from '../navigator';
import type { NavGrid } from '../types';
import { maxRoomsLayout, toLayout } from './perfLayout';

// ------------------------------------------------------------------ helpers

/** 300 `generateRandomLayout` seeds (both backgrounds, incl. 128 x 96), plus the classic hall and the perf layout. */
function propertyLayouts(): OfficeLayout[] {
  const out: OfficeLayout[] = [DEFAULT_LAYOUT, toLayout(maxRoomsLayout(), 'perf')];
  for (let seed = 1; seed <= 145; seed++) {
    for (const background of ['hall', 'void'] as const) {
      out.push(toLayout(generateRandomLayout({ width: 48, height: 30, seed, background }), `bsp${seed}-${background}`));
    }
  }
  for (let seed = 1; seed <= 5; seed++) {
    for (const background of ['hall', 'void'] as const) {
      out.push(toLayout(generateRandomLayout({ width: 128, height: 96, seed: 1000 + seed, background }), `big${seed}-${background}`));
    }
  }
  return out;
}

const SAMPLE_PX = 2;

/**
 * Property 6: every point `nextSegment` returns fits, and so does every point sampled every 2 px along each
 * segment (from `path.from`). The first segment is skipped when the start itself does not fit (a blocked
 * start walks straight off, as today). Returns the segment ends.
 */
function validateSegments(g: NavGrid, path: NavPath, label: string): Point[] {
  const k = CLASS_K[path.cls];
  const ends: Point[] = [];
  let prev = path.from;
  const s = anchorOfPoint(prev, k);
  let checkFrom = fits(g, s.x, s.y, k);
  // Plain checks with one `expect` per path: an `expect` per 2 px sample costs more than the navigation itself.
  let problem = '';
  for (let p = path.nextSegment(); p !== null; p = path.nextSegment()) {
    ends.push(p);
    const a = anchorOfPoint(p, k);
    if (!fits(g, a.x, a.y, k)) problem ||= `segment end ${p.x},${p.y} does not fit`;
    if (checkFrom) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const len = Math.hypot(dx, dy);
      for (let d = 0; d < len; d += SAMPLE_PX) {
        const qx = prev.x + (dx / len) * d;
        const qy = prev.y + (dy / len) * d;
        const ax = Math.round(qx / CELL_PX - k / 2);
        const ay = Math.round(qy / CELL_PX - k / 2);
        if (!fits(g, ax, ay, k)) problem ||= `sample ${qx.toFixed(1)},${qy.toFixed(1)} on ${prev.x},${prev.y} -> ${p.x},${p.y} does not fit`;
      }
    }
    checkFrom = true;
    prev = p;
  }
  expect(problem, label).toBe('');
  expect(path.done, label).toBe(true);
  expect(path.nextSegment(), label).toBeNull();
  return ends;
}

/** Property 5 half: the macro tiles cross only passable tiles (the start excepted) and have the right ends. */
function validateTiles(g: NavGrid, path: NavPath, label: string): void {
  const tiles = path.tiles;
  expect(tiles[0], label).toEqual(tileOfNavPoint(path.from));
  expect(tiles[tiles.length - 1], label).toEqual(tileOfNavPoint(path.to));
  let problem = '';
  for (let i = 1; i < tiles.length; i++) {
    const a = tiles[i - 1]!;
    const b = tiles[i]!;
    if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) !== 1) problem ||= `tile step ${i} is not 8-adjacent`;
    if (path.cls === 'person' && !isTileStandable(g, b.x, b.y)) problem ||= `tile ${b.x},${b.y} is not standable`;
  }
  expect(problem, label).toBe('');
}

/** An all-floor grid of `cols x rows` tiles (floor flag set, clearance computed). */
function floorGrid(cols: number, rows: number): NavGrid {
  const g = createNavGrid(cols, rows);
  for (let cy = 0; cy < g.crows; cy++) for (let cx = 0; cx < g.ccols; cx++) setCell(g, cx, cy, true);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) setTileFlags(g, x, y, TILE_FLAG_FLOOR);
  computeClearance(g);
  return g;
}

const item = (r: Rect, kind: PlacedFurniture['kind'] = 'work-desk'): PlacedFurniture => ({ ...r, kind, blocking: true, roomId: 'r', roomType: 'desks', variant: 0 });

/**
 * A 32 x 32 floor with random half-tile dividers: one-cell-thick lines of blocked cells at random cell
 * rows/columns (so half of the tiles they cross stay open), each with a one-cell gap, plus a few fully
 * blocked tiles.
 */
function dividerGrid(rnd: () => number, dividers: number): NavGrid {
  const g = floorGrid(32, 32);
  for (let n = 0; n < dividers; n++) {
    const vertical = rnd() < 0.5;
    const at = Math.floor(rnd() * g.ccols);
    const len = 4 + Math.floor(rnd() * 16);
    const start = Math.floor(rnd() * (g.ccols - len));
    const gap = start + Math.floor(rnd() * len);
    for (let i = start; i < start + len; i++) {
      if (i === gap) continue;
      if (vertical) setCell(g, at, i, false);
      else setCell(g, i, at, false);
    }
  }
  for (let n = 0; n < 24; n++) {
    const tx = Math.floor(rnd() * g.cols);
    const ty = Math.floor(rnd() * g.rows);
    for (let cy = 0; cy < SUB; cy++) for (let cx = 0; cx < SUB; cx++) setCell(g, tx * SUB + cx, ty * SUB + cy, false);
  }
  computeClearance(g);
  return g;
}

/** Cell-level reachability for k = 1 (8-connected over fitting cells, no corner cuts), the ground truth for `small`. */
function cellReachable(g: NavGrid, s: Point, t: Point): boolean {
  const seen = new Uint8Array(g.ccols * g.crows);
  const pass = (x: number, y: number) => fits(g, x, y, 1);
  const queue = [s.y * g.ccols + s.x];
  seen[queue[0]!] = 1;
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    const ux = u % g.ccols;
    const uy = (u - ux) / g.ccols;
    if (ux === t.x && uy === t.y) return true;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const vx = ux + dx;
        const vy = uy + dy;
        if (!pass(vx, vy)) continue;
        if (dx !== 0 && dy !== 0 && !(pass(ux + dx, uy) && pass(ux, uy + dy))) continue;
        const v = vy * g.ccols + vx;
        if (seen[v] === 1) continue;
        seen[v] = 1;
        queue.push(v);
      }
    }
  }
  return false;
}

function randomFittingCell(rnd: () => number, g: NavGrid, k: number): Point {
  for (;;) {
    const p = { x: Math.floor(rnd() * g.ccols), y: Math.floor(rnd() * g.crows) };
    if (fits(g, p.x, p.y, k)) return p;
  }
}

// ------------------------------------------------------------------ properties on generated maps

describe('Navigator on generated maps (navigation.md section 5, properties 5, 6, 11)', () => {
  it(
    'spawn -> every seat: reachable via the adapter iff reachable via findPath(person); tiles, segments and samples validate; deterministic',
    () => {
      const layouts = propertyLayouts();
      expect(layouts.length).toBe(302);
      let pairs = 0;
      let big = 0;
      let segments = 0;
      let tileSteps = 0;
      for (const layout of layouts) {
        const map = generateMap(layout);
        expect(hasLayoutErrors(map.issues), layout.id).toBe(false);
        if (map.cols === 128 && map.rows === 96) big++;
        const g = map.nav!;
        const finder = new PathFinder(g);
        const nav = finder.navigator();
        expect(finder.navigator(), 'one shared navigator').toBe(nav);
        const from = navPointOfTile(map.spawn);
        for (const room of map.rooms) {
          for (const seat of room.seats) {
            const label = `${layout.id} ${room.id} seat ${seat.x},${seat.y}`;
            const to = navPointOfTile(seat);
            const viaAdapter = finder.find(map.spawn, seat);
            const path = nav.findPath(from, to, 'person');
            expect(path === null, label).toBe(viaAdapter === null);
            pairs++;
            if (path === null) continue;
            expect(path.cls).toBe('person');
            expect(path.from).toEqual(from);
            expect(path.to).toEqual(to);
            expect(path.repairs, `${label}: a person never needs a repair`).toBe(0);
            expect(path.pulled, label).toBe(true);
            validateTiles(g, path, label);
            tileSteps += path.tiles.length - 1;
            const ends = validateSegments(g, path, label);
            // Property 11: equal inputs, equal segments; `toPoints` previews what `nextSegment` returned.
            expect(nav.findPath(from, to, 'person')!.toPoints(), label).toEqual(ends);
            if (from.x === to.x && from.y === to.y) expect(ends, `${label}: seat on the spawn tile`).toEqual([]);
            else expect(ends[ends.length - 1], `${label}: lands exactly on the seat`).toEqual(to);
            segments += ends.length;
          }
        }
      }
      expect(big).toBeGreaterThanOrEqual(11);
      expect(pairs).toBeGreaterThan(3000);
      // String pulling must actually shorten: far fewer segments than tile steps.
      expect(segments).toBeLessThan(tileSteps / 2);
      console.info(`navigator: ${pairs} spawn->seat pairs, ${tileSteps} tile steps pulled into ${segments} segments`);
    },
    120_000,
  );
});

// ------------------------------------------------------------------ small creatures

describe('Navigator for small creatures', () => {
  it('property 10: a one-cell gap between two pins (x = 2, x = 3.5) is impassable for person, passable for small', () => {
    // 8 x 5 floor; a row of desks across y = 2 (x = 0 w 2, x = 2, x = 3.5, x = 4.5 w 4) leaves one cell
    // free in that row: x = 6 (tile 3, left half). Crossing north to south means passing that cell.
    const g = floorGrid(8, 5);
    applyFurniture(g, [item({ x: 0, y: 2, w: 2, h: 1 }, 'cabinet'), item({ x: 2, y: 2, w: 1, h: 1 }, 'cabinet'), item({ x: 3.5, y: 2, w: 1, h: 1 }, 'cabinet'), item({ x: 4.5, y: 2, w: 4, h: 1 }, 'cabinet')]);
    computeClearance(g);
    for (let x = 0; x < 8; x++) expect(isTileStandable(g, x, 2), `tile ${x},2 blocked`).toBe(false);
    for (let cx = 0; cx < g.ccols; cx++) for (let cy = 4; cy < 6; cy++) expect(fits(g, cx, cy, 1), `cell ${cx},${cy}`).toBe(cx === 6);
    const nav = new Navigator(g);
    const from = navPointOfTile({ x: 3, y: 0 });
    const to = navPointOfTile({ x: 3, y: 4 });
    expect(nav.findPath(from, to, 'person')).toBeNull();
    const small = nav.findPath(navPointOfTile({ x: 3, y: 0 }, 1), navPointOfTile({ x: 3, y: 4 }, 1), 'small');
    expect(small).not.toBeNull();
    expect(small!.pulled).toBe(true);
    validateTiles(g, small!, 'gap');
    const ends = validateSegments(g, small!, 'gap');
    // The route threads the gap column (cell x = 6).
    expect(ends.some((p) => Math.floor(p.x / CELL_PX) === 6)).toBe(true);
  });

  it('insets: a desk row blocks person but small passes under its chair side; facing n opens the north side instead', () => {
    for (const facing of ['s', 'n'] as const) {
      const g = floorGrid(8, 5);
      applyFurniture(g, [{ ...item({ x: 0, y: 2, w: 8, h: 1 }), facing }]);
      computeClearance(g);
      for (let x = 0; x < 8; x++) expect(isTileStandable(g, x, 2), `tile ${x},2`).toBe(false);
      // The open half is the south cells for `s` (cy 5), the north cells for `n` (cy 4).
      const open = facing === 's' ? 5 : 4;
      const shut = facing === 's' ? 4 : 5;
      for (let cx = 0; cx < g.ccols; cx++) {
        expect(fits(g, cx, open, 1), `${facing} open ${cx}`).toBe(true);
        expect(fits(g, cx, shut, 1), `${facing} shut ${cx}`).toBe(false);
      }
      const nav = new Navigator(g);
      expect(nav.findPath(navPointOfTile({ x: 3, y: 0 }), navPointOfTile({ x: 3, y: 4 }), 'person')).toBeNull();
      // A cell row is one cell tall: a k = 1 creature walks along it but cannot cross the shut row.
      const path = nav.findPath(tileAnchorPoint(g, { x: 0, y: 2 }, 1), tileAnchorPoint(g, { x: 7, y: 2 }, 1), 'small');
      expect(path, facing).not.toBeNull();
      validateSegments(g, path!, `desk-${facing}`);
    }
  });

  it('tileAnchorPoint: the tile centre for a person, the first fitting cell for small, the top-left anchor for large', () => {
    const g = floorGrid(4, 4);
    setCell(g, 2, 2, false); // top-left cell of tile (1, 1)
    computeClearance(g);
    expect(tileAnchorPoint(g, { x: 1, y: 1 }, SUB)).toEqual(navPointOfTile({ x: 1, y: 1 }));
    expect(tileAnchorPoint(g, { x: 1, y: 1 }, 1)).toEqual(pointOfAnchor({ x: 3, y: 2 }, 1));
    expect(tileAnchorPoint(g, { x: 0, y: 0 }, 1)).toEqual(pointOfAnchor({ x: 0, y: 0 }, 1));
    expect(tileAnchorPoint(g, { x: 0, y: 0 }, 3)).toEqual(navPointOfTile({ x: 0, y: 0 }, 3));
  });

  it('on random half-tile dividers: every pulled path validates, repairs stay rare, no path crosses a divider', () => {
    const rnd = mulberry32(0xd1d1d3);
    let paths = 0;
    let hops = 0;
    let repairs = 0;
    let gaveUp = 0;
    let nullButReachable = 0;
    let pathButUnreachable = 0;
    for (let n = 0; n < 60; n++) {
      const g = dividerGrid(rnd, 10 + (n % 20));
      const nav = new Navigator(g);
      for (let q = 0; q < 25; q++) {
        const s = randomFittingCell(rnd, g, 1);
        const t = randomFittingCell(rnd, g, 1);
        const from = pointOfAnchor(s, 1);
        const to = pointOfAnchor(t, 1);
        const reachable = cellReachable(g, s, t);
        const path = nav.findPath(from, to, 'small');
        if (path === null) {
          if (reachable) nullButReachable++;
          continue;
        }
        paths++;
        hops += path.tiles.length - 1;
        repairs += path.repairs;
        if (!path.pulled) {
          gaveUp++;
          continue;
        }
        if (!reachable) pathButUnreachable++;
        validateTiles(g, path, `grid ${n} pair ${q}`);
        const ends = validateSegments(g, path, `grid ${n} pair ${q}`);
        expect(ends[ends.length - 1]).toEqual(to);
        expect(nav.findPath(from, to, 'small')!.toPoints()).toEqual(ends);
      }
    }
    console.info(`small on dividers: ${paths} paths, ${hops} hops, ${repairs} repairs, ${gaveUp} gave up, ${nullButReachable} null-but-reachable, ${pathButUnreachable} path-but-unreachable`);
    expect(paths).toBeGreaterThan(800);
    expect(pathButUnreachable, 'a pulled path never crosses a divider').toBe(0);
    expect(repairs / hops, 'repairs per hop').toBeLessThan(0.01);
    expect(gaveUp, 'repairs always succeed within MAX_REPAIRS').toBe(0);
    expect(nullButReachable / paths, 'missed routes').toBeLessThan(0.01);
  });
});

// ------------------------------------------------------------------ edge cases

describe('Navigator edge cases', () => {
  const g = floorGrid(6, 4);
  applyFurniture(g, [item({ x: 2, y: 1, w: 1, h: 1 })]);
  computeClearance(g);
  const nav = new Navigator(g);

  it('null for a target outside the grid or one the block does not fit on', () => {
    const from = navPointOfTile({ x: 0, y: 0 });
    expect(nav.findPath(from, navPointOfTile({ x: 6, y: 0 }), 'person')).toBeNull();
    expect(nav.findPath(from, { x: -4, y: 4 }, 'person')).toBeNull();
    expect(nav.findPath(from, navPointOfTile({ x: 2, y: 1 }), 'person')).toBeNull();
    expect(nav.findPath(from, navPointOfTile({ x: 2, y: 1 }, 1), 'small')).toBeNull();
    // A person needs the full tile: the half-covered anchor of a cell next to the desk does not fit.
    expect(nav.findPath(from, pointOfAnchor({ x: 3, y: 2 }, 2), 'person')).toBeNull();
    // A start outside the grid.
    expect(nav.findPath({ x: -8, y: 8 }, navPointOfTile({ x: 1, y: 1 }), 'person')).toBeNull();
  });

  it('from === to is a done path (one macro tile, no segments), like walk([from])', () => {
    const p = navPointOfTile({ x: 1, y: 1 });
    const path = nav.findPath(p, p, 'person')!;
    expect(path.tiles).toEqual([{ x: 1, y: 1 }]);
    expect(path.done).toBe(true);
    expect(path.nextSegment()).toBeNull();
    expect(path.toPoints()).toEqual([]);
  });

  it('two points in one tile are one segment', () => {
    const from = { x: 20, y: 20 };
    const to = { x: 24, y: 26 };
    const path = nav.findPath(from, to, 'person')!;
    expect(path.tiles).toEqual([{ x: 1, y: 1 }]);
    expect(path.toPoints()).toEqual([to]);
    expect(path.done).toBe(false);
    expect(path.nextSegment()).toEqual(to);
    expect(path.done).toBe(true);
  });

  it('a blocked start walks straight to the first tile anchor, then the pulled rest', () => {
    const from = navPointOfTile({ x: 2, y: 1 }); // on the desk
    const to = navPointOfTile({ x: 5, y: 3 });
    const path = nav.findPath(from, to, 'person')!;
    expect(path.tiles[0]).toEqual({ x: 2, y: 1 });
    const pts = path.toPoints();
    expect(pts[0]).toEqual(navPointOfTile(path.tiles[1]!));
    expect(pts[pts.length - 1]).toEqual(to);
    validateSegments(g, path, 'blocked start');
  });

  it('a mid-tile start (interrupted walk) lands exactly on the target nav point', () => {
    const from = { x: 13, y: 11 };
    const to = navPointOfTile({ x: 5, y: 0 });
    const path = nav.findPath(from, to, 'person')!;
    const ends = validateSegments(g, path, 'mid-tile');
    expect(ends[ends.length - 1]).toEqual(to);
  });

  it('invalidate() drops the passability cache so a grid edit is seen', () => {
    const edited = floorGrid(5, 1);
    const block = (walkable: boolean) => {
      for (let cy = 0; cy < SUB; cy++) for (let cx = 0; cx < SUB; cx++) setCell(edited, 2 * SUB + cx, cy, walkable);
      computeClearance(edited);
    };
    block(false);
    const n2 = new Navigator(edited);
    const from = navPointOfTile({ x: 0, y: 0 });
    const to = navPointOfTile({ x: 4, y: 0 });
    expect(n2.findPath(from, to, 'person')).toBeNull();
    block(true);
    expect(n2.findPath(from, to, 'person'), 'stale cache still blocks').toBeNull();
    n2.invalidate({ x0: 4, y0: 0, x1: 6, y1: 2 });
    expect(n2.findPath(from, to, 'person')).not.toBeNull();
    // The other way round the LOS layer catches it even before invalidate (the cache can only lie "passable"):
    // the hop fails, the repair closes the only door, and the route degrades to the unpulled tile path.
    block(false);
    const stale = n2.findPath(from, to, 'person');
    expect(stale === null || (!stale.pulled && stale.repairs > 0)).toBe(true);
  });

  it('a repair that closes the only door falls back to the last tile route (never null); after MAX_REPAIRS failed re-routes the tile anchors are walked as they are', () => {
    // A checkerboard tile keeps its top-left and bottom-right cells: `small`-passable, and open on every
    // edge for the macro (a free cell pair exists), but its two cells do not connect inside the hop window
    // (both orthogonal cells are blocked), so the micro repair fails and the hop's tile gets marked.
    const checker = (g: NavGrid, x: number, y: number) => {
      setCell(g, x * SUB + 1, y * SUB, false);
      setCell(g, x * SUB, y * SUB + 1, false);
    };
    // One corridor with one checker tile: the first hop enters it at the top-left cell, the next hop
    // must leave from the bottom-right one; marking the tile closes the only door, so the re-run finds no
    // route: the last good tile path is walked unpulled (null only when the FIRST search fails).
    const one = floorGrid(6, 1);
    checker(one, 1, 0);
    computeClearance(one);
    const oneTo = navPointOfTile({ x: 5, y: 0 }, 1);
    const door = new Navigator(one).findPath(navPointOfTile({ x: 0, y: 0 }, 1), oneTo, 'small');
    expect(door).not.toBeNull();
    expect(door!.pulled).toBe(false);
    expect(door!.repairs).toBeGreaterThan(0);
    const doorPts = door!.toPoints();
    expect(doorPts[doorPts.length - 1]).toEqual(oneTo);
    expect(door!.tiles[door!.tiles.length - 1]).toEqual({ x: 5, y: 0 });
    // Five rows, a checker column: every re-route is another row until the budget is spent.
    const many = floorGrid(6, 5);
    for (let y = 0; y < 5; y++) checker(many, 1, y);
    computeClearance(many);
    const to = navPointOfTile({ x: 5, y: 2 }, 1);
    const path = new Navigator(many).findPath(navPointOfTile({ x: 0, y: 2 }, 1), to, 'small');
    expect(path).not.toBeNull();
    expect(path!.pulled).toBe(false);
    expect(path!.repairs).toBe(MAX_REPAIRS);
    const pts = path!.toPoints();
    expect(pts.length).toBe(path!.tiles.length - 1);
    expect(pts[pts.length - 1]).toEqual(to);
    for (let i = 0; i + 1 < pts.length; i++) expect(pts[i]).toEqual(tileAnchorPoint(many, path!.tiles[i + 1]!, 1));
  });
});
