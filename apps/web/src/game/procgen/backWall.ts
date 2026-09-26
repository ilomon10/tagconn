// apps/web/src/game/procgen/backWall.ts  (M8 8p, docs/design/back-wall.md section 2.3)
//
// Pure, deterministic helpers for `generate.ts`'s steps 8b (standing appliances) and 13 (north-wall
// decor). No Phaser, no global state: every function takes exactly the room-local context it needs
// and returns new data, so `generate.ts` stays the single place that mutates the map being built.
import type { FurnishDensity, RoomType } from '@tagconn/shared';
import {
  APPLIANCE_MAX,
  APPLIANCE_MENU,
  APPLIANCE_SPECS,
  WALL_DECOR_MENU,
  WALL_DECOR_SPANS,
  type ApplianceKind,
} from './backWallSpec';
import type { RecipeItem } from './recipes';
import { pick, randInt } from './rng';
import type { Point, Rect, TileKind, WallDecorKind, WallDecorSlot } from './types';

const key = (p: Point) => `${p.x},${p.y}`;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * Shared eligibility rule (docs/design/back-wall.md section 2.3): a room may get standing appliances
 * and semantic north-wall decor only when it is a zone-or-pm-office-shaped room (not `hall`/`stairs`),
 * big enough to matter, and its resolved `furnish.decor` is above 0 (a room with `decor: 0` is
 * byte-identical to pre-8p output for that room - see the parity rule in section 2.5).
 */
export function isEligibleForBackWall(type: RoomType, interior: Rect, decor: number, backWallEnabled: boolean): boolean {
  return backWallEnabled && type !== 'hall' && type !== 'stairs' && interior.w >= 4 && interior.h >= 3 && decor > 0;
}

