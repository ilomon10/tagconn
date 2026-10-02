import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, type OfficeLayout } from '@tagconn/shared';
import { generateRandomLayout } from '../../procgen/bsp';
import { generateMap } from '../../procgen/generate';
import { mulberry32 } from '../../procgen/rng';
import type { GeneratedMap, PlacedFurniture, Rect } from '../../procgen/types';
import { CELL_PX, CLEARANCE_MAX, FEET_DY, FULL_MASK, SUB, TILE_FLAG_DOOR, TILE_FLAG_FLOOR, TILE_FLAG_SOFT, TILE_PX } from '../constants';
import {
  anchorOfPoint,
  applyFurniture,
  bitOf,
  buildNavGrid,
  cellIndex,
  cellRectOf,
  computeClearance,
  createNavGrid,
  fits,
  isTileStandable,
  isWalkableCell,
  isWalkableWorld,
  navGridFromWalkable,
  navPointOfTile,
  pointOfAnchor,
  setCell,
  setTileFlags,
  tileFlags,
  tileIndex,
  tileOfNavPoint,
  updateClearance,
  walkableFromNav,
  type NavGrid,
} from '../grid';
import type { NavShape } from '../shapes';
import { maxRoomsLayout, toLayout } from './perfLayout';

// ------------------------------------------------------------------ helpers

const item = (r: Rect, blocking = true, kind: PlacedFurniture['kind'] = 'cabinet'): PlacedFurniture => ({
  ...r,
  kind,
  blocking,
  roomId: 'r',
  roomType: 'desks',
  variant: 0,
});

/** Index of the first differing byte, or -1 when equal (byte-for-byte). */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function cloneGrid(g: NavGrid): NavGrid {
  return { ...g, masks: new Uint8Array(g.masks), clearance: new Uint8Array(g.clearance) };
}

/** Brute force: is the k x k block anchored at (cx, cy) entirely walkable? */
function blockFree(g: NavGrid, cx: number, cy: number, k: number): boolean {
  for (let y = cy; y < cy + k; y++) for (let x = cx; x < cx + k; x++) if (!isWalkableCell(g, x, y)) return false;
  return true;
}

/** A random grid in cells, `density` = fraction of blocked cells. */
function randomGrid(cols: number, rows: number, seed: number, density: number): NavGrid {
  const g = createNavGrid(cols, rows);
  const rand = mulberry32(seed);
  for (let cy = 0; cy < g.crows; cy++) for (let cx = 0; cx < g.ccols; cx++) setCell(g, cx, cy, rand() >= density);
  computeClearance(g);
  return g;
}

/** 100 BSP seeds on both backgrounds, the classic hall and the 128 x 96 worst case. */
function propertyLayouts(): OfficeLayout[] {
  const out: OfficeLayout[] = [DEFAULT_LAYOUT, toLayout(maxRoomsLayout(), 'perf')];
  for (let seed = 1; seed <= 50; seed++) {
    for (const background of ['hall', 'void'] as const) {
      out.push(toLayout(generateRandomLayout({ width: 48, height: 30, seed, background }), `bsp${seed}-${background}`));
    }
  }
  return out;
}

// ------------------------------------------------------------------ bits and indices

describe('bit layout', () => {
  it('SUB is a power of two so cell → tile is a shift', () => {
    expect(Number.isInteger(Math.log2(SUB))).toBe(true);
  });

  it('bitOf is tl=0 tr=1 bl=2 br=3 and repeats per tile', () => {
    expect([bitOf(0, 0), bitOf(1, 0), bitOf(0, 1), bitOf(1, 1)]).toEqual([0, 1, 2, 3]);
    expect([bitOf(6, 4), bitOf(7, 4), bitOf(6, 5), bitOf(7, 5)]).toEqual([0, 1, 2, 3]);
  });

  it('tileIndex / cellIndex are row-major', () => {
    expect(tileIndex({ cols: 10 }, 3, 2)).toBe(23);
    expect(cellIndex({ ccols: 20 }, 3, 2)).toBe(43);
  });
});

