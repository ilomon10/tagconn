// M15 Wave 1 QA gate (docs/design/navigation.md section 5, property 1 on the Multiverse; section 6 W1-W):
// `generateMap` now builds `map.nav` and DERIVES `walkable` from it. These tests pin the wiring end to end on
// the layouts the existing property suite does not cover (the Multiverse plan, half pins through
// `validateLayout` on DEFAULT_LAYOUT) and the determinism of the emitted nav bytes.
import { describe, expect, it } from 'vitest';
import {
  coveredTiles,
  DEFAULT_LAYOUT,
  hasLayoutErrors,
  MULTIVERSE_LIMITS,
  OfficeLayoutSchema,
  roomInterior,
  validateLayout,
  type LayoutRoom,
  type MultiverseProjectInput,
  type OfficeLayout,
} from '@tagconn/shared';
import { planMultiverse, type PlanMultiverseOptions } from '../../multiverse/plan';
import { CLEARANCE_MAX, FULL_MASK, SUB, TILE_FLAG_FLOOR, TILE_FLAG_SOFT } from '../../nav/constants';
import { cellRectOf, computeClearance, fits, isTileStandable, isWalkableCell, tileFlags, walkableFromNav, type NavGrid } from '../../nav/grid';
import { generateRandomLayout } from '../bsp';
import { generateMap } from '../generate';
import type { GeneratedMap } from '../types';

// ------------------------------------------------------------------ helpers

const NOW = 1_000_000_000;
const OPTS: PlanMultiverseOptions = { maxRealms: MULTIVERSE_LIMITS.maxRealms, floorOrder: 'created', now: NOW, idleLeaveSec: 300 };

function project(i: number): MultiverseProjectInput {
  return { id: `p${i}`, name: `Project ${i}`, style: i % 2 === 0 ? 'guild' : 'modern', createdAt: i * 1000, lastActivityAt: NOW - i * 10, liveAgents: 1, lastLiveAt: NOW };
}

function multiverseLayout(n: number): OfficeLayout {
  return planMultiverse(Array.from({ length: n }, (_, i) => project(i)), OPTS).layout;
}

function bspLayout(seed: number, background: 'hall' | 'void'): OfficeLayout {
  const input = generateRandomLayout({ width: 48, height: 30, seed, background });
  return { ...input, background: input.background ?? 'hall', corridorWidth: input.corridorWidth ?? 2, id: `bsp${seed}-${background}`, builtin: false, createdAt: 0, updatedAt: 0 };
}

/** Index of the first differing byte, or -1 when equal. */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** The invariants every emitted map must satisfy (property 1 plus the nav/walkable contract). */
function expectNavContract(map: GeneratedMap, label: string): void {
  const g = map.nav;
  expect(g, `${label}: map.nav`).toBeDefined();
  expect([g.cols, g.rows, g.ccols, g.crows], `${label}: dims`).toEqual([map.cols, map.rows, map.cols * SUB, map.rows * SUB]);
  expect(g.masks.length, `${label}: masks length`).toBe(map.cols * map.rows);
  expect(g.clearance.length, `${label}: clearance length`).toBe(map.cols * SUB * map.rows * SUB);
  expect(map.walkable.length, `${label}: walkable rows`).toBe(map.rows);
  // walkable is derived from nav: the two must agree on every tile, both ways.
  expect(walkableFromNav(g), `${label}: walkableFromNav`).toEqual(map.walkable);
  for (let y = 0; y < map.rows; y++) {
    expect(map.walkable[y]!.length, `${label}: walkable row ${y}`).toBe(map.cols);
    for (let x = 0; x < map.cols; x++) {
      const standable = map.walkable[y]![x] === 0;
      if (isTileStandable(g, x, y) !== standable) throw new Error(`${label}: tile ${x},${y} isTileStandable=${!standable} walkable=${map.walkable[y]![x]}`);
      // A standable tile is floor/door flagged; a wall/void tile has no cells at all.
      const t = map.tiles[y]![x];
      if (t === 'wall' || t === 'void') {
        if ((g.masks[y * g.cols + x]! & FULL_MASK) !== 0) throw new Error(`${label}: ${t} tile ${x},${y} has open cells`);
      }
      if (standable && (tileFlags(g, x, y) & TILE_FLAG_FLOOR) === 0) throw new Error(`${label}: standable tile ${x},${y} lacks the floor flag`);
    }
  }
  // The stored clearance is consistent with the stored masks (nothing mutated the masks after computeClearance).
  const fresh: NavGrid = { ...g, masks: new Uint8Array(g.masks), clearance: new Uint8Array(g.clearance.length) };
  computeClearance(fresh);
  expect(firstDiff(fresh.clearance, g.clearance), `${label}: clearance stale vs masks`).toBe(-1);
  // A person (k = SUB) fits on every standable tile's own anchor.
  for (let y = 0; y < map.rows; y++) for (let x = 0; x < map.cols; x++) if (map.walkable[y]![x] === 0 && !fits(g, x * SUB, y * SUB, SUB)) throw new Error(`${label}: tile ${x},${y} standable but a person does not fit`);
  // Every seat and the spawn are standable.
  expect(isTileStandable(g, map.spawn.x, map.spawn.y), `${label}: spawn ${map.spawn.x},${map.spawn.y}`).toBe(true);
  for (const room of map.rooms) for (const s of room.seats) if (!isTileStandable(g, s.x, s.y)) throw new Error(`${label}: seat ${s.x},${s.y} in ${room.id} is not standable`);
  // Furniture: blocking items close every tile they touch; soft items flag them (decor placed after the nav build included).
  for (const f of map.furniture) {
    for (const t of coveredTiles(f)) {
      if (f.blocking && isTileStandable(g, t.x, t.y)) throw new Error(`${label}: ${f.kind} at ${f.x},${f.y} leaves ${t.x},${t.y} standable`);
      if (!f.blocking && (tileFlags(g, t.x, t.y) & TILE_FLAG_SOFT) === 0) throw new Error(`${label}: soft ${f.kind} at ${f.x},${f.y} did not flag ${t.x},${t.y}`);
    }
  }
}

