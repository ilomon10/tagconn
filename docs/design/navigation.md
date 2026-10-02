# Dual grid, parts B and C: half-tile placement, nav grid and navigation (M15 → v0.9.0)

Status: approved for implementation · Plan: `~/.claude-sessions/profiles/edgar/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md`
sections "Part B" and "Part C" · ADR #29. Sibling doc: `docs/design/dual-grid.md` (part A, rendering).
Scope: `packages/shared/src/layout.ts` (pins in halves, covered-tile helpers), `apps/web/src/game/procgen/`
(one rasterizer), `apps/web/src/game/nav/` (new, pure TS), `apps/web/src/features/editor/` (half-tile drag),
`actors/Character.ts` (px walks). No server code beyond the widened pin schema.

Read first: `docs/design/game-office.md` §5 (pins, `resolvePins`, `seatsFor`, editor), `docs/design/back-wall.md` §2.3
(`flagAgainstNorthWall`, appliances), `docs/design/office-life.md` §0 (cosmetic scripts, `WAITING_CLEARANCE_TILES`).

---

## 0. Goals, non-goals, invariants

**Goals.** Furniture can be placed on a half-tile grid (twice the density); characters walk straight lines in pixels
instead of tile-centre zigzags; small creatures (cat, slime) fit through gaps a person cannot; collision is one
grid that both placement and movement read.

**Non-goals (M15).** Fractional furniture *sizes* (W4 painter audit), new recipes (W4, behind the seat-reachability
property), 4-direction sprites (M17; `facing` is only recorded), a user-facing "walk anywhere" mode.

**Invariants.**
1. **The half tile (8 px) is the unit** for placement, the offset render grid and navigation. `SUB = 2` is the one
   constant; `CELL_PX`, `BITS_PER_TILE`, `FULL_MASK` and the bit layout derive from it. Nothing else hard-codes 8.
2. **The nav grid is the collision source of truth.** `GeneratedMap.walkable` is derived from it
   (`walkable[y][x] = isTileStandable(nav, x, y) ? 0 : 1`) and never written anywhere else.
3. **Conservative tile reachability.** A tile is blocked when *any* blocking footprint overlaps it. Procgen's
   reachability, seat filtering, `localReach`, `reachableFrom` and every tile-based consumer (`walkable`, `roomAt`,
   seats, spots) keep today's tile semantics; a person needs a full 16 px anyway.
4. **D2 holds.** Nav shapes are keyed by `FurnitureKind` (`KIND_SHAPE`), never by style. A skin switch never
   changes a mask.
5. **office-life.md §0 unchanged.** Scripts still call `finder().find(c.tile, spot)` with tile points and
   `c.walk(path, ...)`; the Navigator is an addition behind the same `PathFinder` object. Nothing a script does
   assigns seats or crosses a blocked tile.
6. **Feet and nav points.** A character's origin is its feet at `(tx*16 + 8, ty*16 + 14)` (`Character.teleport`).
   The nav point is `(feet.x, feet.y - FEET_DY)` with `FEET_DY = 6`: for a person that is the tile centre. A person is
   a `k = 2` block of cells, which is exactly one tile, so a person anchored on a tile lands on today's feet pixel and
   `Character.tile`, seats, `SeatAllocator.occupant` and the arrival checks that compare `c.tile` with a seat are
   unaffected. Today's behaviour is the `k = 2` special case.
7. **Determinism.** No `Math.random`; heap ties break by `h` then node id; passability caches are pure functions of
   the grid. Two runs give equal paths.
8. **Hot files.** No task edits `OfficeScene.ts`, `OfficeView.tsx` or `OfficeGame.ts`; the PM wires (§6).

---

## 1. Contract

### 1.1 `packages/shared/src/layout.ts` (W0, landed; shown for reference)

```ts
export const HALF_TILE = 0.5;
export const PinnedFurnitureSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  x: z.number().multipleOf(HALF_TILE).min(0).max(LAYOUT_LIMITS.maxWidth),   // was .int(): a superset, no migration
  y: z.number().multipleOf(HALF_TILE).min(0).max(LAYOUT_LIMITS.maxHeight),
  w: z.number().int().min(1).max(8),   // sizes stay whole tiles this milestone
  h: z.number().int().min(1).max(8),
  variant: z.number().int().min(0).max(255).optional(),
});
export const rectsIntersect = (a: TileRect, b: TileRect): boolean => /* strict overlap, works with halves */;
/** floor of the start edge to ceil of the end edge: any partial overlap counts the whole tile. Integer rects map to themselves. */
export function coveredTileRect(r: TileRect): TileRect;
/** every integer tile `coveredTileRect(r)` spans, row-major. */
export function coveredTiles(r: TileRect): { x: number; y: number }[];
```

`validateLayout` already uses `rectsIntersect` for pin overlap and `coveredTileRect` in `pinOnDoorApron`
(conservative). Stored rows and `.tagconn/office.json` with integer pins keep parsing.

### 1.2 `procgen/geometry.ts` (T2, the one rasterizer)

```ts
import { coveredTileRect, coveredTiles, rectsIntersect } from '@tagconn/shared';
import type { Point, Rect } from './types';
export { coveredTileRect, coveredTiles, rectsIntersect };
export const tileKey = (p: Point): string => `${p.x},${p.y}`;
/** Integer tiles a (possibly half-offset) rect touches, row-major. For integer rects: today's `rectCells` exactly. */
export function rectCells(r: Rect): Point[];          // = coveredTiles(r)
export function cellKeys(r: Rect): string[];          // = rectCells(r).map(tileKey)
export function overlapsAny(r: Rect, others: readonly Rect[]): boolean;   // rectsIntersect
export const snapHalf = (v: number): number => Math.round(v * 2) / 2;
export const isHalfAligned = (r: Rect): boolean => [r.x, r.y].every((v) => Number.isInteger(v * 2)) && Number.isInteger(r.w) && Number.isInteger(r.h);
```