describe('createNavGrid / setCell / isWalkableCell', () => {
  it('starts fully blocked with no flags and the right sizes', () => {
    const g = createNavGrid(3, 2);
    expect([g.cols, g.rows, g.ccols, g.crows]).toEqual([3, 2, 6, 4]);
    expect(g.masks.length).toBe(6);
    expect(g.clearance.length).toBe(24);
    expect(Array.from(g.masks).every((m) => m === 0)).toBe(true);
    for (let cy = 0; cy < g.crows; cy++) for (let cx = 0; cx < g.ccols; cx++) expect(isWalkableCell(g, cx, cy)).toBe(false);
  });

  it('setCell flips exactly one bit of the right tile and is a no-op outside', () => {
    const g = createNavGrid(3, 2);
    setCell(g, 3, 1, true); // tile (1, 0), bit br = 3
    expect(g.masks[1]).toBe(1 << 3);
    expect(isWalkableCell(g, 3, 1)).toBe(true);
    expect(isWalkableCell(g, 2, 1)).toBe(false);
    setCell(g, 3, 1, false);
    expect(g.masks[1]).toBe(0);
    setCell(g, -1, 0, true);
    setCell(g, 6, 0, true);
    setCell(g, 0, 4, true);
    expect(Array.from(g.masks).every((m) => m === 0)).toBe(true);
    expect(isWalkableCell(g, -1, 0)).toBe(false);
    expect(isWalkableCell(g, 6, 0)).toBe(false);
  });

  it('setCell keeps the tile flags; setTileFlags keeps the cell bits and ignores the low nibble', () => {
    const g = createNavGrid(1, 1);
    setTileFlags(g, 0, 0, TILE_FLAG_FLOOR | 0x0f);
    expect(g.masks[0]).toBe(TILE_FLAG_FLOOR);
    setCell(g, 0, 0, true);
    expect(tileFlags(g, 0, 0)).toBe(TILE_FLAG_FLOOR);
    expect(g.masks[0]).toBe(TILE_FLAG_FLOOR | 1);
    setTileFlags(g, 0, 0, TILE_FLAG_SOFT);
    expect(tileFlags(g, 0, 0)).toBe(TILE_FLAG_FLOOR | TILE_FLAG_SOFT);
    expect(tileFlags(g, 1, 0)).toBe(0);
  });
});

// ------------------------------------------------------------------ world lookups

describe('isWalkableWorld', () => {
  const g = createNavGrid(2, 2);
  // tile (0,0) full, tile (1,0) empty, tile (0,1) only its br cell, tile (1,1) only its tl cell
  g.masks[0] = FULL_MASK;
  setCell(g, 1, 3, true);
  setCell(g, 2, 2, true);

  it('a full tile is walkable everywhere inside it (early-out)', () => {
    for (const [px, py] of [
      [0, 0],
      [15, 15],
      [15.9, 0.1],
      [7, 8],
    ]) expect(isWalkableWorld(g, px!, py!)).toBe(true);
  });

  it('an empty tile is blocked everywhere (early-out)', () => {
    for (const [px, py] of [
      [16, 0],
      [31, 15],
      [20, 12],
    ]) expect(isWalkableWorld(g, px!, py!)).toBe(false);
  });

  it('a partial tile is read per cell', () => {
    expect(isWalkableWorld(g, 8, 24)).toBe(true); // br of (0,1)
    expect(isWalkableWorld(g, 15, 31)).toBe(true);
    expect(isWalkableWorld(g, 7, 24)).toBe(false); // bl
    expect(isWalkableWorld(g, 8, 23)).toBe(false); // tr
    expect(isWalkableWorld(g, 16, 16)).toBe(true); // tl of (1,1)
    expect(isWalkableWorld(g, 24, 16)).toBe(false);
  });

  it('is false outside the map', () => {
    expect(isWalkableWorld(g, -1, 0)).toBe(false);
    expect(isWalkableWorld(g, 0, -0.5)).toBe(false);
    expect(isWalkableWorld(g, 32, 0)).toBe(false);
    expect(isWalkableWorld(g, 0, 32)).toBe(false);
  });

  it('isTileStandable needs the whole nibble and is false outside', () => {
    expect(isTileStandable(g, 0, 0)).toBe(true);
    expect(isTileStandable(g, 1, 0)).toBe(false);
    expect(isTileStandable(g, 0, 1)).toBe(false);
    expect(isTileStandable(g, 2, 0)).toBe(false);
    expect(isTileStandable(g, 0, -1)).toBe(false);
  });
});

// ------------------------------------------------------------------ rects and points