// ------------------------------------------------------------------ Multiverse

describe('M15 W1: the Multiverse plan through generateMap (property 1)', () => {
  for (const n of [0, 1, 5, 8, 9, 12, 40]) {
    it(`planMultiverse(${n} projects) → generateMap: nav dims, isTileStandable ≡ walkable === 0, every seat standable`, () => {
      const layout = multiverseLayout(n);
      expect(hasLayoutErrors(validateLayout(layout))).toBe(false);
      const map = generateMap(layout);
      expect(map.layoutId).toBe(layout.id);
      expect(hasLayoutErrors(map.issues)).toBe(false);
      expectNavContract(map, `multiverse ${n}`);
      if (n > 0) expect(map.rooms.flatMap((r) => r.seats).length).toBeGreaterThan(0);
    });
  }
});

// ------------------------------------------------------------------ determinism

describe('M15 W1: generateMap is deterministic including map.nav', () => {
  const layouts: OfficeLayout[] = [DEFAULT_LAYOUT, multiverseLayout(12), bspLayout(3, 'hall'), bspLayout(17, 'void'), bspLayout(42, 'hall')];

  it('two runs give byte-identical masks and clearance, and identical walkable', () => {
    for (const layout of layouts) {
      const a = generateMap(layout);
      const b = generateMap(layout);
      expect(a.nav).not.toBe(b.nav); // a fresh grid per call, never a shared buffer
      expect(a.nav.masks).not.toBe(b.nav.masks);
      expect(firstDiff(a.nav.masks, b.nav.masks), `${layout.id}: masks`).toBe(-1);
      expect(firstDiff(a.nav.clearance, b.nav.clearance), `${layout.id}: clearance`).toBe(-1);
      expect(a.walkable, layout.id).toEqual(b.walkable);
      expect(JSON.stringify(a.furniture), layout.id).toBe(JSON.stringify(b.furniture));
    }
  });

  it('interleaving other layouts between the two runs does not change the result (no hidden state)', () => {
    const first = generateMap(DEFAULT_LAYOUT);
    for (const l of layouts) generateMap(l);
    const second = generateMap(DEFAULT_LAYOUT);
    expect(firstDiff(first.nav.masks, second.nav.masks)).toBe(-1);
    expect(firstDiff(first.nav.clearance, second.nav.clearance)).toBe(-1);
  });

  it('mutating a returned grid never leaks into the next call', () => {
    const a = generateMap(DEFAULT_LAYOUT);
    a.nav.masks.fill(0);
    a.nav.clearance.fill(CLEARANCE_MAX);
    a.walkable[0]![0] = 7;
    const b = generateMap(DEFAULT_LAYOUT);
    expect(b.walkable[0]![0]).not.toBe(7);
    expect(b.nav.masks.some((m) => (m & FULL_MASK) === FULL_MASK)).toBe(true);
    expectNavContract(b, 'after mutation');
  });

  it('DEFAULT_LAYOUT and the BSP seeds satisfy the nav contract', () => {
    for (const layout of layouts) expectNavContract(generateMap(layout), layout.id);
  });
});

// ------------------------------------------------------------------ half pins end to end