### 1.3 `procgen/types.ts` (W0)

```ts
import type { NavGrid } from '../nav/grid';
export interface GeneratedMap {
  /* ...existing... */
  /** [y][x] 0 = walkable, 1 = blocked. M15: DERIVED from `nav` (`isTileStandable`), never written directly. */
  walkable: number[][];
  /** M15: the collision source of truth (docs/design/navigation.md). Optional until W1 lands; `buildWorld` falls back to `buildNavGrid(map)`. */
  nav?: NavGrid;
}
```

`nav/grid.ts` is created in W0 with the types and the signatures of §2 (bodies may throw `not implemented` until T1,
the M12/M13 stub precedent), so `procgen/types.ts` imports a real file.

---

## 2. NavGrid data (`apps/web/src/game/nav/`, pure TS, no Phaser)

### 2.1 `nav/constants.ts` (W0, verbatim)

```ts
export const TILE_PX = 16;
/** Cells per tile side. The single sub-grid constant; everything below derives from it. */
export const SUB = 2;
export const SUB_SHIFT = Math.log2(SUB);          // 1; a test asserts it is an integer
export const CELL_PX = TILE_PX / SUB;              // 8
export const BITS_PER_TILE = SUB * SUB;            // 4
export const FULL_MASK = (1 << BITS_PER_TILE) - 1; // 0xF
/** Clearance values saturate here (fits any class up to k = 7). */
export const CLEARANCE_MAX = 7;
/** Nav point = feet - FEET_DY (a person's nav point is its tile centre). */
export const FEET_DY = 6;
/** Tile flags in the high nibble of `NavGrid.masks`. */
export const TILE_FLAG_FLOOR = 0x10; // floor or door tile
export const TILE_FLAG_DOOR = 0x20;
export const TILE_FLAG_SOFT = 0x40;  // a non-blocking item covers (part of) the tile
export const TILE_FLAGS = 0xf0;
```

### 2.2 `nav/grid.ts` (W0 signatures, T1 bodies)

> **As landed (W0, commit d14195b):** `CellRect` is `{ x0, y0, x1, y1 }` with half-open cell bounds `x0 <= cx < x1` (`nav/types.ts`), not
> `{x, y, w, h}`. Everything in `nav/` follows that type; read `dirty.x + dirty.w` below as `dirty.x1`. `SUB_SHIFT` and
> `TILE_FLAGS` are exported from `nav/constants.ts`.

```ts
import type { PlacedFurniture, Point, Rect } from '../procgen/types';
import type { NavShape } from './shapes';

/** A rect in CELLS (half tiles). */
export interface CellRect { x: number; y: number; w: number; h: number }

export interface NavGrid {
  cols: number; rows: number;     // tiles
  ccols: number; crows: number;   // cells = cols * SUB, rows * SUB
  /** Per tile (index y*cols+x): low nibble = walkable cell bits (see bitOf), high nibble = TILE_FLAG_*. */
  masks: Uint8Array;
  /** Per cell (index cy*ccols+cx): true clearance 0..CLEARANCE_MAX; 0 = blocked. */
  clearance: Uint8Array;
}

export const tileIndex = (g: Pick<NavGrid, 'cols'>, x: number, y: number): number => y * g.cols + x;
export const cellIndex = (g: Pick<NavGrid, 'ccols'>, cx: number, cy: number): number => cy * g.ccols + cx;
/** Bit of cell (cx, cy) inside its tile's nibble: `(cy % SUB) * SUB + (cx % SUB)` (tl=0 tr=1 bl=2 br=3 for SUB=2). */
export const bitOf = (cx: number, cy: number): number => ((cy & (SUB - 1)) * SUB) | (cx & (SUB - 1));

export function createNavGrid(cols: number, rows: number): NavGrid;                    // every cell blocked, no flags
export function isWalkableCell(g: NavGrid, cx: number, cy: number): boolean;           // false outside
/** World px (nav point space). Broad: tile `px >> 4`; early-out on FULL_MASK / 0; narrow: the cell bit. */
export function isWalkableWorld(g: NavGrid, px: number, py: number): boolean;
/** Nibble === FULL_MASK: a person can stand here (today's `walkable === 0`). */
export function isTileStandable(g: NavGrid, x: number, y: number): boolean;
export function setCell(g: NavGrid, cx: number, cy: number, walkable: boolean): void;  // masks only; call updateClearance after
export function setTileFlags(g: NavGrid, x: number, y: number, flags: number): void;   // OR into the high nibble
export function tileFlags(g: NavGrid, x: number, y: number): number;
/** `clearance[cell] >= k` (false outside). A k x k block anchored (top-left) at the cell fits. */
export function fits(g: NavGrid, cx: number, cy: number, k: number): boolean;
/** Tile rect (positions multiples of 1/SUB) → cell rect. `Math.round` because `r.x * SUB` is exact for halves. */
export function cellRectOf(r: Rect): CellRect;
/** Anchor (top-left cell) of a k x k block centred on nav point `p`: `round(p / CELL_PX - k / 2)`. */
export function anchorOfPoint(p: Point, k: number): Point;
/** Centre nav point of a block anchored at `a`: `(a + k / 2) * CELL_PX`. */
export function pointOfAnchor(a: Point, k: number): Point;
/** Nav point of a tile for class size k: `pointOfAnchor({ x: t.x * SUB, y: t.y * SUB }, k)`; k = 2 → the tile centre. */
export function navPointOfTile(t: Point, k?: number): Point;
export function tileOfNavPoint(p: Point): Point;   // floor(p / TILE_PX)
/** Clears the cells of every item per `shapes[kind]` (blocking) and sets TILE_FLAG_SOFT (non-blocking). Returns the dirty cell rect (union) or null. */
export function applyFurniture(g: NavGrid, items: readonly PlacedFurniture[], shapes?: Record<string, NavShape>): CellRect | null;
/**
 * Rasterizes `tiles` (floor/door → FULL + flags, wall/void → 0), applies `baseWalkable` when given (a tile with
 * 1 → 0 nibble; the pre-furniture grid of generate.ts, so stairs/landing blocks and anything else the generator
 * marks stay authoritative), then `applyFurniture`, then `computeClearance`.
 */
export function buildNavGrid(map: Pick<GeneratedMap, 'cols' | 'rows' | 'tiles' | 'furniture'>, baseWalkable?: readonly number[][], shapes?: Record<string, NavShape>): NavGrid;
/** Adapter fallback for `number[][]` callers: each tile FULL (0) or 0 (1), floor flag on walkable tiles. */
export function navGridFromWalkable(walkable: readonly number[][]): NavGrid;
/** `[y][x] = isTileStandable ? 0 : 1`. */
export function walkableFromNav(g: NavGrid): number[][];
export function computeClearance(g: NavGrid): void;
export function updateClearance(g: NavGrid, dirty: CellRect): void;
```

