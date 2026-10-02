# Dual grid, part A: offset rendering of walls and floors (M15 → v0.9.0)

Status: approved for implementation · Plan: `~/.claude-sessions/profiles/edgar/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md`
section "Part A" · ADR #29. Sibling doc: `docs/design/navigation.md` (parts B and C: half-tile placement, nav grid).
Scope: web only (`apps/web/src/game/themes/`), one setting in `packages/shared` (`office.dualGrid`, already landed).

Read first: `docs/design/back-wall.md` §1 (face tiles, depth invariant, `capPx`/`bandPx`) and §3.2 (pass order),
`docs/design/guild-hall.md` D2 (geometry never depends on style), `docs/decisions.md` #22 (all art code-drawn).

---

## 0. Goals, non-goals, invariants

**Goal.** Walls and floors get real edges: outlines on wall caps, rounded outer and inner corners, a shadow where
floor meets a wall, a cliff where floor or wall meets void. Today every tile is painted from `(px, py)` alone with
no edge or corner awareness (`renderTheme.ts:79-92`, `paint/floors.ts`, `paint/walls.ts`).

**How.** A second grid of `(cols+1) x (rows+1)` *dual cells*, each centred on a tile corner. A dual cell sees four
quarter-tiles (one from each tile around the corner) and paints only what per-tile paint cannot: the boundary lines
and corner cuts between them. The 16 possible combinations of "set / not set" quadrants are the classic
dual-grid (Stålberg) lookup.

**Non-goals (M15).** New floor or wall art, new palettes, tile-size changes, a Tiled-style sprite lookup. Furniture
and decor painters are untouched. Lighting is M16, sprites/2.5D are M17.

**Invariants (every task keeps these).**
1. **Additive overlay.** Pass 1 (per-tile fills, parity patterns anchored at tile coordinates) stays and is the
   base. The dual pass (2b) only adds pixels along boundaries. A uniform cell (all four quadrants the same kind)
   paints nothing, so the cost is proportional to the boundary length, not the map area.
2. **D2.** The dual-cell model reads geometry only (`tiles`, `roomAt`, room types). A theme paints; it never
   changes a cell. Masks are identical for every style.
3. **Depth invariant** (back-wall.md §1). All dual art is flat and stays inside its own cell
   (`[px, px+T) x [py, py+T)` with `px = cellOrigin(cx)`). Nothing is drawn taller than its footprint.
4. **Face-quadrant rule.** A *face quadrant* is a wall quadrant whose south neighbour inside the same cell is floor
   or door (`tl` over `bl`, `tr` over `br`). Those pixels belong to the back-wall face (pass 3) and the dual
   painters never touch them; when the theme has a tall face (`facePass`), the top `bandPx` pixels of the floor
   quadrant below a face quadrant are off-limits too (the band and baseboard live there).
5. **Flag off = byte-identical.** `renderGeneratedMap` without `{ dualGrid: true }` produces today's exact
   `Graphics` command stream. `office.dualGrid` defaults to `true`, the renderer option defaults to `false`, so every
   existing caller and test is unchanged until it opts in.
6. **Own PRNG.** The dual pass uses `mulberry32(map.seed ^ 0x5d1a7c3b)`. Pass 1 keeps its stream: when the dual
   pass is on, `paintWallBase` replaces `paintWall` for wall tiles and MUST consume exactly the same `rand()` draws,
   so floor and wall noise is identical with the flag on and off (only edges differ).
7. **Never `tileOf` on offset pixels.** `paint/util.ts` `tileOf(px, py)` rounds `px / T`; a dual cell origin is
   `cx*T - T/2`, which rounds unpredictably. Dual painters use `quadrantTile(cx, cy, q)` and the cell's own masks. A
   source-string test guards it (§4.5).
8. **Door quadrants stay square.** `doorMask` quadrants receive no dual pixels at all: `paintDoor` (pass 5)
   repaints the whole door tile, so anything drawn there is wasted, and a rounded door jamb would fight the
   threshold art.

---

## 1. The dual-cell model (D0, pure TS, no Phaser)

### 1.1 Geometry

Tile `(x, y)` is split into four quarter-tiles of `T/2 = 8 px`. Dual cell `(cx, cy)`, `0 <= cx <= cols`,
`0 <= cy <= rows`, is centred on the corner shared by tiles `(cx-1, cy-1)`, `(cx, cy-1)`, `(cx-1, cy)`, `(cx, cy)`:

```
          tile (cx-1, cy-1) | tile (cx, cy-1)
                     ... tl | tr ...
    cell (cx, cy):  --------+--------      origin px = cx*T - T/2, py = cy*T - T/2
                     ... bl | br ...
          tile (cx-1, cy)   | tile (cx, cy)
```

`tl` is the bottom-right quarter of tile `(cx-1, cy-1)`; `tr` the bottom-left quarter of `(cx, cy-1)`; `bl` the
top-right quarter of `(cx-1, cy)`; `br` the top-left quarter of `(cx, cy)`. Off-map tiles are `void`, so the border
cells (`cx` in `{0, cols}`, `cy` in `{0, rows}`) describe the outer ring against nothing; their off-map pixels are
clipped by the texture bounds and are still "inside the cell" for the bounds tests.


> **Reconciliation with the landed W0 contract (commit d14195b):** the types live in `themes/dual/dualGrid.ts`, not a
> separate `types.ts`. Names as landed: `CornerKind` (= `QuadKind` below), `FloorKind`, `Quadrant`, `QUADRANTS`, `BIT`,
> `DualCell`; `FULL` is not exported (use `0xf`); `Side`/`HALF_EDGE_QUADRANTS` go in `dualGeom.ts` (D0). The import in
> §2.1 is `import type { DualCell } from './dual/dualGrid'` (already landed). D0 extends `dualGrid.ts` in place and
> replaces its three stubs (`makeKindAt`, `buildDualCells`, `isUniform`). `RenderOptions.dualGrid` defaults to **true**
> (plan decision; the setting default is true and off stays byte-identical).
> Signature drift to ignore in §1.3/§2.3: landed are `quadrantTile(cell, q)`, `cellOrigin(cell, T): {px, py}`, `cornerKinds(...)`
> (see `dualGrid.ts`); D4 must write `const { px, py } = cellOrigin(cell, T)`, not `cellOrigin(cell.cx, T)`.

### 1.2 `themes/dual/types.ts` (W0, type-only, verbatim)

```ts
import type { RoomType } from '@tagconn/shared';

/** What a quarter-tile is for the dual grid. A `door` tile counts as floor (see `DualCell.doorMask`). */
export type QuadKind = 'void' | 'wall' | 'floor';
export type Quadrant = 'tl' | 'tr' | 'bl' | 'br';
export const QUADRANTS: readonly Quadrant[] = ['tl', 'tr', 'bl', 'br'];
/** Mask bit per quadrant: `mask = tl<<3 | tr<<2 | bl<<1 | br`. */
export const BIT: Record<Quadrant, number> = { tl: 8, tr: 4, bl: 2, br: 1 };
export const FULL = 0xf;

export interface DualCell {
  /** Dual coordinates: 0..cols, 0..rows (one more than the tile grid in each axis). */
  cx: number;
  cy: number;
  kinds: Record<Quadrant, QuadKind>;
  /** Exactly one of wall/floor/void has each bit; `wallMask | floorMask | voidMask === FULL`. */
  wallMask: number;
  /** Floor OR door quadrants. */
  floorMask: number;
  voidMask: number;
  /** Door quadrants (a subset of `floorMask`): never painted by the dual pass. */
  doorMask: number;
  /** Palette key of floor/door quadrants (`renderTheme.kindAt` rule), null for wall/void. */
  floorKinds: Record<Quadrant, RoomType | 'corridor' | null>;
  /** `map.roomAt` of the quadrant's tile, null for hall/corridor/off-map. */
  roomIds: Record<Quadrant, string | null>;
}

export type Side = 'n' | 'e' | 's' | 'w';
/** The two quadrants a centre-cross half-edge separates (first = the one on the n/w side). */
export const HALF_EDGE_QUADRANTS: Record<Side, readonly [Quadrant, Quadrant]> = {
  n: ['tl', 'tr'],
  e: ['tr', 'br'],
  s: ['bl', 'br'],
  w: ['tl', 'bl'],
};
```

### 1.3 `themes/dual/dualGrid.ts` (D0, signatures verbatim)