describe('cellRectOf', () => {
  it('maps integer rects to SUB-scaled cell rects', () => {
    expect(cellRectOf({ x: 2, y: 1, w: 3, h: 2 })).toEqual({ x0: 4, y0: 2, x1: 10, y1: 6 });
  });

  it('maps half offsets exactly (Math.round)', () => {
    expect(cellRectOf({ x: 2.5, y: 1, w: 2, h: 1 })).toEqual({ x0: 5, y0: 2, x1: 9, y1: 4 });
    expect(cellRectOf({ x: 0, y: 3.5, w: 1, h: 1 })).toEqual({ x0: 0, y0: 7, x1: 2, y1: 9 });
  });

  it('survives floating-point noise on a half', () => {
    expect(cellRectOf({ x: 0.1 + 0.2 + 0.2, y: 0, w: 1, h: 1 })).toEqual({ x0: 1, y0: 0, x1: 3, y1: 2 });
  });
});

describe('anchors and nav points', () => {
  it('pointOfAnchor(anchorOfPoint(p, k), k) is the identity for aligned points, k = 1..3', () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 300; i++) {
      const k = 1 + (i % 3);
      const a = { x: Math.floor(rand() * 200), y: Math.floor(rand() * 200) };
      const p = pointOfAnchor(a, k);
      expect(anchorOfPoint(p, k)).toEqual(a);
      expect(pointOfAnchor(anchorOfPoint(p, k), k)).toEqual(p);
    }
  });

  it('k = 2 nav point of a tile is its centre, i.e. the feet point minus FEET_DY', () => {
    for (const t of [
      { x: 0, y: 0 },
      { x: 5, y: 3 },
      { x: 47, y: 29 },
    ]) {
      const feet = { x: t.x * TILE_PX + 8, y: t.y * TILE_PX + 14 }; // Character.teleport
      expect(navPointOfTile(t)).toEqual({ x: feet.x, y: feet.y - FEET_DY });
      expect(navPointOfTile(t, 2)).toEqual({ x: t.x * TILE_PX + TILE_PX / 2, y: t.y * TILE_PX + TILE_PX / 2 });
      expect(anchorOfPoint(navPointOfTile(t), 2)).toEqual({ x: t.x * SUB, y: t.y * SUB });
    }
  });

  it('a nav point of a tile lies in that tile for every class size, and tileOfNavPoint floors', () => {
    for (let k = 1; k <= 3; k++) for (const t of [{ x: 0, y: 0 }, { x: 7, y: 2 }]) expect(tileOfNavPoint(navPointOfTile(t, k)), `k=${k}`).toEqual(t);
    expect(tileOfNavPoint({ x: 15.99, y: 16 })).toEqual({ x: 0, y: 1 });
    expect(navPointOfTile({ x: 1, y: 1 }, 1)).toEqual({ x: TILE_PX + CELL_PX / 2, y: TILE_PX + CELL_PX / 2 });
  });
});

// ------------------------------------------------------------------ furniture