`isWalkableWorld` pseudo-code (hot path, no allocation):

```ts
if (px < 0 || py < 0) return false;
const tx = px >> 4, ty = py >> 4;                       // TILE_PX = 16; use Math.floor(px / TILE_PX) if TILE_PX changes
if (tx >= g.cols || ty >= g.rows) return false;
const m = g.masks[ty * g.cols + tx]! & FULL_MASK;
if (m === FULL_MASK) return true;
if (m === 0) return false;
return ((m >> bitOf(px >> 3, py >> 3)) & 1) === 1;      // CELL_PX = 8
```

**True clearance** (HAA*, exact for k x k blocks, one pass, O(cells)):

```ts
export function computeClearance(g) {
  for (let cy = g.crows - 1; cy >= 0; cy--) for (let cx = g.ccols - 1; cx >= 0; cx--) g.clearance[cellIndex(g, cx, cy)] = clearanceAt(g, cx, cy);
}
function clearanceAt(g, cx, cy): number {
  if (!isWalkableCell(g, cx, cy)) return 0;
  const r = cx + 1 < g.ccols ? g.clearance[cellIndex(g, cx + 1, cy)]! : 0;
  const d = cy + 1 < g.crows ? g.clearance[cellIndex(g, cx, cy + 1)]! : 0;
  const rd = cx + 1 < g.ccols && cy + 1 < g.crows ? g.clearance[cellIndex(g, cx + 1, cy + 1)]! : 0;
  return Math.min(CLEARANCE_MAX, 1 + Math.min(r, d, rd));
}
```

Exactness: `c(x, y) >= k` iff the k x k block at `(x, y)` is free. Induction on k: `k = 1` is the cell itself; a
k x k block is the cell plus the three (k-1) x (k-1) blocks at `(x+1, y)`, `(x, y+1)`, `(x+1, y+1)` (their union
covers it), so `c >= k` iff all three have `c >= k - 1`. Saturation at `CLEARANCE_MAX` only loses information for
`k > 7`, which no class uses.

**Incremental update** (the dependency cone): `c(x, y)` reads cells `(x..x+CLEARANCE_MAX-1, y..y+CLEARANCE_MAX-1)`
at most, and only cells to the right/below. So a change inside `dirty` can only alter clearances in `dirty` grown
by `CLEARANCE_MAX - 1` to the left and up (not right/down):

```ts
export function updateClearance(g, dirty) {
  const x0 = Math.max(0, dirty.x - (CLEARANCE_MAX - 1)), y0 = Math.max(0, dirty.y - (CLEARANCE_MAX - 1));
  const x1 = Math.min(g.ccols, dirty.x + dirty.w), y1 = Math.min(g.crows, dirty.y + dirty.h);
  for (let cy = y1 - 1; cy >= y0; cy--) for (let cx = x1 - 1; cx >= x0; cx--) g.clearance[cellIndex(g, cx, cy)] = clearanceAt(g, cx, cy);
}
```

Cells right/below the grown rect are unchanged inputs; cells inside are recomputed bottom-right first, so every
read is either outside (unchanged, correct) or already updated. Property test: equals a full `computeClearance`.

### 2.3 `nav/shapes.ts` (W0 signatures, T1 bodies)

```ts
import type { FurnitureKind } from '../procgen/types';
import type { CellRect } from './grid';
/** Which cells of a footprint block. Insets are in cells from the footprint edge. */
export type NavShape =
  | 'full'
  | 'none'
  | { inset: { n: number; e: number; s: number; w: number } }
  | { mask: (w: number, h: number) => boolean[][] };   // [cy][cx] over the footprint's cells
/** Style-independent (D2). M15 start: `KIND_BLOCKING[kind] ? 'full' : 'none'` for every kind, so routing is unchanged until W4 tunes it. */
export const KIND_SHAPE: Record<FurnitureKind, NavShape>;
/** Predicate over cells inside `cells` for `shape`. */
export function blockedCells(shape: NavShape, cells: CellRect): (cx: number, cy: number) => boolean;
```

Test: every `FurnitureKind` has an entry, and in M15 `KIND_SHAPE[k] === (KIND_BLOCKING[k] ? 'full' : 'none')`.

### 2.4 `nav/classes.ts` (W0, verbatim)

```ts
import type { CreatureId } from '../themes/types';
export type NavClass = 'small' | 'person' | 'large';
/** Block side in cells. `person` (k = 2) is exactly one tile. `large` is reserved (no actor uses it in M15). */
export const NAV_CLASS_SIZE: Record<NavClass, number> = { small: 1, person: 2, large: 3 };
export const CREATURE_NAV_CLASS: Record<CreatureId, NavClass> = {
  cat: 'small', dog: 'small', slime: 'small', familiar: 'small', 'astro-cat': 'small', 'void-blob': 'small',
  monster: 'person', wolf: 'person', 'hover-hound': 'person',
};
/** Humans (null creature) are `person`. */
export const navClassFor = (creature: CreatureId | null): NavClass => (creature ? CREATURE_NAV_CLASS[creature] : 'person');
```