```ts
import type { RoomType } from '@tagconn/shared';
import type { GeneratedMap, Point, Rect } from '../../procgen/types';
import { BIT, FULL, QUADRANTS, type DualCell, type QuadKind, type Quadrant } from './types';

export type KindAt = (x: number, y: number) => QuadKind;
export type FloorKindAt = (x: number, y: number) => RoomType | 'corridor';

/** `tiles[y][x]` → kind; off-map and `void` → 'void'; `door` → 'floor'. */
export function makeKindAt(map: Pick<GeneratedMap, 'cols' | 'rows' | 'tiles'>): KindAt;
/** Same rule as `renderTheme.ts` `kindAt`: room type by `roomAt`, else 'corridor' when the layout has void, else 'hall'. */
export function makeFloorKindAt(map: Pick<GeneratedMap, 'tiles' | 'rooms' | 'roomAt'>): FloorKindAt;
/** The tile a quadrant of cell (cx, cy) lies in: tl=(cx-1,cy-1) tr=(cx,cy-1) bl=(cx-1,cy) br=(cx,cy). May be off-map. */
export function quadrantTile(cx: number, cy: number, q: Quadrant): Point;
/** Top-left px of dual index `c` (same for x and y): `c * T - T / 2`. */
export function cellOrigin(c: number, T: number): number;
/** Absolute px rect of one quadrant: T/2 x T/2 inside the cell. */
export function quadrantRect(cell: Pick<DualCell, 'cx' | 'cy'>, q: Quadrant, T: number): Rect;
/** The four kinds around corner (cx, cy). */
export function cornerKind(kindAt: KindAt, cx: number, cy: number): Record<Quadrant, QuadKind>;
export function buildDualCell(map: Pick<GeneratedMap, 'tiles' | 'roomAt'>, cx: number, cy: number, kindAt: KindAt, floorKindAt: FloorKindAt): DualCell;
/** Every cell, row-major (cy outer, cx inner): `(cols + 1) * (rows + 1)` entries. */
export function buildDualCells(map: Pick<GeneratedMap, 'cols' | 'rows' | 'tiles' | 'rooms' | 'roomAt'>): DualCell[];
/** All four quadrants the same kind (door counts as floor): the painters draw nothing. */
export function isUniform(cell: Pick<DualCell, 'wallMask' | 'floorMask' | 'voidMask'>): boolean;
/** Bits of the face quadrants: wall `tl` over floor/door `bl` (bit 8), wall `tr` over floor/door `br` (bit 4). */
export function faceMask(cell: Pick<DualCell, 'wallMask' | 'floorMask'>): number;
/** Mask of quadrants whose kind is `kind` (helper for tests and painters). */
export function maskOf(kinds: Record<Quadrant, QuadKind>, kind: QuadKind): number;
```

`buildDualCell` pseudo-code:

```ts
const kinds = cornerKind(kindAt, cx, cy);
let wallMask = 0, floorMask = 0, voidMask = 0, doorMask = 0;
for (const q of QUADRANTS) {
  const t = quadrantTile(cx, cy, q);
  const raw = map.tiles[t.y]?.[t.x];           // undefined off-map
  if (kinds[q] === 'wall') wallMask |= BIT[q];
  else if (kinds[q] === 'floor') { floorMask |= BIT[q]; if (raw === 'door') doorMask |= BIT[q]; }
  else voidMask |= BIT[q];
  floorKinds[q] = kinds[q] === 'floor' ? floorKindAt(t.x, t.y) : null;
  roomIds[q] = map.roomAt[t.y]?.[t.x] ?? null;
}
```

### 1.4 `themes/dual/dualGeom.ts` (D0, signatures verbatim)

```ts
import type { Rect } from '../../procgen/types';
import type { DualCell, Quadrant, Side } from './types';

export type Shape =
  | { kind: 'none' }                              // 0 or 15
  | { kind: 'edge'; side: Side }                  // two adjacent quadrants set; `side` = where the SET half lies
  | { kind: 'convex'; q: Quadrant }               // one quadrant set: an outer corner of the set region at the centre
  | { kind: 'concave'; notch: Quadrant }          // three set: an inner corner; `notch` is the unset quadrant
  | { kind: 'diagonal'; pair: 'tl-br' | 'tr-bl' }; // two opposite quadrants set

/** The 16-case lookup (mask bits tl=8 tr=4 bl=2 br=1). */
export function shapeOf(mask: number): Shape;
/** Half-edges of the centre cross that separate a set quadrant from an unset one (HALF_EDGE_QUADRANTS). */
export function boundaryHalfEdges(mask: number): Side[];
/** A strip `t` px thick along half-edge `side`, lying inside quadrant `towards` (one of HALF_EDGE_QUADRANTS[side]). */
export function halfEdgeStrip(px: number, py: number, T: number, side: Side, towards: Quadrant, t: number): Rect;
/** Corner pixels to recolour for a convex corner in quadrant `q`, measured from the cell centre into `q`:
 *  r=1 → [(0,0)]; r=2 → [(0,0),(1,0),(0,1)] as absolute 1x1 px rects (the (0,0)+(1,0) pair may be merged to 2x1). */
export function cornerCut(cell: Pick<DualCell, 'cx' | 'cy'>, q: Quadrant, r: 1 | 2, T: number): Rect[];
```