describe('applyFurniture', () => {
  function openGrid(cols: number, rows: number): NavGrid {
    const g = createNavGrid(cols, rows);
    g.masks.fill(FULL_MASK | TILE_FLAG_FLOOR);
    return g;
  }

  it('a half-offset blocking item clears exactly cellRectOf(item) and reports it as dirty', () => {
    const g = openGrid(6, 4);
    const r = { x: 2.5, y: 1, w: 1, h: 1 };
    expect(applyFurniture(g, [item(r)])).toEqual(cellRectOf(r));
    const rect = cellRectOf(r);
    for (let cy = 0; cy < g.crows; cy++) {
      for (let cx = 0; cx < g.ccols; cx++) {
        const inside = cx >= rect.x0 && cx < rect.x1 && cy >= rect.y0 && cy < rect.y1;
        expect(isWalkableCell(g, cx, cy), `${cx},${cy}`).toBe(!inside);
      }
    }
    // Both touched tiles are no longer standable; neighbours are.
    expect(isTileStandable(g, 2, 1)).toBe(false);
    expect(isTileStandable(g, 3, 1)).toBe(false);
    expect(isTileStandable(g, 1, 1)).toBe(true);
    expect(isTileStandable(g, 4, 1)).toBe(true);
    expect(isTileStandable(g, 2, 0)).toBe(true);
    expect(walkableFromNav(g)[1]).toEqual([0, 0, 1, 1, 0, 0]);
    expect(tileFlags(g, 2, 1)).toBe(TILE_FLAG_FLOOR); // flags untouched
  });

  it('a non-blocking item only flags the covered tiles soft (whatever its kind) and is not dirty', () => {
    const g = openGrid(6, 4);
    expect(applyFurniture(g, [item({ x: 1.5, y: 0.5, w: 1, h: 1 }, false, 'work-desk')])).toBeNull();
    expect(Array.from(g.masks).every((m) => (m & FULL_MASK) === FULL_MASK)).toBe(true);
    const soft: string[] = [];
    for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.cols; x++) if (tileFlags(g, x, y) & TILE_FLAG_SOFT) soft.push(`${x},${y}`);
    expect(soft).toEqual(['1,0', '2,0', '1,1', '2,1']); // coveredTiles of the half-offset rect
  });

  it('unions the dirty rect over several items and clips to the grid', () => {
    const g = openGrid(6, 4);
    const dirty = applyFurniture(g, [item({ x: 0, y: 0, w: 1, h: 1 }), item({ x: 4, y: 2, w: 3, h: 3 })]);
    expect(dirty).toEqual({ x0: 0, y0: 0, x1: 12, y1: 8 });
    expect(applyFurniture(openGrid(2, 2), [item({ x: 5, y: 5, w: 1, h: 1 })])).toBeNull();
    expect(applyFurniture(openGrid(2, 2), [])).toBeNull();
  });

  it('uses the shape of the kind: none leaves cells open, an inset shrinks the footprint, unknown kinds block fully', () => {
    const shapes: Record<string, NavShape> = { 'work-desk': { inset: { n: 0, e: 0, s: 1, w: 0 } }, rug: 'none' };
    const g = openGrid(4, 4);
    applyFurniture(g, [item({ x: 1, y: 1, w: 2, h: 1 }, true, 'work-desk'), item({ x: 0, y: 0, w: 1, h: 1 }, true, 'rug'), item({ x: 3, y: 3, w: 1, h: 1 }, true, 'mystery' as PlacedFurniture['kind'])], shapes);
    expect(isWalkableCell(g, 2, 2)).toBe(false); // top row of the desk
    expect(isWalkableCell(g, 2, 3)).toBe(true); // bottom row open (inset s = 1)
    expect(isTileStandable(g, 1, 1)).toBe(false); // conservative: a partially blocked tile is not standable
    expect(isTileStandable(g, 0, 0)).toBe(true);
    expect(isTileStandable(g, 3, 3)).toBe(false);
  });

  it('rotates an inset by item.facing, and a kind that is not an own key of the table blocks fully', () => {
    const shapes: Record<string, NavShape> = { 'work-desk': { inset: { n: 0, e: 0, s: 1, w: 0 } } };
    const g = openGrid(4, 4);
    applyFurniture(g, [{ ...item({ x: 1, y: 1, w: 2, h: 1 }, true, 'work-desk'), facing: 'n' }, item({ x: 0, y: 3, w: 1, h: 1 }, true, 'constructor' as PlacedFurniture['kind'])], shapes);
    expect(isWalkableCell(g, 2, 2)).toBe(true); // facing n: the north row is the open chair side
    expect(isWalkableCell(g, 2, 3)).toBe(false);
    expect(isTileStandable(g, 0, 3)).toBe(false);
    expect(isWalkableCell(g, 0, 6)).toBe(false);
  });

  it('a shaped footprint never frees a whole tile: a one-tile desk with its chair side open still blocks the tile', () => {
    const g = openGrid(4, 4);
    applyFurniture(g, [item({ x: 0.5, y: 1, w: 1, h: 1 }, true, 'work-desk')]); // KIND_SHAPE desk, chair side s: the half-covered tiles keep a closed cell
    expect(isTileStandable(g, 0, 1)).toBe(false);
    expect(isTileStandable(g, 1, 1)).toBe(false);
  });
});

// ------------------------------------------------------------------ clearance