/** The connected components (4-neighbour) of a set of "x,y" cell keys, as a list of member sets. */
function componentsOf(cells: ReadonlySet<string>): Set<string>[] {
  const seen = new Set<string>();
  const comps: Set<string>[] = [];
  for (const start of cells) {
    if (seen.has(start)) continue;
    const comp = new Set<string>([start]);
    seen.add(start);
    const queue = [start];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++]!;
      const comma = cur.indexOf(',');
      const x = Number(cur.slice(0, comma));
      const y = Number(cur.slice(comma + 1));
      for (const [dx, dy] of DIRS) {
        const nk = `${x + dx},${y + dy}`;
        if (cells.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          comp.add(nk);
          queue.push(nk);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/** Number of 4-connected components in a set of "x,y" cell keys. Exported for `backWall.test.ts`. */
export function componentCount(cells: ReadonlySet<string>): number {
  return componentsOf(cells).length;
}

/**
 * Sets `againstNorthWall: true` on any kept item sitting on `interiorY` whose whole footprint has a
 * wall tile directly north (`PlacedFurniture.againstNorthWall`'s definition). Mutates the given items
 * in place - safe because every caller in `generate.ts` passes its own room-local copies. Additive:
 * geometry (x/y/w/h) is never touched.
 */
export function flagAgainstNorthWall<T extends { x: number; y: number; w: number; h: number; againstNorthWall?: boolean }>(
  items: readonly T[],
  interiorY: number,
  tiles: readonly TileKind[][],
): void {
  for (const item of items) {
    if (item.y !== interiorY) continue;
    let allWall = true;
    for (let x = item.x; x < item.x + item.w; x++) {
      if (tiles[interiorY - 1]?.[x] !== 'wall') {
        allWall = false;
        break;
      }
    }
    if (allWall) item.againstNorthWall = true;
  }
}

function shuffled<T>(arr: readonly T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface ApplianceContext {
  roomType: RoomType;
  interior: Rect;
  density: FurnishDensity;
  tiles: readonly TileKind[][];
  /** Cells already covered by any kept recipe furniture (blocking or soft). */
  occupiedCells: ReadonlySet<string>;
  /** Cells blocked by recipe BLOCKING furniture only (used for the front-cell check). */
  blockedCells: ReadonlySet<string>;
  /** Recipe seat cells for this room (pre-topup). */
  seatCells: ReadonlySet<string>;
  /** Door-apron cells reserved for this room. */
  aprons: ReadonlySet<string>;
  /** This room's locally-reachable interior cells (post recipe furniture, pre-appliances). */
  reach: ReadonlySet<string>;
  /** Count of recipe seats (pre-topup), for the top-up count-parity rule. */
  recipeSeatCount: number;
  rand: () => number;
}
export interface AppliedAppliance extends RecipeItem {
  kind: ApplianceKind;
  againstNorthWall: true;
}

/**
 * Step 8b (docs/design/back-wall.md section 2.3): pick and place standing appliances along a room's
 * north wall row (`interior.y`). Pure and deterministic given the same `rand` stream.
 */
export function placeAppliances(ctx: ApplianceContext): AppliedAppliance[] {
  const menu = APPLIANCE_MENU[ctx.roomType];
  if (!menu || menu.length === 0) return [];
  const { interior, tiles, rand } = ctx;
  const y = interior.y;
  const x0 = interior.x;
  const x1 = interior.x + interior.w - 1;

  const isApron = (p: Point) => ctx.aprons.has(key(p));
  const validSingle = (x: number): boolean => {
    if (x < x0 || x > x1) return false;
    if (tiles[y - 1]?.[x] !== 'wall') return false;
    const p = { x, y };
    if (isApron(p) || isApron({ x: x - 1, y }) || isApron({ x: x + 1, y })) return false;
    if (ctx.occupiedCells.has(key(p)) || ctx.seatCells.has(key(p))) return false;
    const front = { x, y: y + 1 };
    if (ctx.blockedCells.has(key(front)) || isApron(front)) return false;
    return true;
  };

  // The "how many to try" estimate only needs a wall behind the column (not full validity): many
  // recipes legitimately seat people right against the wall row (a meeting table's north-facing
  // chairs, a desk row's first stack), which would otherwise starve `count` down to 0 in an
  // otherwise roomy, wall-backed room even though a stray column or two is still free. `validSingle`
  // (the full per-cell rule) still gates every actual placement below, so this never places an
  // appliance on a seat/apron/occupied cell - it only sizes the attempt budget.
  let wallBackedCols = 0;
  for (let x = x0; x <= x1; x++) if (tiles[y - 1]?.[x] === 'wall') wallBackedCols++;
  const count = Math.min(APPLIANCE_MAX[ctx.density], Math.floor(wallBackedCols / 3));
  if (count <= 0) return [];

  // Weighted-without-replacement draw: shuffle a copy of the menu (repeats in the table give higher
  // weight) and pop from the front. Library never runs dry: it refills with `bookcase`.
  const pool = shuffled(menu, rand);
  let poolIdx = 0;
  const nextKind = (): ApplianceKind | undefined => {
    if (poolIdx < pool.length) return pool[poolIdx++]!;
    return ctx.roomType === 'library' ? 'bookcase' : undefined;
  };
  const xsOrder = shuffled(
    Array.from({ length: x1 - x0 + 1 }, (_, i) => x0 + i),
    rand,
  );

  const accepted: AppliedAppliance[] = [];
  const acceptedCells = new Set<string>();
  // Free-interior set for the "no split" check: every interior cell not already covered by recipe
  // furniture (blocking or soft). Shrinks as appliances are accepted.
  const freeInterior = new Set<string>();
  for (let iy = interior.y; iy < interior.y + interior.h; iy++) {
    for (let ix = interior.x; ix < interior.x + interior.w; ix++) {
      const p = { x: ix, y: iy };
      if (!ctx.occupiedCells.has(key(p))) freeInterior.add(key(p));
    }
  }

  let runningReachSize = ctx.reach.size;
  const need = Math.max(0, 12 - ctx.recipeSeatCount);
  const maxAttempts = 3 * count;
  let attempts = 0;
  // `freeInterior`'s component structure only changes when a placement is actually ACCEPTED (it's
  // untouched by a rejected candidate), so this is computed once and only refreshed after an accept -
  // not on every attempted start position. That keeps the split check (section 2.3 constraint 1) at
  // O(accepted rooms) flood fills instead of O(attempts x positions), which matters on a 128x96 map
  // with dozens of eligible rooms (perf.test.ts's budget).
  let beforeComponents = componentsOf(freeInterior);
  while (accepted.length < count && attempts < maxAttempts) {
    attempts++;
    const kind = nextKind();
    if (!kind) break;
    const w = APPLIANCE_SPECS[kind].w;

    for (const startX of xsOrder) {
      if (startX + w - 1 > x1) continue;
      const cellKeys: string[] = [];
      let ok = true;
      for (let x = startX; x < startX + w; x++) {
        const k = key({ x, y });
        if (!validSingle(x) || acceptedCells.has(k)) {
          ok = false;
          break;
        }
        cellKeys.push(k);
      }
      if (!ok) continue;

      // Constraint 2 (top-up count parity) - cheaper than the flood fill, so check it first.
      const freeReachableNonSeat = runningReachSize - ctx.recipeSeatCount;
      if (freeReachableNonSeat - cellKeys.length < need) continue;

      // Constraint 1 (no split, except removing a component made entirely of these cells).
      const cellKeySet = new Set(cellKeys);
      let fullyRemoved = 0;
      for (const comp of beforeComponents) {
        let allIn = true;
        for (const k of comp) {
          if (!cellKeySet.has(k)) {
            allIn = false;
            break;
          }
        }
        if (allIn) fullyRemoved++;
      }
      const afterSet = new Set(freeInterior);
      for (const k of cellKeys) afterSet.delete(k);
      if (componentCount(afterSet) !== beforeComponents.length - fullyRemoved) continue;

      accepted.push({ kind, x: startX, y, w, h: 1, blocking: true, variant: Math.floor(rand() * 4), againstNorthWall: true });
      for (const k of cellKeys) {
        acceptedCells.add(k);
        freeInterior.delete(k);
      }
      runningReachSize -= cellKeys.length;
      beforeComponents = componentsOf(freeInterior); // refresh: the structure just changed
      break;
    }
  }
  return accepted;
}

// ------------------------------------------------------------------ north-wall decor (step 13)

/** Room types that get the centred banner-window-banner rhythm (section 2.3 step 4). */
const FEATURE_TYPES: ReadonlySet<RoomType> = new Set(['lounge', 'entrance', 'pm-office', 'meeting-room']);

interface Span {
  start: number;
  end: number;
}
function subRuns(run: Span, occupied: ReadonlySet<number>): Span[] {
  const out: Span[] = [];
  let start: number | null = null;
  for (let x = run.start; x <= run.end; x++) {
    if (!occupied.has(x)) {
      if (start === null) start = x;
    } else if (start !== null) {
      out.push({ start, end: x - 1 });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end: run.end });
  return out;
}

export interface NorthWallContext {
  roomId: string;
  roomType: RoomType;
  interior: Rect;
  tiles: readonly TileKind[][];
  /** Wall-row (`interior.y - 1`) columns already covered by an appliance or a `TALL_AGAINST_WALL_KINDS`
   *  item - `generate.ts` builds this from step 8b's output plus `flagAgainstNorthWall`. */
  tallColumns: ReadonlySet<number>;
  /** Resolved `furnish.decor` for this room (same precedence generate.ts already uses). */
  decor: number;
  rand: () => number;
}
export interface NorthWallLight {
  x: number;
  y: number;
  variant: number;
}
export interface NorthWallResult {
  slots: WallDecorSlot[];
  lights: NorthWallLight[];
}

/** Step 13 (docs/design/back-wall.md section 2.3): plan the semantic wall decor and light columns
 *  along a room's north wall row. Pure and deterministic given the same `rand` stream. */
export function planNorthWall(ctx: NorthWallContext): NorthWallResult {
  const { interior, tiles, rand, roomType, roomId } = ctx;
  const wallY = interior.y - 1;
  const labelReserve = Math.min(3, Math.floor(interior.w / 3));
  const startX = interior.x + labelReserve;
  const endX = interior.x + interior.w - 1;
  const slots: WallDecorSlot[] = [];
  const lights: NorthWallLight[] = [];
  if (startX > endX) return { slots, lights };

  const nearDoor = (x: number): boolean => {
    for (const xx of [x - 1, x, x + 1]) if (tiles[wallY]?.[xx] === 'door') return true;
    return false;
  };
  const runs: Span[] = [];
  let runStart: number | null = null;
  for (let x = startX; x <= endX; x++) {
    const available = tiles[wallY]?.[x] === 'wall' && !nearDoor(x) && !ctx.tallColumns.has(x);
    if (available) {
      if (runStart === null) runStart = x;
    } else if (runStart !== null) {
      runs.push({ start: runStart, end: x - 1 });
      runStart = null;
    }
  }
  if (runStart !== null) runs.push({ start: runStart, end: endX });

  const featureEligible = FEATURE_TYPES.has(roomType);
  const menu = WALL_DECOR_MENU[roomType];

  for (const run of runs) {
    const runLen = run.end - run.start + 1;
    const occupied = new Set<number>();

    // 3. Lights first: every 5th column (a stream-drawn phase), consuming it.
    if (runLen > 1) {
      const k = randInt(rand, 0, 4);
      for (let i = 0; i < runLen; i++) {
        if ((i + k) % 5 !== 2) continue;
        const x = run.start + i;
        occupied.add(x);
        lights.push({ x, y: wallY, variant: Math.floor(rand() * 4) });
      }
    }

    // 4. Feature pattern: banner-window-banner, centred in the biggest sub-run lights left free.
    if (featureEligible && runLen >= 5) {
      const free = subRuns(run, occupied)
        .filter((s) => s.end - s.start + 1 >= 2)
        .sort((a, b) => b.end - b.start - (a.end - a.start));
      const best = free[0];
      if (best) {
        const len = best.end - best.start + 1;
        const windowSpan = 2;
        const mid = Math.max(best.start, Math.min(best.start + Math.floor((len - windowSpan) / 2), best.end - windowSpan + 1));
        slots.push({ kind: 'window', x: mid, y: wallY, span: windowSpan, roomId, variant: Math.floor(rand() * 4) });
        if (len >= 6) {
          slots.push({ kind: 'banner', x: mid - 2, y: wallY, span: 1, roomId, variant: Math.floor(rand() * 4) });
          slots.push({ kind: 'banner', x: mid + windowSpan + 1, y: wallY, span: 1, roomId, variant: Math.floor(rand() * 4) });
        } else if (len >= 4) {
          if (mid - 1 >= best.start) slots.push({ kind: 'banner', x: mid - 1, y: wallY, span: 1, roomId, variant: Math.floor(rand() * 4) });
          if (mid + windowSpan <= best.end) slots.push({ kind: 'banner', x: mid + windowSpan, y: wallY, span: 1, roomId, variant: Math.floor(rand() * 4) });
        }
        for (let x = best.start; x <= best.end; x++) occupied.add(x);
      }
    }

    // 5. Greedy fill of whatever sub-runs remain.
    if (menu && menu.length) {
      for (const sub of subRuns(run, occupied)) {
        let x = sub.start;
        while (x <= sub.end) {
          if (rand() < 0.25 + 0.6 * ctx.decor) {
            const kind: WallDecorKind = pick(rand, menu);
            const span = pick(rand, WALL_DECOR_SPANS[kind]);
            if (x + span - 1 <= sub.end) {
              slots.push({ kind, x, y: wallY, span, roomId, variant: Math.floor(rand() * 4) });
              x += span + 1;
              continue;
            }
          }
          x += 1;
        }
      }
    }
  }

  return { slots, lights };
}