`shapeOf` table (the only source of truth; the test enumerates it):

| mask | bits set | shape |
|---|---|---|
| 0 | none | `none` |
| 15 | all | `none` |
| 12 | tl tr | `edge n` |
| 3 | bl br | `edge s` |
| 10 | tl bl | `edge w` |
| 5 | tr br | `edge e` |
| 8 / 4 / 2 / 1 | tl / tr / bl / br | `convex tl` / `tr` / `bl` / `br` |
| 7 / 11 / 13 / 14 | all but tl / tr / bl / br | `concave notch tl` / `tr` / `bl` / `br` |
| 9 | tl br | `diagonal tl-br` |
| 6 | tr bl | `diagonal tr-bl` |

`halfEdgeStrip` geometry (centre `c = (px + T/2, py + T/2)`): `n` runs from `c` up to `(c.x, py)` and separates
`tl` (left) from `tr` (right); `e` runs right and separates `tr` (above) from `br` (below); `s` runs down and
separates `bl` (left) from `br` (right); `w` runs left and separates `tl` (above) from `bl` (below). A strip
"towards `tl`" on `n` is `{ x: c.x - t, y: py, w: t, h: T/2 }`; towards `tr` is `{ x: c.x, ... }`; the e/s/w cases
follow by symmetry. Painters call it per boundary half-edge with `towards` = the wall quadrant (cap outline) or the
floor quadrant (shadow) or the void quadrant (cliff).

---

## 2. Theme hooks, `DualCtx`, and the render pass

### 2.1 `themes/types.ts` additions (W0, verbatim; all optional so rift/tests compile until painted)

```ts
import type { DualCell } from './dual/types';

/** M15 dual grid (docs/design/dual-grid.md §2). */
export interface DualCtx {
  cell: DualCell;
  /** Cell origin px: `cellOrigin(cx, T)`, `cellOrigin(cy, T)`. */
  px: number;
  py: number;
  T: number;
  /** `theme.backWall ?? { capPx: 0, bandPx: 0 }`. */
  capPx: number;
  bandPx: number;
  /** True when the theme paints a tall back-wall face (`paintBackWall`), so the band under a face quadrant is off-limits. */
  facePass: boolean;
}
// in ThemeDefinition:
  /** M15: the wall top WITHOUT the per-tile edge line (the dual pass draws real outlines). Replaces `paintWall`
   *  in pass 1 when the dual pass runs. MUST consume exactly the `rand()` draws `paintWall(g, px, py, false, rand)` would. */
  paintWallBase?(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void;
  /** M15: floor-side edge art for one dual cell (shadows under walls, cliffs, inner corners). Nothing on uniform cells. */
  paintDualFloor?(g: Phaser.GameObjects.Graphics, ctx: DualCtx, rand: () => number): void;
  /** M15: wall-side edge art for one dual cell (cap outline, rounded corners). Never a face quadrant. */
  paintDualWall?(g: Phaser.GameObjects.Graphics, ctx: DualCtx, rand: () => number): void;
```

### 2.2 No-double-paint rules per pass

| pass | what | PRNG | paints | must not paint |
|---|---|---|---|---|
| 1 tiles | `paintFloor` / `paintVoid`; walls: `paintWallBase` when `dual && theme.paintWallBase && (theme.paintBackWall \|\| !faceVisible)`, else `paintWall` as today | `rand` (main) | the whole tile | (base: the per-tile 1 px edge line, which the dual pass replaces) |
| 2 island edges | `paintIslandEdge` (rift, Multiverse only) | `rand` | void tiles below regions (refills the tile) | |
| **2b dual** | `paintDualFloor` then `paintDualWall` for every cell | `dualRand` | inside the cell only; edges, corner cuts, shadows, cliffs | face quadrants; band pixels under them when `facePass`; door quadrants; anything on a uniform cell |
| 3 back wall | `paintBackWall` | `backWallRand` | face tiles `capPx..T` + band | unchanged |
| 4 wall decor | `paintWallDecor` | none | the face | unchanged |
| 5 doors | `paintDoor` | `rand` | whole door tile | unchanged |
| 6 furniture | `paintFurniture` | none | footprints (+ overdraw rules) | unchanged |