describe('clearance', () => {
  it('equals the brute-force k x k check for every cell and k ≤ CLEARANCE_MAX on random grids', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = randomGrid(20, 15, seed, seed % 2 ? 0.05 : 0.3);
      for (let cy = 0; cy < g.crows; cy++) {
        for (let cx = 0; cx < g.ccols; cx++) {
          for (let k = 1; k <= CLEARANCE_MAX; k++) {
            if (fits(g, cx, cy, k) !== blockFree(g, cx, cy, k)) throw new Error(`seed ${seed} cell ${cx},${cy} k=${k}: fits=${fits(g, cx, cy, k)} brute=${blockFree(g, cx, cy, k)}`);
          }
        }
      }
    }
  });

  it('saturates at CLEARANCE_MAX on an open grid and is 0 on a blocked cell', () => {
    const g = createNavGrid(10, 10);
    g.masks.fill(FULL_MASK);
    computeClearance(g);
    expect(g.clearance[0]).toBe(CLEARANCE_MAX);
    expect(fits(g, 0, 0, CLEARANCE_MAX)).toBe(true);
    expect(fits(g, 0, 0, CLEARANCE_MAX + 1)).toBe(false);
    expect(g.clearance[cellIndex(g, g.ccols - 1, g.crows - 1)]).toBe(1);
    expect(fits(g, -1, 0, 1)).toBe(false);
    expect(fits(g, g.ccols, 0, 1)).toBe(false);
    setCell(g, 5, 5, false);
    computeClearance(g);
    expect(g.clearance[cellIndex(g, 5, 5)]).toBe(0);
    expect(g.clearance[cellIndex(g, 4, 4)]).toBe(1);
    expect(g.clearance[cellIndex(g, 6, 6)]).toBe(CLEARANCE_MAX);
  });

  it('updateClearance after 1,000 random rect edits equals a full computeClearance, byte for byte', () => {
    const g = randomGrid(32, 24, 7, 0.15);
    const rand = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const w = 1 + Math.floor(rand() * 8);
      const h = 1 + Math.floor(rand() * 8);
      const x0 = Math.floor(rand() * (g.ccols + 4)) - 2; // may poke outside the grid
      const y0 = Math.floor(rand() * (g.crows + 4)) - 2;
      const walkable = rand() < 0.5;
      for (let cy = y0; cy < y0 + h; cy++) for (let cx = x0; cx < x0 + w; cx++) setCell(g, cx, cy, walkable);
      updateClearance(g, { x0, y0, x1: x0 + w, y1: y0 + h });
      if (i % 50 === 49) {
        const full = cloneGrid(g);
        computeClearance(full);
        expect(firstDiff(g.clearance, full.clearance), `after edit ${i}`).toBe(-1);
      }
    }
    const full = cloneGrid(g);
    computeClearance(full);
    expect(firstDiff(g.clearance, full.clearance)).toBe(-1);
  });

  it('updateClearance with the dirty rect of applyFurniture equals a full recompute on a real map', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const g = buildNavGrid(map);
    const rand = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const r = { x: Math.floor(rand() * map.cols * 2) / 2, y: Math.floor(rand() * map.rows * 2) / 2, w: 1 + Math.floor(rand() * 3), h: 1 + Math.floor(rand() * 2) };
      const dirty = applyFurniture(g, [item(r)]);
      if (dirty) updateClearance(g, dirty);
      const full = cloneGrid(g);
      computeClearance(full);
      expect(firstDiff(g.clearance, full.clearance), `edit ${i}`).toBe(-1);
    }
  });
});

// ------------------------------------------------------------------ parity with procgen