### 2.5 `nav/index.ts` (W0): re-exports constants, grid, shapes, classes; T4 adds heap/macro/adapter, T6 micro/navigator.

---

## 3. Half-tile procgen and editor (T2, T3)

### 3.1 Rasterizer swap (T2)

One rasterizer, `procgen/geometry.ts` (§1.2). Every cell loop over a furniture rect goes through `rectCells` /
`cellKeys`; integer rects produce today's output exactly, so integer layouts stay byte-identical.

| site | today | after |
|---|---|---|
| `generate.ts:74-78` `rectCells` | local integer loop | import from `geometry.ts`; all uses (`:239, :244, :626, :636, :693, :747, :764, :783, :841, :857, :977, :1012`) unchanged in call shape |
| `generate.ts:828-832` apply blocking furniture to `walkable` | loop writes `walkable = 1` | removed; replaced by the PM wiring: `const nav = buildNavGrid({ cols, rows, tiles, furniture }, walkable); walkable = walkableFromNav(nav);` and `nav` on the map |
| `pins.ts:98-115` pin cells | integer loop building `cells` | `abs` keeps fractional `x/y`; `cells = cellKeys(abs)`; pin-vs-pin overlap uses `rectsIntersect` against earlier accepted pin rects (exact, so two half-offset pins may share a tile without overlapping); apron check stays on `cells` (any covered apron tile seals, conservative); bounds check `f.x + f.w > interior.w` works with halves |
| `generate.ts` recipe `fits` (pinned cells) | set of pin cells | `cellKeys(pin)` (covered tiles) |
| `triggers.ts:40-44` `cellsOf` | local loop | `cellKeys` |
| `npc/receptionistSpot.ts:42` desk tiles, `:64` `isReceptionDeskTile` | integer loops | `coveredTiles(f)`; `rectsIntersect(f, { ...spot, w: 1, h: 1 })` |
| `backWall.ts:77-93` `flagAgainstNorthWall` | `item.y !== interiorY` strict; x loop over `item.x..item.x+item.w` | keep the strict `item.y === interiorY` (a `y + 0.5` item never gets overdraw; it is not against the wall); x loop over `coveredTileRect(item)` columns |
| `backWall.ts` occupied/blocked cells (`generate.ts:764, :783`) | `rectCells` | same call, covered tiles |
| `recipes.ts:383` `seatsFor(kind, rect, interior)` | math on `rect` | `const c = coveredTileRect(rect)` first; all math on `c` (outward row below `c`, ring around `c`, "sit on itself" over `coveredTiles(c)`); integer input → identical |
| `dramaSpots.ts:14` `gatherSpots`, `life/spots.ts:12` `ringSpots` / `:27` `propSpots` | ring around `prop` | ring around `coveredTileRect(prop)`; non-blocking `propSpots` iterate `coveredTiles(prop)` |

`resolvePins` rules after T2: (1) unknown kind → skipped, `pinned-invalid`; (2) `!isHalfAligned(pin)` → skipped,
`pinned-invalid` (the schema already enforces it; this is the defensive path for hand-edited files); (3) outside the
interior → skipped; (4) `rectsIntersect` with an earlier accepted pin → skipped; (5) blocking and any covered tile is
an apron → skipped, `pinned-blocks`; (6) emitted with fractional `x/y`, integer `w/h`, `pinned: true`.

Recipes are unchanged this milestone (`furnish.test.ts` stays byte-identical). Half-gap pitches are W4, gated on the
seat-reachability property (§5).

**Why `localReach` and reachability stay tile-based.** (a) Budget: the 128 x 96 procgen median must stay under the
`generate.perf.test.ts` ceiling; a cell-level flood per retry would quadruple it. (b) Persons need a full tile; a
half-blocked tile is unusable for every seat and spawn anyway. (c) `rooms[].tiles`, `zones[].tiles`, seats and
`reachability` keep their meaning for every consumer (HUD, life, drama, NPCs). Cell-level routing for small
creatures lives in the Navigator, not in procgen.

### 3.2 Editor (T3)

- `PlanCanvas.tsx`: a `toWorldHalf(screenX, screenY)` next to `toWorldTile` (`:175`): `Math.floor(v * 2) / 2` of the
  fractional tile coordinate. The furniture drag (`:650-673`) tracks `startHalf`/`origin` in halves and calls
  `setPinPos` with `origin + (half - startHalf)`; room draw/move/resize keep `toWorldTile`. Hit-testing
  (`hitFurnitureAt`, `:593, :646`) passes the exact fractional world point.
- `features/editor/pins.ts`: `snapHalf(v)`; `clampPinPos` snaps `pos` to halves, then clamps to
  `[0, inner.w - pin.w]` (an integer, so the clamp keeps alignment); `pinFits` unchanged (`intersects` works with
  halves; `onDoorApron` via `coveredTileRect` like shared); `prunePins` unchanged; `hitFurnitureAt(map, rooms, at:
  { x: number; y: number })` accepts a fractional point and tests real rect bounds (`covers` unchanged); pins first.
- `shortcuts.ts`: the `nudge` action keeps `resize: e.altKey` and `magnitude = shift ? 5 : 1`; the keyboard consumer
  (`OfficeEditor.tsx` / `PlanCanvas.tsx` key handler) interprets `resize` as "half step" when a pin is selected:
  `nudgePin(roomId, index, dx * (alt ? 0.5 : 1), dy * (alt ? 0.5 : 1))` (Shift still x5, so Shift+Alt = 2.5).
  Rooms keep Alt = resize.
- `editorStore.ts` `setPinPos` / `nudgePin`: unchanged apart from passing through halves (they already go through
  `clampPinPos` + `pinFits`).
- `Inspector.tsx:350`: `fmtTile(v) = Number.isInteger(v) ? String(v) : v.toFixed(1)` so a pin shows `at 2.5, 1`.
- `docs/design/game-office.md` §5.1/5.2/5.4 wording (done in W0 alongside this doc): positions in halves, sizes
  whole, "any overlap blocks the tile".