Island edges come before the dual pass because `paintRiftIslandEdge` calls `paintRiftVoid` first (it refills the
tile); dual rims drawn earlier would be erased. The existing pass-order test (tiles → back wall → wall decor → doors
→ furniture) stays valid: the dual pass sits between tiles and back wall.

`dualThemeAt(cell)`: the theme of the first non-void quadrant in the order `br, bl, tr, tl` (`themeAt(quadrantTile)`),
falling back to the base theme when all four are void. On the Multiverse a realm's rect contains its walls, so a
realm/void cell is painted by the realm's theme and a realm/rift-corridor cell by whichever quadrant comes first in
that order (deterministic; the seam is one pixel line either way).

### 2.3 `renderTheme.ts` (D4): `RenderOptions` and the loop

```ts
export interface RenderOptions {
  /** M15: run the dual pass (2b). Defaults to false so every existing caller renders byte-identically. */
  dualGrid?: boolean;
}
export function renderGeneratedMap(scene: Phaser.Scene, map: GeneratedMap, theme: ThemeDefinition, regions: ThemeRegion[] = [], opts: RenderOptions = {}): string;
```

```ts
const dual = opts.dualGrid === true;
// pass 1 (only the wall branch changes)
else if (tile === 'wall') {
  const faceVisible = isFaceTile(x, y);
  const wallTheme = themeAt(x, y);
  const useBase = dual && !!wallTheme.paintWallBase && (!!wallTheme.paintBackWall || !faceVisible);
  if (useBase) wallTheme.paintWallBase!(g, px, py, rand);
  else wallTheme.paintWall(g, px, py, wallTheme.paintBackWall ? false : faceVisible, rand);
}
// pass 2 island edges: unchanged
// pass 2b
if (dual) {
  const dualRand = mulberry32(map.seed ^ 0x5d1a7c3b);
  const cells = buildDualCells(map);                       // (cols+1)(rows+1), row-major
  for (const cell of cells) {
    const t = dualThemeAt(cell);
    if (!t.paintDualFloor && !t.paintDualWall) continue;   // a theme without hooks adds nothing
    const { capPx, bandPx } = t.backWall ?? { capPx: 0, bandPx: 0 };
    const ctx: DualCtx = { cell, px: cellOrigin(cell.cx, T), py: cellOrigin(cell.cy, T), T, capPx, bandPx, facePass: !!t.paintBackWall };
    t.paintDualFloor?.(g, ctx, dualRand);
    t.paintDualWall?.(g, ctx, dualRand);
  }
}
// passes 3-6 unchanged
```

The renderer calls both hooks for every cell, including uniform ones (the hook-count test relies on it); the
painters return before any draw on `isUniform(cell)`. `buildDualCells` allocates about 12.5k small objects at
128 x 96 for one bake; it is transient and well inside the perf budget (§4.6). If profiling disagrees, D4 may switch
to `buildDualCell` per index with one reused object, keeping the call count.

### 2.4 Setting and scene wiring

- `office.dualGrid: z.boolean().default(true)` with a `KEY_HINTS` entry (landed in W0; not restart-required, not
  GUI-immutable).
- `OfficeScene` (PM, W3): `renderVisuals()` passes `{ dualGrid: this.state?.settings.office.dualGrid ?? true }`
  and records it in a new `private appliedDualGrid = true`; in `setOfficeState` the reskin test becomes
  `const reskin = !rebuild && (effectiveStyle !== this.appliedStyle || (office.dualGrid ?? true) !== this.appliedDualGrid)`
  so toggling the setting repaints through `applySkin` (same geometry, no reseat).
- `PreviewScene` (D5): the editor passes `dualGrid` in the scene data (`OfficeEditor.tsx` reads
  `settings?.office.dualGrid ?? true` from `officeStore`); `build()` calls
  `renderGeneratedMap(this, this.map, this.theme, [], { dualGrid: this.dualGrid })`.