describe('buildNavGrid parity with map.walkable (property 1)', () => {
  const layouts = propertyLayouts();

  it('covers ≥ 100 seeds including a 128 x 96 map', () => {
    expect(layouts.length).toBeGreaterThanOrEqual(102);
    expect(layouts.some((l) => l.width === 128 && l.height === 96)).toBe(true);
  });

  it('isTileStandable ≡ walkable === 0, cell centres agree with the mask, walkableFromNav ≡ walkable, flags follow tiles', () => {
    for (const layout of layouts) {
      const map = generateMap(layout);
      const g = buildNavGrid(map);
      expect([g.cols, g.rows]).toEqual([map.cols, map.rows]);
      expect(walkableFromNav(g), layout.id).toEqual(map.walkable);
      for (let y = 0; y < map.rows; y++) {
        for (let x = 0; x < map.cols; x++) {
          const standable = map.walkable[y]![x] === 0;
          if (isTileStandable(g, x, y) !== standable) throw new Error(`${layout.id}: tile ${x},${y} standable=${!standable} but walkable=${map.walkable[y]![x]}`);
          // Each of the tile's SUB x SUB cell centres (nav point space) reads the same bit as the mask.
          for (let sy = 0; sy < SUB; sy++) {
            for (let sx = 0; sx < SUB; sx++) {
              const cx = x * SUB + sx;
              const cy = y * SUB + sy;
              const world = isWalkableWorld(g, (cx + 0.5) * CELL_PX, (cy + 0.5) * CELL_PX);
              if (world !== isWalkableCell(g, cx, cy)) throw new Error(`${layout.id}: cell ${cx},${cy} world/cell mismatch`);
              // M16 insets: a standable tile is fully open; a blocked tile keeps at least one closed cell (checked below), but a desk's chair side may be open.
              if (standable && !world) throw new Error(`${layout.id}: cell ${cx},${cy} of tile ${x},${y} is closed but the tile is standable`);
            }
          }
          if (!standable) {
            let closed = 0;
            for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) if (!isWalkableCell(g, x * SUB + sx, y * SUB + sy)) closed++;
            if (closed === 0 && map.tiles[y]![x] === 'floor') throw new Error(`${layout.id}: blocked tile ${x},${y} has no closed cell`);
          }
          const t = map.tiles[y]![x];
          const f = tileFlags(g, x, y);
          if (((f & TILE_FLAG_FLOOR) !== 0) !== (t === 'floor' || t === 'door')) throw new Error(`${layout.id}: tile ${x},${y} floor flag`);
          if (((f & TILE_FLAG_DOOR) !== 0) !== (t === 'door')) throw new Error(`${layout.id}: tile ${x},${y} door flag`);
        }
      }
    }
  });

  it('a half-tile blocking rect clears exactly cellRectOf(rect) ∩ open cells on every map', () => {
    const rand = mulberry32(2024);
    for (const layout of layouts) {
      const map = generateMap(layout);
      const base = buildNavGrid(map);
      const floor: { x: number; y: number }[] = [];
      for (let y = 0; y < map.rows; y++) for (let x = 0; x < map.cols; x++) if (map.walkable[y]![x] === 0) floor.push({ x, y });
      for (let n = 0; n < 3; n++) {
        const t = floor[Math.floor(rand() * floor.length)]!;
        const r = { x: t.x + (rand() < 0.5 ? 0.5 : 0), y: t.y + (rand() < 0.5 ? 0.5 : 0), w: 1 + Math.floor(rand() * 2), h: 1 };
        const g = buildNavGrid({ ...map, furniture: [...map.furniture, item(r)] });
        const rect = cellRectOf(r);
        for (let cy = 0; cy < g.crows; cy++) {
          for (let cx = 0; cx < g.ccols; cx++) {
            const inside = cx >= rect.x0 && cx < rect.x1 && cy >= rect.y0 && cy < rect.y1;
            const expected = inside ? false : isWalkableCell(base, cx, cy);
            if (isWalkableCell(g, cx, cy) !== expected) throw new Error(`${layout.id}: rect ${JSON.stringify(r)} cell ${cx},${cy}`);
          }
        }
      }
    }
  }, 60_000); // property over many maps: correctness, not a timing budget (slow under load)

  it('baseWalkable closes tiles the generator marks even when they are floor', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const base = map.walkable.map((row) => [...row]);
    const t = { x: map.spawn.x, y: map.spawn.y };
    expect(map.tiles[t.y]![t.x]).toBe('floor');
    base[t.y]![t.x] = 1;
    const g = buildNavGrid(map, base);
    expect(isTileStandable(g, t.x, t.y)).toBe(false);
    expect(tileFlags(g, t.x, t.y) & TILE_FLAG_FLOOR).toBe(TILE_FLAG_FLOOR); // still a floor tile
    expect(walkableFromNav(g)).toEqual(base);
    // Passing the final walkable as base is idempotent.
    expect(walkableFromNav(buildNavGrid(map, map.walkable))).toEqual(map.walkable);
  });

  it('navGridFromWalkable ≡ buildNavGrid on DEFAULT_LAYOUT (cell bits and clearance)', () => {
    const map: GeneratedMap = generateMap(DEFAULT_LAYOUT);
    const a = buildNavGrid(map);
    const b = navGridFromWalkable(map.walkable);
    expect([b.cols, b.rows, b.ccols, b.crows]).toEqual([a.cols, a.rows, a.ccols, a.crows]);
    // Tile level (M16: a desk's chair-side cells stay open in `a`, so cell bits and clearance may be richer than `b`'s).
    for (let y = 0; y < a.rows; y++) for (let x = 0; x < a.cols; x++) expect(isTileStandable(a, x, y), `${x},${y}`).toBe(isTileStandable(b, x, y));
    expect(walkableFromNav(b)).toEqual(map.walkable);
    for (let y = 0; y < b.rows; y++) for (let x = 0; x < b.cols; x++) expect(tileFlags(b, x, y) & TILE_FLAG_FLOOR).toBe(map.walkable[y]![x] === 0 ? TILE_FLAG_FLOOR : 0);
    expect(navGridFromWalkable([]).masks.length).toBe(0);
  });
});