---

## 4. Navigation (`nav/heap.ts`, `macro.ts` [T4]; `micro.ts`, `navigator.ts` [T6]; `adapter.ts` [T4])

### 4.1 Heap (T4)

```ts
/** Binary min-heap over node ids with typed-array storage. Order: f asc, then h asc, then id asc (deterministic). */
export class NodeHeap {
  constructor(capacity: number);
  push(id: number, f: number, h: number): void;   // grows if needed
  pop(): number;                                   // -1 when empty
  get size(): number;
  clear(): void;
}
```

### 4.2 Macro: tile A* per class (T4)

```ts
export interface MacroOptions {
  /** Start may be impassable (a character mid-rebuild stands on a blocked tile). Default true. */
  allowBlockedStart?: boolean;
  /** Per-query extra blocks (tile indices), used by Navigator repairs. */
  blockedOverride?: ReadonlySet<number>;
}
/** Per-class tile passability (the only place it is defined). */
export function tilePassable(g: NavGrid, cls: NavClass, x: number, y: number): boolean;
export class MacroPlanner {
  constructor(grid: NavGrid);
  /** 8-connected tile path, both ends included, octile cost (1, SQRT2), NO corner cutting (a diagonal step needs both
   *  orthogonal neighbours passable: easystar's `disableCornerCutting`). null when unreachable or `to` impassable. */
  search(from: Point, to: Point, cls: NavClass, opts?: MacroOptions): Point[] | null;
  /** Drops the passability caches (grid changed). */
  invalidate(): void;
}
```

| class | `tilePassable` |
|---|---|
| `person` | `isTileStandable` (nibble `FULL_MASK`): today's rule exactly |
| `small` | at least one walkable cell in the tile (nibble `!== 0`) |
| `large` | standable and `clearance[tile's top-left cell] >= 3` |

> **As landed (T6):** a `small` step also needs the two tiles to connect at the cell level across their shared edge
> (`MacroPlanner.smallEdgeOpen`: a free cell pair across the edge; for a diagonal the two touching corner cells plus the
> corner cells of both orthogonal tiles). Without it a half-tile divider on a shared edge leaves both tiles passable but
> cuts the hop, and the per-tile repairs below cannot route around a long divider (measured: 8 % repairs per hop and a
> quarter of the paths giving up on random dividers; with the rule 0.1 % and none). The start tile counts as fully free.

Implementation notes: one `Uint8Array` passability cache per class (0 unknown, 1 yes, 2 no), `Int32Array` for
`g`-cost (fixed-point x1000), parent and generation stamps for open/closed (`stamp++` per query, no clearing),
`NodeHeap` of tile indices. No per-query allocation except the result array. `from === to` → `[from]`.

### 4.3 Micro: line of sight, windowed A*, string pulling (T6)

```ts
export const MICRO_MAX_NODES = 64;
/** Supercover line from anchorOfPoint(a, k) to anchorOfPoint(b, k): every anchor cell the segment touches must `fits(k)`. */
export function lineOfSight(g: NavGrid, a: Point, b: Point, k: number): boolean;
/** 8-connected A* over anchor cells inside `window` (cells), at most `maxNodes` expansions; returns nav points (both ends) or null. */
export function microAStar(g: NavGrid, from: Point, to: Point, k: number, window: CellRect, maxNodes?: number): Point[] | null;
/** Greedy: from i, keep the furthest j with lineOfSight(pts[i], pts[j]); emit pts[j]; repeat. Both ends kept. */
export function pullString(g: NavGrid, pts: readonly Point[], k: number): Point[];
/** The micro window for repairing the hop between two tiles: their cell rect grown by k - 1 on every side. */
export function hopWindow(a: Point, b: Point, k: number): CellRect;
```

### 4.4 Navigator (T6)

```ts
export interface NavPath {
  readonly cls: NavClass;
  readonly from: Point;         // nav px
  readonly to: Point;
  /** Macro tiles (both ends, 8-adjacent, no corner cuts). */
  readonly tiles: readonly Point[];
  /** Next straight-segment end in nav px, or null when the path is consumed. Incremental: LOS work happens here. */
  nextSegment(): Point | null;
  readonly done: boolean;
}
export class Navigator {
  constructor(grid: NavGrid);
  readonly grid: NavGrid;
  findPath(from: Point, to: Point, cls: NavClass): NavPath | null;
  /** Grid changed (live furniture edit, map rebuild): drops caches. `dirty` is advisory in M15 (full invalidate). */
  invalidate(dirty?: CellRect): void;
}
```

> **As landed (T6):** `NavPath` also carries `repairs` (macro re-runs) and `pulled` (false after the give-up below: tile
> anchors walked as they are) and a `toPoints()` preview of the segment ends. In-between anchors come from
> `tileAnchorPoint(g, tile, k)`: the tile centre for `k = SUB`, the first fitting cell of the tile for a smaller class (a
> half-blocked tile has no centred block), the top-left anchor for a larger one. A blocked start skips the LOS check of
> its first hop (walked straight, as today) instead of spending repairs on it; when a hop into the goal tile fails the
> previous tile is marked. `PathFinder.navigator()` shares the adapter's `MacroPlanner`.

`findPath` pseudo-code:

```ts
const k = NAV_CLASS_SIZE[cls];
const tFrom = tileOfNavPoint(from), tTo = tileOfNavPoint(to);
if (!inside(tTo)) return null;
if (!fits(g, ...anchorOfPoint(to, k))) return null;                 // blocked target: same as today's null
const override = new Set<number>();
let tiles: Point[] | null = null;
for (let repair = 0; repair <= 3; repair++) {
  tiles = macro.search(tFrom, tTo, cls, { allowBlockedStart: true, blockedOverride: override });
  if (!tiles) return null;
  // anchors: real endpoints, tile centres (per class) in between
  const anchors = [from, ...tiles.slice(1, -1).map((t) => navPointOfTile(t, k)), to];
  let ok = true;
  for (let i = 0; i + 1 < anchors.length && ok; i++) {
    if (lineOfSight(g, anchors[i], anchors[i + 1], k)) continue;
    const micro = microAStar(g, anchors[i], anchors[i + 1], k, hopWindow(tiles[i], tiles[i + 1], k));
    if (micro) { anchors.splice(i, 2, ...micro); i += micro.length - 2; continue; }   // spliced points are LOS-adjacent by construction
    override.add(tileIndex(g, tiles[i + 1].x, tiles[i + 1].y));                        // mark and re-run macro
    ok = false;
  }
  if (ok) return new LazyNavPath(cls, from, to, tiles, anchors, g, k);                // nextSegment = pullString step by step
}
return new LazyNavPath(cls, from, to, tiles!, anchorsOfTiles(tiles!, from, to, k), g, k, /* noPull */ true);  // gave up: tile centres as today
```

For `person`, every macro tile is standable and consecutive tiles never cut corners, so a 2 x 2 block sliding from
centre to centre only crosses free cells: LOS always holds, no repair ever runs, and the result is today's tile path
shortened by string pulling. Repairs exist for `small` (half gaps) and `large`.

`LazyNavPath.nextSegment()`: from the cursor anchor, advance `j` while `lineOfSight(anchor[cursor], anchor[j+1], k)`;
return `anchor[j]` and move the cursor there. `done` once the cursor is the last anchor. With `noPull` it returns
the next anchor as is.

### 4.5 Adapter: `PathFinder` keeps every semantic (T4)

```ts
// nav/adapter.ts; `game/pathfinding.ts` becomes `export { PathFinder, collapseToTiles } from './nav/adapter';`
export class PathFinder {
  readonly nav: NavGrid;
  /** A NavGrid, or a legacy `number[][]` (wrapped with navGridFromWalkable: tests and the demo keep working). */
  constructor(source: NavGrid | number[][]);
  isWalkable(p: Point): boolean;                 // isTileStandable
  /** Tile path, see the semantics list. */
  find(from: Point, to: Point): Point[] | null;
  /** The shared Navigator over the same grid (W3 px walks). */
  navigator(): Navigator;
}
/** Tiles under a sequence of nav points, consecutive duplicates removed (legacy consumers of px paths). */
export function collapseToTiles(points: readonly Point[]): Point[];
```

`find` semantics (all 12 callers, `slice(0, -1)` and `length > 1` users unchanged):
1. `null` when `from` or `to` is outside the grid, or `to` is not standable;
2. `[from]` when `from` equals `to` (even if blocked);
3. a blocked `from` is allowed (`allowBlockedStart`): the first point may be unwalkable, every later point is standable;
4. both ends included, no consecutive duplicates, consecutive points 8-adjacent, never a corner cut;
5. the path is `macro.search(from, to, 'person')` (no string pulling: callers expect tiles);
6. deterministic; `isWalkable(p) === (walkable[p.y][p.x] === 0)` for a map-built grid.

### 4.6 Character (T6)

```ts
export type Facing = 'n' | 'e' | 's' | 'w';
class Character {
  /** Routing class; `setCreature` sets it via navClassFor (humans: 'person'). */
  navClass: NavClass = 'person';
  /** M17 hook: direction of the current segment; today only `upper.scaleX` flips. */
  facing: Facing = 's';
  get navPoint(): Point;                                 // { x: this.x, y: this.y - FEET_DY }
  /** Unchanged signature. Implemented as walkPoints(path.slice(1).map((t) => navPointOfTile(t))). Byte-identical px today. */
  walk(path: Point[], seated: boolean, onArrive?: () => void): void;
  /** Nav points (excluding the current position); feet px = point + FEET_DY on y. */
  walkPoints(points: readonly Point[], seated: boolean, onArrive?: () => void): void;
  /** Pulls `path.nextSegment()` whenever the internal px queue runs empty; `onArrive` once `path.done`. */
  walkNav(path: NavPath, seated: boolean, onArrive?: () => void): void;
  get walking(): boolean;                                // px queue non-empty or an unfinished NavPath
}
```

`update()` is otherwise unchanged (same speed integration over the px queue). A later `walk`/`walkPoints`/`teleport`
drops any pending `NavPath`, exactly as it replaces `path` today (`Character.ts:934-940`).

### 4.7 Migration order

- **W1** grid parity: `generate.ts` emits `nav`, `walkable` derived; property suite (§5) green; nothing moves yet.
- **W2** adapter: `PathFinder` = `nav/adapter.ts`; `easystarjs` stays a devDependency for the parity test
  (300 seeds: same reachability, same octile cost); `seats.test.ts` green unchanged.
- **W3** Navigator: `OfficeScene.walk` uses `navigator.findPath(c.navPoint, navPointOfTile(to, k), c.navClass)` →
  `c.walkNav`, teleport fallback as today; `npcDirector.spawnNpc` sets `navClass` from the skin's creature;
  `npc/reactions.ts` and `npc/script.ts` walks migrate to `walkNav` (life/drama may stay on `find` + `walk`; both
  work). Then remove `easystarjs` and its parity test (Dijkstra optimality on random grids stays).

---

## 5. Perf budgets and test plan (vitest, pure first)

Budgets (`nav/__tests__/nav.perf.test.ts`, `pnpm test:perf`; 128 x 96 `maxRoomsLayout()` from
`game/__tests__/perfLayout.ts`, see dual-grid.md §4.6; medians over 9 samples after a warm-up, generous ceilings
like `generate.perf.test.ts`): `buildNavGrid` + `computeClearance` ≤ 8 ms; `updateClearance` on a 4 x 4 cell dirty
rect ≤ 0.1 ms; macro `person` p50 ≤ 1 ms over 500 random reachable pairs; `findPath('person')` p50 ≤ 2 ms;
`findPath('small')` p50 ≤ 4 ms; `generate.perf.test.ts` budget unchanged.