- `docs/guide/display.md` gets one paragraph (Gate, tech-writer): what the toggle does, off = flat tiles.

---

## 3. Look per style

Colours are **module constants of each dual painter** (`paint/dual/<style>Dual.ts`); `Palette` does not change.
Existing floor base colours needed for corner cuts come from `theme.palette.floorBase[kind]` / `palette.void`,
which already exist. Every number below is a starting value; the developer tunes within the bounds tests.

| | modern (`modernDual.ts`) | guild (`guildDual.ts`) | rift (`riftDual.ts`) |
|---|---|---|---|
| cap outline (wall side of every wall/non-wall boundary half-edge, skip face quadrants) | 1 px `CAP_OUTLINE = 0x6b6454` | 1 px, lit on the wall's north and west edges (`lighten(0x5a5068, 0.3)`), dark on south and east (`darken(0x5a5068, 0.35)`) | 1 px lit obsidian rim `lighten(0x161022, 0.35)` |
| convex wall corner | r = 2 `cornerCut`, cut pixels take the outside colour (floor base of the diagonal quadrant, else void) and the outline corner steps in by one | r = 1 chamfer (one pixel) | r = 2 like modern, cut pixels take the outside colour |
| concave (inner) corner | r = 1: the notch pixel takes the wall top colour (`0xe8e2d0`) | none (sharp ashlar) | r = 1 as modern, colour `0x161022` |
| floor shadow (floor side of wall/floor boundaries) | 1 px `0x000000` alpha 0.16 along vertical boundaries (`n`/`s`); 2 px along a wall above the floor only when `!facePass` (the band covers it otherwise) | 1 px `darken(floorBase, 0.2)` on every wall/floor boundary, skipping band pixels | 1 px teal glow `0x1f5a5a` alpha 0.45 on every wall/floor boundary, skipping band pixels |
| cliff (void side of floor-or-wall/void boundaries) | 2 px `CLIFF = 0x1f1b18` where the void is south (`e`/`w` half-edges with void below), 1 px alpha 0.6 elsewhere | mortar ledge: 2 px `darken(0x5a5068, 0.5)` plus a 1 px `lighten(.., 0.1)` top line | crystal rim: 1 px `0x1f5a5a` alpha 0.7 on the void side; coexists with `paintIslandEdge` (the jag starts below the rim) |
| door quadrants (`doorMask`) | untouched | untouched | untouched |
| diagonal masks (6, 9) | outlines on all four half-edges, no corner cuts | same | same |
| `paintWallBase` | `WALL_TOP` fill only (no `WALL_EDGE` line); zero `rand` draws, like `paintModernWall` | coursing rows and joints as `paintGuildWall`, no lit top line; same `rand()` draws (`rand() < 0.2` then two more) | obsidian fill and mortar rows as `paintRiftWall`, no lit top line; same draws (`rand() < 0.2` then two more) |
| `rand` use in dual hooks | none | optional moss speck on a cliff (`rand() < 0.1`, inside the cell) | optional glow flicker pixel (`rand() < 0.1`) |

Rules shared by all three painters:
- Per cell: `if (isUniform(cell)) return;` before any draw.
- Walls: iterate `boundaryHalfEdges(cell.wallMask)`; for each half-edge, `towards` = the wall quadrant; skip when
  `BIT[towards] & faceMask(cell)`. Corners from `shapeOf(cell.wallMask)`.
- Floors: iterate `boundaryHalfEdges(cell.floorMask)`; `towards` = the floor quadrant; skip when
  `BIT[towards] & cell.doorMask`; when `facePass` and the floor quadrant is below a face quadrant, start the strip
  `bandPx` px lower (clip to the quadrant; an empty strip is not drawn).
- Cliffs: boundary half-edges of `cell.voidMask`, `towards` = the void quadrant.
- Every rect goes through `rectFn`, so the bounds tests see it.

---

## 4. Tests

4.1 `themes/dual/__tests__/dualGrid.test.ts` (D0): `BIT`/`FULL`/`HALF_EDGE_QUADRANTS` fixed; `quadrantTile` for all
four quadrants; `cellOrigin(0, 16) === -8`; masks partition `FULL` and `doorMask ⊆ floorMask` on `DEFAULT_LAYOUT`;
off-map quadrants are void on every border cell; `isUniform` on all-wall, all-floor, floor+door and mixed cells;
`faceMask` on the four wall-over-floor combinations and zero elsewhere; `buildDualCells(map).length ===
(cols+1)*(rows+1)` in row-major order.