describe('M15 W1: half-tile pins through validateLayout → generateMap → walkable/nav on DEFAULT_LAYOUT', () => {
  const desks = DEFAULT_LAYOUT.rooms.find((r) => r.id === 'desks')!;
  const lounge = DEFAULT_LAYOUT.rooms.find((r) => r.id === 'lounge')!;
  const library = DEFAULT_LAYOUT.rooms.find((r) => r.id === 'library')!;
  const deskInner = roomInterior(desks);
  const loungeInner = roomInterior(lounge);
  const libInner = roomInterior(library);

  const withPins = (pins: Partial<Record<string, LayoutRoom['furniture']>>): OfficeLayout => ({
    ...DEFAULT_LAYOUT,
    rooms: DEFAULT_LAYOUT.rooms.map((r) => (pins[r.id] ? { ...r, furniture: pins[r.id] } : r)),
  });

  const pins = withPins({
    desks: [
      { kind: 'work-desk', x: 1.5, y: 2, w: 2, h: 1 }, // half on x
      { kind: 'work-desk', x: 6, y: 2.5, w: 2, h: 1 }, // half on y
      { kind: 'cabinet', x: 10.5, y: 3.5, w: 1, h: 1 }, // half on both (blocking)
      { kind: 'plant', x: 13.5, y: 6.5, w: 1, h: 1 }, // half on both (soft)
      { kind: 'work-desk', x: deskInner.w - 2, y: 5.5, w: 2, h: 1 }, // flush with the east wall (inner.w - pin.w)
    ],
    lounge: [{ kind: 'sofa', x: 1, y: 1.5, w: 2, h: 1 }], // soft item on a half row
    library: [{ kind: 'bookcase', x: 0.5, y: 1, w: 2, h: 1 }], // blocking against the west wall edge
  });

  it('the schema accepts half positions and validateLayout reports no error and no pinned-invalid', () => {
    expect(OfficeLayoutSchema.safeParse(pins).success).toBe(true);
    const issues = validateLayout(pins);
    expect(hasLayoutErrors(issues)).toBe(false);
    expect(issues.filter((i) => i.code === 'pinned-invalid')).toEqual([]);
  });

  it('generateMap keeps the layout, places every pin at its float position, and blocks exactly the covered tiles', () => {
    const map = generateMap(pins);
    expect(map.layoutId).toBe(DEFAULT_LAYOUT.id);
    expect(hasLayoutErrors(map.issues)).toBe(false);
    expect(map.issues.filter((i) => i.code === 'pinned-invalid' || i.code === 'pinned-blocks')).toEqual([]);
    const placed = map.furniture.filter((f) => f.pinned);
    expect(placed).toHaveLength(7);

    const expectPin = (roomId: string, inner: { x: number; y: number }, pin: { kind: string; x: number; y: number; w: number; h: number }, blocking: boolean) => {
      const abs = { x: inner.x + pin.x, y: inner.y + pin.y, w: pin.w, h: pin.h };
      const hit = placed.find((f) => f.roomId === roomId && f.kind === pin.kind && f.x === abs.x && f.y === abs.y);
      expect(hit, `${roomId} ${pin.kind} at ${abs.x},${abs.y}`).toMatchObject({ w: pin.w, h: pin.h, blocking, pinned: true });
      const covered = coveredTiles(abs);
      const cells = cellRectOf(abs);
      for (const t of covered) {
        expect(map.walkable[t.y]![t.x], `${roomId} ${pin.kind}: walkable ${t.x},${t.y}`).toBe(blocking ? 1 : 0);
        expect(isTileStandable(map.nav, t.x, t.y), `${roomId} ${pin.kind}: standable ${t.x},${t.y}`).toBe(!blocking);
        // The half-tile model: inside the rect every cell is closed; the uncovered half of a touched tile stays open.
        // M16 insets: a desk's chair-side cells inside the rect may stay open, but every covered tile keeps one closed cell.
        let closed = 0;
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            const cx = t.x * SUB + sx;
            const cy = t.y * SUB + sy;
            const inRect = cx >= cells.x0 && cx < cells.x1 && cy >= cells.y0 && cy < cells.y1;
            const open = isWalkableCell(map.nav, cx, cy);
            if (!open) closed++;
            if (!inRect) expect(open, `${roomId} ${pin.kind}: cell ${cx},${cy} outside the rect`).toBe(true);
            else if (!blocking || pin.kind !== 'work-desk') expect(open, `${roomId} ${pin.kind}: cell ${cx},${cy} inside the rect`).toBe(!blocking);
          }
        }
        if (blocking) expect(closed, `${roomId} ${pin.kind}: closed cells in tile ${t.x},${t.y}`).toBeGreaterThan(0);
      }
      return abs;
    };
    expectPin('desks', deskInner, { kind: 'work-desk', x: 1.5, y: 2, w: 2, h: 1 }, true);
    expectPin('desks', deskInner, { kind: 'work-desk', x: 6, y: 2.5, w: 2, h: 1 }, true);
    expectPin('desks', deskInner, { kind: 'cabinet', x: 10.5, y: 3.5, w: 1, h: 1 }, true);
    expectPin('desks', deskInner, { kind: 'plant', x: 13.5, y: 6.5, w: 1, h: 1 }, false);
    const flush = expectPin('desks', deskInner, { kind: 'work-desk', x: deskInner.w - 2, y: 5.5, w: 2, h: 1 }, true);
    expect(flush.x + flush.w).toBe(deskInner.x + deskInner.w); // touches the east wall, never crosses it
    expectPin('lounge', loungeInner, { kind: 'sofa', x: 1, y: 1.5, w: 2, h: 1 }, false);
    expectPin('library', libInner, { kind: 'bookcase', x: 0.5, y: 1, w: 2, h: 1 }, true);

    // A half-covered tile is blocked for a person but not a full tile: the 1 x 1 cabinet at (+0.5, +0.5) touches 4 tiles
    // and closes 4 cells, one per tile.
    const cab = placed.find((f) => f.kind === 'cabinet')!;
    expect(coveredTiles(cab)).toHaveLength(4);
    let closed = 0;
    for (const t of coveredTiles(cab)) for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) if (!isWalkableCell(map.nav, t.x * SUB + sx, t.y * SUB + sy)) closed++;
    expect(closed).toBe(SUB * SUB);

    // Seats never sit on a tile a half pin touches.
    for (const room of map.rooms) for (const s of room.seats) for (const f of placed) if (f.blocking) expect(coveredTiles(f).some((t) => t.x === s.x && t.y === s.y), `seat ${s.x},${s.y} on ${f.kind}`).toBe(false);
    expectNavContract(map, 'half pins');
  });

  it('a half pin that pokes out by 0.5 is a warning in validateLayout and is skipped (not a fallback) by generateMap', () => {
    const bad = withPins({ desks: [{ kind: 'work-desk', x: deskInner.w - 1.5, y: 2, w: 2, h: 1 }] });
    const issues = validateLayout(bad);
    expect(hasLayoutErrors(issues)).toBe(false);
    expect(issues.some((i) => i.code === 'pinned-invalid')).toBe(true);
    const map = generateMap(bad);
    expect(map.layoutId).toBe(DEFAULT_LAYOUT.id);
    expect(map.issues.some((i) => i.code === 'pinned-invalid' && i.roomIds?.includes('desks'))).toBe(true);
    expect(map.furniture.filter((f) => f.pinned)).toHaveLength(0);
    expectNavContract(map, 'poking pin');
  });

  it('a quarter-tile pin (hand-edited file) is rejected by the schema and skipped by the generator with pinned-invalid', () => {
    const bad = withPins({ desks: [{ kind: 'work-desk', x: 1.25, y: 2, w: 2, h: 1 }] });
    expect(OfficeLayoutSchema.safeParse(bad).success).toBe(false);
    const map = generateMap(bad);
    expect(map.layoutId).toBe(DEFAULT_LAYOUT.id);
    expect(map.issues.some((i) => i.code === 'pinned-invalid' && /half-tile grid/.test(i.message))).toBe(true);
    expect(map.furniture.filter((f) => f.pinned)).toHaveLength(0);
    expectNavContract(map, 'quarter pin');
  });

  it('two half pins sharing a tile without overlapping are both placed and the shared tile is blocked', () => {
    const two = withPins({ desks: [{ kind: 'work-desk', x: 1, y: 2, w: 2, h: 1 }, { kind: 'cabinet', x: 3, y: 2.5, w: 1, h: 1 }] });
    // Rects [1,3)x[2,3) and [3,4)x[2.5,3.5) touch at x = 3 but do not intersect.
    expect(validateLayout(two).filter((i) => i.code === 'pinned-invalid')).toEqual([]);
    const map = generateMap(two);
    expect(map.furniture.filter((f) => f.pinned)).toHaveLength(2);
    expect(map.walkable[deskInner.y + 2]![deskInner.x + 3]).toBe(1);
    expect(map.walkable[deskInner.y + 3]![deskInner.x + 3]).toBe(1);
    expectNavContract(map, 'adjacent half pins');
  });

  it('the half-pinned map is deterministic (nav bytes)', () => {
    const a = generateMap(pins);
    const b = generateMap(pins);
    expect(firstDiff(a.nav.masks, b.nav.masks)).toBe(-1);
    expect(firstDiff(a.nav.clearance, b.nav.clearance)).toBe(-1);
  });
});