Property suites (300 seeds: `generateRandomLayout` on both backgrounds, plus `DEFAULT_LAYOUT`, `maxRoomsLayout`,
and the Multiverse plan from `generate.perf.test.ts`):
1. `isTileStandable(map.nav, x, y) === (map.walkable[y][x] === 0)` for every tile (T1/T2).
2. Integer layouts byte-identical: T2 captures `JSON.stringify({ furniture, rooms: rooms.map(r => r.seats) })` of
   `DEFAULT_LAYOUT` and three BSP seeds on `main` into `procgen/__tests__/fixtures/m15-parity.json` before its change
   and asserts equality after; `furnish.test.ts`, `backWall.test.ts`, `pins.test.ts`, `triggers.test.ts` unchanged.
3. Half-tile pins block exactly `coveredTiles(pin)`: `walkable` with the pin minus without = those tiles (T2).
4. `updateClearance(dirty)` equals `computeClearance` after random `setCell` edits, 200 cases (T1).
5. Every seat reachable with `walkable` is reachable via `findPath(spawnNav, seatNav, 'person')`, and the resulting
   tiles (`path.tiles`) are all standable (T6).
6. Every segment of every `NavPath`, sampled every 2 px, `fits(anchorOfPoint(sample, k), k)` (T6).
7. Adapter paths cross only standable tiles (except a blocked start); null/`[from]` cases (T4).
8. Easystar parity: same reachability and equal octile cost for 20 random pairs per seed (T4; removed in W3).
9. Macro optimality: on 100 random 32 x 32 grids, `search` cost equals a reference Dijkstra (T4).
10. Small-creature gap: a fixture with a 1-cell gap between two blocking pins (`x = 2`, `x = 3.5`) is impassable for
    `person` (null) and passable for `small` (T6).
11. Determinism: two `findPath` calls with equal inputs give equal segments; no `Math.random` in `nav/` (source test).

PM smoke (`?demo=1`, modern, guild, Multiverse): characters walk smooth diagonals through doors without clipping
walls; a meeting convenes and disperses; an NPC chase; the cat routes through a half gap in the editor's preview
layout; the editor drags a desk to `2.5` and nudges with Alt+arrow; `office.dualGrid` off shows the old look.

---

## 6. Tasks

Paths under `apps/web/src/` unless they start with `packages/`. File-disjoint within a wave and disjoint from the
dual-grid D-tasks (`themes/**` belongs to D0-D5). Every developer runs ROOT `pnpm typecheck` and the web tests
before hand-off. `renderTheme.ts` is D4's (W3); no navigation task touches it. The optional W4 painter audit edits
`themes/paint/furniture.ts` and `riftFurniture.ts`, and must not share a wave with D4 if it also needs
`renderTheme.ts`.

### Wave 0 (contract; architect docs in parallel)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| W0 | developer (contract) | `packages/shared/src/layout.ts` + `__tests__/layout.test.ts` (landed), `game/nav/constants.ts`, `game/nav/classes.ts`, `game/nav/shapes.ts` (types + `KIND_SHAPE` ≡ `KIND_BLOCKING`), `game/nav/grid.ts` (types + signatures, stub bodies), `game/nav/index.ts`, `game/procgen/types.ts` (`nav?`) | none | §1.1, §1.3, §2.1-2.5 verbatim; `coveredTileRect/coveredTiles` tested (integer identity, half offsets, empty); ROOT typecheck + tests green; PM commits before W1. |