4.2 `themes/dual/__tests__/dualGeom.test.ts` (D0): `shapeOf` enumerated for all 16 masks against the §1.4 table;
`boundaryHalfEdges` for all 16 (count 0/2/2/4 for none/edge or convex or concave/diagonal); `halfEdgeStrip` rects lie
inside the cell and inside the `towards` quadrant for every (side, quadrant, t ∈ {1, 2}); `cornerCut` r=1 and r=2
pixel sets for all four quadrants, inside the quadrant and touching the centre.

4.3 `themes/dual/__tests__/fixtures.ts` (D0): `tilesFrom(rows: string[])` (`#` wall, `.` floor, `D` door, space void)
building a `Pick<GeneratedMap, 'cols'|'rows'|'tiles'|'rooms'|'roomAt'>`, and `allCornerCombos()`: the 81 cells with
every quadrant in `{void, wall, floor}` (doors covered separately by `withDoor(cell, q)`).

4.4 `paint/dual/__tests__/dualHarness.ts` (D0) + `{modern,guild,rift}Dual.test.ts` (D1/D2/D3): for each of the 81
combos × `facePass ∈ {true, false}` and both hooks, with `makeBoundsGraphics()`:
- every rect is inside the cell `[px, px+T) x [py, py+T)`;
- a uniform cell records zero rects;
- no rect intersects a face quadrant, nor the band pixels under it when `facePass`, nor a door quadrant;
- `paintWallBase` consumes the same number of `rand()` draws as `paintWall(g, px, py, false, rand)` over 50 seeds
  (a counting `rand`), and draws at least the full-tile fill.

4.5 `themes/__tests__/renderTheme.test.ts` (D4):
- hook count: with `{ dualGrid: true }` each dual hook is called exactly `(cols+1)*(rows+1)` times, and every call
  lands after the last tile call and before the first `backWall` call (extend the order test with `'dual'`);
- off path: a theme stripped of `paintWallBase/paintDualFloor/paintDualWall` yields the identical recorded
  `fillRect` list with `{ dualGrid: true }` and `{ dualGrid: false }`; with the hooks present, `{ dualGrid: false }`
  yields the identical list to the stripped theme (no dual hook is ever called, `paintWall` is used);
- `paintWallBase` is used instead of `paintWall` for every wall tile when the pass runs (counts), and
  `paintWall(faceVisible = true)` is still used when a theme has `paintWallBase` but no `paintBackWall`;
- Multiverse: a region's cells are painted by the region's theme (spy on `paintDualWall` like the back-wall test);
  island rim stacking: on a map with a region and a void margin, every dual rect inside the island-edge rows is
  recorded after the island-edge rects of that row;
- source guard: `paint/dual/*.ts` files (read with `node:fs`) do not contain the substring `tileOf(`.

4.6 `themes/__tests__/renderTheme.perf.test.ts` (D4, `pnpm test:perf` only): `game/__tests__/perfLayout.ts`
exports `maxRoomsLayout()` (a copy of the one in `procgen/__tests__/generate.perf.test.ts`, which stays as is). At
128 x 96 with `modernTheme` and a counting stub scene: `fillRect` count with the pass on ≤ 1.6 × off, median
wall-clock on ≤ 1.5 × off and ≤ 400 ms (5 samples after one warm-up; the stub scene has no canvas, so this measures
the JS command stream only).