### Wave 1 (parallel)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| T1 | developer (nav) | `game/nav/grid.ts` (bodies), `game/nav/shapes.ts` (bodies), `game/nav/__tests__/{grid,shapes,clearance}.test.ts`, `game/nav/__tests__/nav.perf.test.ts` (grid part) | W0 | §2.2-2.3 implemented; `bitOf`/`cellRectOf`/anchor round-trips tested (`pointOfAnchor(anchorOfPoint(p,k),k)` for aligned p; k=2 tile centre ≡ feet - 6); `isWalkableWorld` early-outs; clearance exactness (brute-force k x k check on random grids) and property 4; `navGridFromWalkable` ≡ `buildNavGrid` on `DEFAULT_LAYOUT`; perf grid budgets. |
| T2 | developer (procgen) | `game/procgen/geometry.ts` (new), `game/procgen/generate.ts` (rasterizer swap only; the nav wiring is the PM's), `game/procgen/pins.ts`, `game/procgen/triggers.ts`, `game/procgen/recipes.ts` (`seatsFor`), `game/procgen/backWall.ts`, `game/npc/receptionistSpot.ts`, `game/dramaSpots.ts`, `game/life/spots.ts`, `game/procgen/__tests__/{geometry,pins}.test.ts`, `procgen/__tests__/fixtures/m15-parity.json`, existing spot tests as needed | W0 | §3.1 table applied; properties 2 and 3; `resolvePins` rules 1-6 tested (half pins placed, overlap exact, apron conservative, misaligned skipped); `seatsFor` on `x = 2.5` desk seats the outward row of the covered rect; spots ring the covered rect; all existing procgen tests green unmodified; `generate.perf.test.ts` green. |
| T3 | developer (editor) | `features/editor/PlanCanvas.tsx`, `features/editor/pins.ts` + test, `features/editor/Inspector.tsx`, `features/editor/shortcuts.ts` + test, `features/editor/OfficeEditor.tsx` (key handler half-step only), `stores/editorStore.ts` + test | W0 | §3.2: drag snaps to halves, rooms whole; `clampPinPos` snaps and clamps (tests incl. `inner.w - pin.w`); hit-test at a fractional point; Alt+arrow 0.5 / Shift x5 for pins, rooms unchanged; Inspector shows `2.5`; a draft never fails `validateLayout` because of a half pin; undo/redo tests. |
| W1-W | PM | `game/procgen/generate.ts` (nav wiring lines), `game/scenes/OfficeScene.ts` (`buildWorld`: `this.finder = new PathFinder(this.map.nav ?? buildNavGrid(this.map))`, only if T1 landed; else unchanged) | T1, T2 | property 1 on 300 seeds; ROOT typecheck/test/build; quick gate (QA + review). |

### Wave 2 (parallel with D1-D3)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| T4 | developer (nav) | `game/nav/heap.ts`, `game/nav/macro.ts`, `game/nav/adapter.ts`, `game/pathfinding.ts` (re-export only), `game/nav/__tests__/{heap,macro,adapter,easystarParity}.test.ts`, `nav.perf.test.ts` (macro part) | W1 | §4.1-4.2, §4.5; heap order incl. ties; properties 7-9; `seats.test.ts` green unchanged; macro p50 ≤ 1 ms. |
| W2-W | PM | `game/scenes/OfficeScene.ts` (`buildWorld`: `new PathFinder(this.map.nav!)`), `apps/web/package.json` (easystarjs → devDependencies) | T4 | demo walk in all styles, every script still walks. |

### Wave 3 (parallel with D4/D5)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| T6 | developer (nav + actors) | `game/nav/micro.ts`, `game/nav/navigator.ts`, `game/actors/Character.ts` (§4.6 only), `game/nav/__tests__/{micro,navigator}.test.ts`, `game/actors/__tests__/characterNav.test.ts` (fake scene), `nav.perf.test.ts` (findPath part) | T4 | §4.3-4.4, §4.6; properties 5, 6, 10, 11; `walk(path)` px queue identical to today (test on a tile path); `walkNav` pulls segments lazily and calls `onArrive` once; `walking` getter; `navClass` set by `setCreature`; findPath budgets. |
| W3-W | PM | `game/scenes/OfficeScene.ts` (`walk` → Navigator, `spawnNpc` navClass), `game/npc/reactions.ts`, `game/npc/script.ts` (walkNav), `apps/web/package.json` + lockfile (remove easystarjs), `game/nav/__tests__/easystarParity.test.ts` (delete) | T6, D4 | §4.7 W3; smoke of §5; ROOT typecheck/test/build and `test:perf` green. |

### Wave 4 (optional, same milestone if time; each item gated on the W3 property suite)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| T7 | developer | `game/nav/shapes.ts` (`desk {inset: {s: 1}}`, `plant` pot, round tables as masks), tests | W3-W | properties 1 (now `walkable` stays conservative while cells open up), 5, 6, 10; cats pass under desks in the demo. |
| T8 | developer (procgen) | `game/procgen/recipes.ts` (half-gap pitches), `furnish.test.ts` baselines | W3-W | every previously reachable seat still reachable (property 5); density +20% in `desks` rooms. |
| T9 | developer (themes) | `themes/paint/furniture.ts`, `themes/paint/riftFurniture.ts`, painters tests | W3-W, not with D4 | painters clip to fractional footprints; `w/h` schema widening deferred to a later milestone. |

PM wiring lines (the only edits to hot files):
- `generate.ts` (W1-W), after `assignTriggers` and in place of the `:828-832` loop:
  `const nav = buildNavGrid({ cols, rows, tiles, furniture }, walkable); const derived = walkableFromNav(nav);` then
  use `derived` as `walkable` for steps 10-11 and emit `nav` on the map.
- `OfficeScene.buildWorld` (W2-W): `this.finder = new PathFinder(this.map.nav ?? buildNavGrid(this.map));`.
- `OfficeScene.walk` (W3-W):
  ```ts
  private walk(c: Character, to: Point, seated: boolean) {
    const k = NAV_CLASS_SIZE[c.navClass];
    const path = this.finder.navigator().findPath(c.navPoint, navPointOfTile(to, k), c.navClass);
    if (path) c.walkNav(path, seated);
    else { c.teleport(to); c.setSeated(seated); }
  }
  ```
- `OfficeScene.spawnNpc` (W3-W): unchanged signature; `npcDirector.spawn` sets `char.navClass = navClassFor(skin.creature ?? null)` right after `setCreature` (one line in `npcDirector.ts`, PM).

---

## 7. Risks and trade-offs

- **Seats in soft rects.** A sofa (non-blocking) at `y = 2.5` covers two tile rows; `seatsFor` "sit on itself" now
  yields the covered tiles, so a seat may sit on a tile the sofa only half covers. Cosmetic; seats stay standable.
- **Multiverse gates.** `realmGate` and the Nexus plaza are tile points; the Navigator maps them through
  `navPointOfTile`. Unchanged semantics, but the gate tile must stay standable (property 1 covers it).
- **Receptionist spot.** `pickReceptionistSpot` deliberately picks a *blocked* desk tile and teleports there; it never
  walks, so the nav grid never routes to it. With a half-offset reception desk pin, covered tiles are blocked and the
  rule still holds.
- **Stall detection.** Arrival checks compare `c.tile` with the seat; a person's final segment ends on the seat's
  centre nav point, so `tile` is exact. `small` creatures end at a `k = 1` anchor point inside the tile (its top-left
  cell centre), still inside the tile.
- **`noUncheckedIndexedAccess`.** Typed-array reads are `number | undefined`; the hot paths use `!` after an explicit
  bounds check (documented at each site), never `?? 0` silently.
- **Determinism and caches.** Passability caches must be invalidated on every `setCell`/`applyFurniture`; in M15 the
  only live change is a map rebuild (new `PathFinder`), so `invalidate` is simple. Live editing (W4+) must call
  `applyFurniture` + `updateClearance` + `navigator.invalidate(dirty)` together.
- **Painter overdraw for fractional sizes.** Sizes stay whole, so `f.x * T` is an integer px and every painter loop
  (`for i < f.w`) stays in bounds. Widening `w/h` without the painter audit (T9) would overdraw past the footprint.
- **Schema superset.** Widening `x/y` from `.int()` to `.multipleOf(0.5)` is the only new input surface; bounds are
  unchanged and `validateLayout` still warns rather than errors on bad pins, so a stale layout never falls back to
  `DEFAULT_LAYOUT`.