4.7 Visual (D5, PM/QA): screenshots of `?demo=1` per style with `office.dualGrid` on and off, zoomed on a room
corner, a door, a corridor T-junction, and (Multiverse) an island edge. Feel is compared with the references
(decision #21), nothing is traced.

---

## 5. Tasks

Paths under `apps/web/src/game/` unless noted. File-disjoint within a wave; the dual tasks never touch `nav/*`,
`procgen/*`, `features/editor/*` or `Character.ts` (navigation.md tasks), nor `OfficeScene.ts`.

| id | wave | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|---|
| W0 | 0 | developer (contract) | `themes/dual/types.ts`, `themes/types.ts` (hooks + `DualCtx`), `themes/index.ts` (re-exports), `packages/shared/src/settings.ts` (`office.dualGrid`), `features/settings/meta.ts` + `meta.test.ts`, `config/office.yaml` | none | §1.2 and §2.1 verbatim; setting with hint; ROOT `pnpm typecheck` + web tests green. |
| D0 | 1 | developer | `themes/dual/dualGrid.ts`, `themes/dual/dualGeom.ts`, `themes/dual/__tests__/{dualGrid,dualGeom}.test.ts`, `themes/dual/__tests__/fixtures.ts`, `themes/paint/dual/__tests__/dualHarness.ts` | W0 | §1.3-1.4 implemented; tests 4.1-4.3 green; harness of 4.4 exported (`runDualPainterSuite(theme, name)`) and verified against a trivial no-op theme; no Phaser import. |
| D1 | 2 | developer | `themes/paint/dual/modernDual.ts`, `themes/paint/dual/__tests__/modernDual.test.ts`, `themes/modern.ts` (three hook lines) | D0 | §3 modern column; harness suite green; rand parity; `renderTheme.test.ts` existing tests still green with the hooks present (the off path). |
| D2 | 2 | developer | `themes/paint/dual/guildDual.ts`, `.../__tests__/guildDual.test.ts`, `themes/guild.ts` | D0 | §3 guild column; same gates. |
| D3 | 2 | developer | `themes/paint/dual/riftDual.ts`, `.../__tests__/riftDual.test.ts`, `themes/rift.ts` | D0 | §3 rift column; same gates; painter-level rim test: on a floor/void or wall/void boundary every void-side rect is a 1 px strip touching the boundary (so the island jag below stays visible). |
| D4 | 3 | developer | `themes/renderTheme.ts`, `themes/__tests__/renderTheme.test.ts`, `themes/__tests__/renderTheme.perf.test.ts` (new), `themes/__tests__/testUtils.ts` (a counting scene helper), `game/__tests__/perfLayout.ts` (new) | D0-D3 | §2.2-2.3 implemented; tests 4.5 and 4.6 green; existing renderTheme tests unchanged and green; `pnpm test:perf` green. |
| D5 | 3 | developer (editor) | `features/editor/PreviewScene.ts`, `features/editor/OfficeEditor.tsx` (scene data line) | D4 | preview renders with the setting; screenshots of 4.7 attached to the hand-off. |
| PM | 3 | PM | `game/scenes/OfficeScene.ts` | D4 | §2.4 wiring; toggling `office.dualGrid` live repaints without moving anyone; ROOT typecheck/test/build. |

`renderTheme.ts` is owned by D4 only. Any future task that edits it (for example a furniture-renderer change in the
optional W4 painter audit) must not run in the same wave as D4.

---

## 6. Risks and trade-offs

- **Rand churn.** Switching wall tiles to `paintWallBase` must not move a single floor speckle; the parity test
  (4.4) enforces equal draw counts, and the dual pass has its own stream. A theme that violates parity shows as a
  reshuffled floor when the toggle flips, which QA checks visually too.
- **Command count.** Edge art adds roughly 2-6 small rects per boundary half-edge. The lever, if 4.6 fails: merge
  the two half-edges of a straight boundary into one 16 px strip (the cell knows both via `shapeOf(...).kind ===
  'edge'`), and drop the 1 px alpha strips first. Uniform cells (most of the map) already cost nothing.
- **Thin walls.** A 1-tile wall between two rooms gets outlines on both sides and a face on the south; the cap
  keeps at least 14 px of its colour. Walls on the map border lose nothing (off-map pixels are clipped).
- **`tileOf` hazard.** Any painter helper that derives a tile from the cell origin rounds `-8 / 16` to `-1` or `0`
  depending on the browser's `Math.round` semantics for negative halves. Guarded by the source-string test and by
  `quadrantTile`.
- **Door jambs.** Doors stay square by design (invariant 8); a door-side hint for `paintDoor` is still an open point
  of back-wall.md §6.
- **Multiverse seams.** `dualThemeAt` picks one theme per cell; a realm's outer corner may show a 1 px line in the
  realm's colour against the rift. Accepted (it reads as the island's rim).
- **Perf on canvas renderer.** The stub-scene budget measures the command stream only. A real canvas bake at
  128 x 96 adds about 1 ms per 1k rects; the 400 ms ceiling and the existing dev log (`[theme] base texture
  generated in ...`) catch outliers.
