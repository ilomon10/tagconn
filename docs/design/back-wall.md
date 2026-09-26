# M8 8p: 3/4 back wall + standing appliances

Status: design (architect). Owners: procgen dev, themes/paint dev (+ rift painter), optional postfx follow-up.
Related: `docs/design/guild-hall.md` §3 (theme model) and §4 (procgen), `docs/decisions.md` #2 (D2: geometry never
depends on style), #21 (reference art: style only, never traced), #22 (all art code-drawn, baked).

## 0. Goal and what the references show

In the references (modern: `_GhEAR`, `1j2K7A`, `4o1jEB`, `BfE3aJ`; medieval: `3tTga8…`, `ICFOVi…`, `wZLolP…`) every
room's north wall reads as a **tall face** of about 1.5 tiles: a thin cap line on top, a flat face (cream plaster or dark
ashlar), and a baseboard. Wall decor hangs **on** that face (windows, clocks, pictures, whiteboards and charts, small
shelves; guild: arched glowing windows, banners, torches). Tall appliances (water cooler, printer, fridge, bookcase;
guild: fireplace, barrels, barred cells) stand on the floor **against** it, with their tops overlapping the face.
Partition walls between two rooms show the lower room's face. North doors are gaps in the face.

Today `paintWall(faceVisible)` draws a short face (8px modern, 6px guild) on the wall tile. Decor is 1-tile sprites at
the wall tile's centre, and furniture is flat and top-down.

## 1. Geometry decision

### Options
**A. Reserve the first interior row as a non-walkable "wall face" row.** You get a true 2-tile face with no character
overlap, but it changes geometry for every existing layout:
- every recipe that uses `r.y` (reception desk, whiteboard `board`, stairs, lounge counter, pm-office cabinet and shelf,
  corner plants) shifts down;
- seat counts drop in every room, so `DEFAULT_LAYOUT` parity breaks;
- `ROOM_MIN_INTERIOR`/`validateLayout` minimums (in `packages/shared`) have to grow;
- north doors become 2-deep (door + face row), and stairs rooms lose their top row;
- open rooms and halls need a separate rule.
The 8n furnish coverage bands and every sweep test would also need re-baselining. **Rejected.**

**B. Tall face painted over the wall tile, plus an overdraw band into the first floor row. That row stays walkable.**
Characters on that row stand in front of the band, which is correct 3/4 behaviour: nothing can be *behind* a back wall.
Their feet are at `py + 14` (`Character.ts`), so a band of up to 10px ends above the feet. **Chosen.**

### Chosen rule (B), exact
- A wall tile `(x, y)` is a **face tile** when `tiles[y+1][x]` is `floor` or `door` (the existing `faceVisible`).
- The face covers the wall tile from `capPx` down to the tile's bottom. When `tiles[y+1][x] === 'floor'` it also covers
  the **band**: the top `bandPx` pixels of tile `(x, y+1)`, with the baseboard at the bottom of the band. There is no band
  under a door tile, so a north door reads as an opening in the face.
- Per-theme numbers (`ThemeDefinition.backWall`):

  | Theme | capPx | bandPx | Visual face height |
  |---|---|---|---|
  | modern | 3 | 8 | 21px (≈1.3 tiles) |
  | guild | 2 | 10 | 24px (1.5 tiles) |
  | rift | 3 | 6 | 19px |

  `bandPx` must stay ≤ 10, so the band never reaches a character's feet (`py + 14`).
- **Walkability, seats, doors, `ROOM_MIN_INTERIOR`, `validateLayout`: unchanged.** No `packages/shared` change.
- This applies to every face tile, not only walled rooms: halls, corridors (void mode) and the outer ring get the same
  tall face. A double wall (two stacked walled rooms, each with its own ring) shows a cap on the upper ring and a face on
  the lower ring, so it reads as a thick wall.
- In the Multiverse, the face and band use `themeAt(x, y)` of the **wall** tile. Realm rects contain their walls, so a
  band never mixes themes.

### Depth invariant (why the scene does not change)
The base texture sits at depth -10 and characters at `depth = y` (pixels), so all baked art is below every character.
This is correct as long as **nothing baked is drawn taller than its footprint unless the tile north of the footprint is a
wall** (no walkable tile is behind it). 8p keeps this invariant:
- appliances only ever sit on a room's first interior row under a wall;
- their overdraw is capped at `MAX_OVERDRAW_PX = 12` above the footprint (it stays inside the wall tile's face and never
  reaches the room above);
- `againstNorthWall` recipe furniture may be drawn tall under the same cap.

Any future tall item away from a north wall must become a depth-sorted sprite (`depth = (y + h) * T`); that is out of
scope. Result: **no `OfficeScene.ts` change** (it is owned by the 8o shader dev).

## 2. Procgen contract (web-internal, `apps/web/src/game/procgen/`)

### 2.1 `procgen/types.ts` additions (T0, verbatim)
```ts
export type FurnitureKind =
  | /* ...existing kinds unchanged... */
  // M8 8p: standing appliances, always against a north wall (docs/design/back-wall.md).
  | 'printer'
  | 'fridge'
  | 'water-cooler'
  | 'filing-cabinet'
  | 'coffee-machine'
  | 'bookcase'
  | 'fireplace'
  | 'coat-rack'
  | 'supply-stack'
  | 'cage';

export interface PlacedFurniture extends Rect {
  kind: FurnitureKind;
  blocking: boolean;
  roomId: string;
  roomType: RoomType;
  variant: number;
  /** M8 8p: true when y === room.interior.y and every tile directly north of the footprint is a wall.
   *  Only then may a painter draw above the footprint (at most MAX_OVERDRAW_PX). Omitted = false. */
  againstNorthWall?: boolean;
}

/** M8 8p: semantic wall-mounted decor on a north-wall face (style-agnostic, D2). */
export type WallDecorKind = 'window' | 'clock' | 'picture' | 'board' | 'chart' | 'wall-shelf' | 'banner';
export interface WallDecorSlot {
  kind: WallDecorKind;
  /** Left-most wall tile; `y` is the WALL row (room.interior.y - 1). */
  x: number;
  y: number;
  /** Width in tiles, 1-3 (see WALL_DECOR_SPANS). */
  span: number;
  roomId: string;
  variant: number;
}

export interface GeneratedMap {
  /* ...existing fields unchanged... */
  /** M8 8p: static wall decor, baked into the base texture. North-wall LIGHTS are not here: they are
   *  emitted as ordinary `decor` `wall-light` slots, so torch sprites and 8o bloom pick them up unchanged. */
  northWall: WallDecorSlot[];
}
```

### 2.2 `procgen/backWallSpec.ts` (T0, new, data only; importable by themes)
```ts
import type { FurnitureKind, RoomType, WallDecorKind } from './types';

export type ApplianceKind = 'printer' | 'fridge' | 'water-cooler' | 'filing-cabinet' | 'coffee-machine'
  | 'bookcase' | 'fireplace' | 'coat-rack' | 'supply-stack' | 'cage';
/** Footprint width (h is always 1) and max art height above the footprint, in px. */
export const APPLIANCE_SPECS: Record<ApplianceKind, { w: 1 | 2; overdrawPx: number }> = {
  printer: { w: 1, overdrawPx: 10 }, fridge: { w: 1, overdrawPx: 12 }, 'water-cooler': { w: 1, overdrawPx: 12 },
  'filing-cabinet': { w: 1, overdrawPx: 8 }, 'coffee-machine': { w: 1, overdrawPx: 6 }, bookcase: { w: 2, overdrawPx: 12 },
  fireplace: { w: 2, overdrawPx: 12 }, 'coat-rack': { w: 1, overdrawPx: 10 }, 'supply-stack': { w: 1, overdrawPx: 8 },
  cage: { w: 2, overdrawPx: 12 },
};
export const MAX_OVERDRAW_PX = 12;
/** Existing kinds a painter MAY draw tall when `againstNorthWall` (wall decor avoids their columns). */
export const TALL_AGAINST_WALL_KINDS: ReadonlySet<FurnitureKind> = new Set(['board', 'shelf', 'cabinet', 'shelf-stack', 'counter']);
export const WALL_DECOR_SPANS: Record<WallDecorKind, readonly number[]> = {
  window: [1, 2], clock: [1], picture: [1, 2], board: [2, 3], chart: [1, 2], 'wall-shelf': [1, 2], banner: [1],
};
/** Weighted menus per room type (weight = repeat count). Types absent here get none. */
export const APPLIANCE_MENU: Partial<Record<RoomType, readonly ApplianceKind[]>> = { /* table in section 2.4 */ };
export const WALL_DECOR_MENU: Partial<Record<RoomType, readonly WallDecorKind[]>> = { /* table in section 2.4 */ };
/** Max appliances per room by density. */
export const APPLIANCE_MAX = { sparse: 1, normal: 2, dense: 3, packed: 4 } as const;
```

### 2.3 Algorithm (T1: `generate.ts` + new pure `procgen/backWall.ts`)
`generateMap(layout, opts?: { backWall?: boolean })`: the internal knob defaults to `true`, and `false` reproduces the
exact pre-8p output. It exists for the parity tests and is **not** a user setting (open point in section 6).

**Eligible room**:
- type is not `hall` or `stairs` (stairs occupy the top row);
- `interior.w >= 4 && interior.h >= 3`;
- resolved `furnish.decor > 0` (same precedence as today: room, then `furnishDefaults`, then 0.35).

Walled rooms and open rooms both qualify. The per-cell rule below needs a wall to the north, so an open room gets
appliances only along the part of its top row that sits under a wall.

**Step 8b: appliances.** Runs inside the per-room loop, right after the local reachability retry and before
`furniture.push(...keptItems)`.
- RNG: `rngFor(seed, furnish?.seed !== undefined ? \`wall:${id}:${furnish.seed}\` : \`wall:${id}\`)`. This is a **new**
  stream, so `roomRand` and the recipe are untouched.
- Candidate start `x` on row `y = interior.y`: every footprint cell `c` must satisfy all of these:
  - `tiles[y-1][c.x] === 'wall'`;
  - `c` is inside the interior and is not an apron, and neither horizontal neighbour is an apron;
  - no furniture (blocking or soft) and no recipe seat is on `c`;
  - the front cell `(c.x, y+1)` is interior, unblocked and not an apron.
- Count: `min(APPLIANCE_MAX[density], floor(candidateCols / 3))`. Pick kinds from `APPLIANCE_MENU[type]` with the stream
  (without replacement, except `bookcase` in `library`). Try shuffled starts, at most `3 * count` attempts.
- Accept a placement with cells `C` only if both hold:
  1. **No split.** `C` does not increase the number of 4-connected components of the room's free interior (interior
     minus blocked minus `C`), except by removing components made entirely of `C`. This keeps doors mutually connected,
     keeps every seat reachable, and keeps through-paths across open rooms intact. It is cheap: at most one flood fill
     per attempt over a room interior.
  2. **Top-up count parity.** `freeReachableNonSeat - |C| >= max(0, 12 - recipeSeats)`, so step 11's top-up still
     reaches the same seat **count**.
- Accepted items are `{ kind, x, y, w, h: 1, blocking: true, variant, againstNorthWall: true }`, appended after the
  room's kept recipe items. They go through the existing "apply blocking furniture to walkable" loop.
- Also set `againstNorthWall` on kept recipe items that satisfy the definition. This is additive; their geometry is
  unchanged.

**Step 11: unchanged code.** Top-up stand seats come from reachable tiles in row-major order, and appliance cells are
now blocked, so a top-up `stand` seat may move to the next reachable tile. Recipe seats are identical, and the per-room
count is identical by constraint 2.

**Step 13: north-wall decor.** Stream `rngFor(seed, \`wallDecor:${id}\`)`.
1. Legacy wall candidates (the existing loop) **skip** wall tiles directly above an eligible room's interior top row.
   Every other face tile (halls, corridors, stairs, ineligible rooms) keeps legacy slots.
2. For each eligible room, find the **runs** on wall row `y-1`: maximal x-ranges within
   `[interior.x + labelReserve, interior.x + w - 1]` that meet all of these:
   - the tile is `wall`;
   - it is not within 1 tile of a `door` on that row;
   - it is not above an appliance or an `againstNorthWall` item whose kind is in `TALL_AGAINST_WALL_KINDS`.

   Here `labelReserve = min(3, floor(w / 3))`, which keeps the room label (drawn at `labelAt`, on the face) readable.
3. **Lights** first: columns where `(x - runStart + k) % 5 === 2` (`k` is a stream draw in 0..4) become legacy
   `DecorSlot { kind: 'wall-light', roomId, variant }` and consume the column. When `k` would put a light in a 1-col
   run, skip it.
4. **Feature pattern**: in `lounge`, `entrance`, `pm-office` and `meeting-room` runs of length ≥ 5, centre a 2-span
   `window` with a `banner` on each side (a 1-col gap on each side). This matches the reference banner-window-banner rhythm
   and is style-agnostic.
5. **Greedy fill** of the remaining sub-runs, left to right. At each column, with probability `0.25 + 0.6 * decor`, pick a
   kind from `WALL_DECOR_MENU[type]` whose span (a stream pick from `WALL_DECOR_SPANS`) fits; place it, then skip
   `span + 1`. Otherwise skip 1.
6. Push slots into `northWall` in room order. Push light `DecorSlot`s after the legacy wall slots and before
   floor-scatter.

`decorateRoom`/floor-scatter then see appliance cells as taken, so **non-blocking** decor furniture and scatter may
reshuffle. This is visual only.

### 2.4 Menus (semantic, style-agnostic)

| Room type | Appliances (weighted) | Wall decor (weighted) |
|---|---|---|
| desks | printer ×2, filing-cabinet ×2, water-cooler, bookcase, supply-stack | window ×2, clock, picture, chart |
| pm-office | bookcase ×2, filing-cabinet, coat-rack, fireplace | picture ×2, window, wall-shelf, banner |
| meeting-room | coffee-machine, bookcase, fireplace | board, picture, clock, window |
| whiteboard | filing-cabinet, supply-stack | chart ×2, clock |
| library | bookcase ×3, fireplace | wall-shelf ×2, window, picture |
| qa-lab | fridge, filing-cabinet, supply-stack | chart ×2, clock, wall-shelf |
| review-booth | filing-cabinet, bookcase | picture, board, clock |
| server-room | cage ×2, filing-cabinet, supply-stack | chart, clock (no windows) |
| lounge | fridge, coffee-machine ×2, water-cooler, fireplace | window ×2, picture ×2, clock, banner |
| entrance | water-cooler, coat-rack, bookcase | banner ×2, clock, window, picture |

### 2.5 Parity rule (documented, deterministic, tested)
For any valid layout, `generateMap(l)` compared with `generateMap(l, { backWall: false })` (== pre-8p):
- **identical**: `tiles`, `walls`, `doors`, `stairs`, `spawn`, `frontDoor`, `roomAt`, `zoneAt`, `issues`,
  `reachability`, every room's recipe seats (the `sit` seats and the recipe `stand` seats, in order), per-room and
  per-zone **seat counts**, and every recipe furniture item (all fields except the added `againstNorthWall`);
- **differs only by appliance cells**: `walkable` (the extra 1s are exactly appliance cells); `rooms[].tiles` and
  `zones[].tiles` (they lose exactly those cells);
- **may differ (visual only)**: positions of top-up `stand` seats, non-blocking decor furniture, floor-scatter, legacy
  `decor` on eligible rooms' north walls (replaced by `northWall` + light slots), and the new `northWall`;
- a room with `decor: 0` is byte-identical to pre-8p for that room.

## 3. Rendering (T2: `apps/web/src/game/themes/`)

### 3.1 `themes/types.ts` additions (T0, verbatim, all optional so rift/tests compile until painted)
```ts
import type { WallDecorSlot } from '../procgen/types';
export interface BackWallStyle { capPx: number; bandPx: number }
export interface BackWallCtx {
  kind: RoomType | 'corridor';   // floor kind of the tile below (palette hook)
  band: boolean;                 // tile below is floor (false under a door)
  openLeft: boolean;             // left neighbour is not a face tile (door, side wall, void): draw a jamb/edge
  openRight: boolean;
  capPx: number;
  bandPx: number;
}
// in ThemeDefinition:
  backWall?: BackWallStyle;
  /** Paint the tall face for a face tile: wall tile from capPx down, plus (ctx.band) the top bandPx of the
   *  tile below, baseboard at the bottom. Called AFTER all tiles, so it overdraws the floor row. */
  paintBackWall?(g: Phaser.GameObjects.Graphics, px: number, py: number, ctx: BackWallCtx, rand: () => number): void;
  /** Static wall decor baked into the base texture. `faceTop`/`faceBottom` are absolute px of the face. */
  paintWallDecor?(g: Phaser.GameObjects.Graphics, slot: WallDecorSlot, T: number, face: { top: number; bottom: number }): void;
```

### 3.2 `renderGeneratedMap` pass order (one Graphics, one `generateTexture`; decision #22 kept)
1. Tiles, as today. When `themeAt(x,y).paintBackWall` exists, face tiles call `paintWall(..., faceVisible = false, ...)`
   so only the cap and top are drawn.
2. Island edges (unchanged).
3. **Back-wall face** (new): every face tile with a painter. It uses a **separate** PRNG
   `mulberry32(map.seed ^ 0x8b3a11ed)`, so the existing floor and wall noise stream is not reshuffled more than step 1
   requires.
4. **Wall decor** (new): `map.northWall` through `themeAt(slot.x, slot.y).paintWallDecor`, with
   `face = { top: y*T + capPx, bottom: (y+1)*T + bandPx }`.
5. Doors (unchanged), then the front gate.
6. Furniture (unchanged loop). Appliances and `againstNorthWall` items draw after the face and decor, so their tops
   overlap the face.

This adds no sprites. Lights stay legacy `wall-light` slots, so `animate()` (torch sprite, flame, glow pool), the 8o
`postfx/lights.ts` bloom, and `sliceMapForRect` in the Multiverse all keep working with no code change. Dev perf log
budget: base-texture time ≤ 1.2× today on the 128×96 perf layout.

### 3.3 Painters needed

| Kind | Modern (cream/teal office) | Guild (ashlar keep) |
|---|---|---|
| back wall | 3px off-white cap, cream face, 1px light top edge, 2px brown baseboard, jamb shading at `openLeft/Right` | dark ashlar courses (4px rows, staggered joints), 1px lit edge, moss by `rand`, dark plinth |
| window | wood frame, sky + green view, mullions; 2-span = double window | arched pointed window, warm amber glass, dark stone surround |
| clock | round white clock | heraldic round shield |
| picture | framed landscape | small tapestry |
| board | whiteboard with coloured scribbles | parchment map / notice board with pins |
| chart | KPI/bar chart poster | star chart |
| wall-shelf | small shelf with binders/plant | candle shelf with potions |
| banner | company pennant with logo | heraldic banner (reuse `BANNER_CLOTH`/emblems) |
| wall-light (legacy slot) | new `modern-sconce` texture in `paint/decor.ts` (today modern returns `null`) | existing torch |
| printer | copier (grey body, paper tray, green LED) | scribe's press / lectern with scrolls |
| fridge | white fridge, 2 doors | ice chest with frost runes, tall larder |
| water-cooler | blue jug on a white stand | water barrel on a stand with a ladle |
| filing-cabinet | grey 3-drawer cabinet | iron-bound chest of drawers |
| coffee-machine | machine on a small counter, mug | kettle over a small brazier |
| bookcase (2×1) | shelf with coloured binders (ref `_GhEAR`) | tall bookcase, coloured spines, candle |
| fireplace (2×1) | media wall with a flame screen | stone fireplace, flame (animated flicker in `guild.ts` `animate`) |
| coat-rack | coat stand with a coat | weapon rack (swords, spear) |
| supply-stack | stacked cardboard boxes (ref `1j2K7A`) | barrel pair |
| cage (2×1) | locked mesh server cage | iron-barred cell with straw |

Rift (T3) gets simple crystal/void variants for all 10 appliance kinds (its `Record<FurnitureKind, Painter>` has to be
exhaustive), plus `paintBackWall`/`paintWallDecor`. The optional hooks mean rift renders without them in the meantime.

Every appliance painter anchors its art to the footprint bottom (`(y+1)*T`), stays inside `[x*T, (x+w)*T)`, and never
paints above `y*T - APPLIANCE_SPECS[kind].overdrawPx`. `TALL_AGAINST_WALL_KINDS` painters may overdraw by up to
`MAX_OVERDRAW_PX` **only** when `againstNorthWall`.

## 4. Work breakdown (file-disjoint; T1, T2 and T3 run in parallel after T0)

The tree does not typecheck between T0 and the end of T1–T3: new `FurnitureKind`s break the exhaustive painter Records,
and the required `northWall` field breaks `generate.ts` until T1 lands. **The PM commits only after the whole wave
passes the root `pnpm typecheck`.**

**T0: contracts.** Role: developer (procgen). ~15 minutes, lands first.
- Files: `apps/web/src/game/procgen/types.ts`, `apps/web/src/game/procgen/backWallSpec.ts` (new, with the section 2.4
  menus filled in), `apps/web/src/game/themes/types.ts`.
- Acceptance: code matches sections 2.1, 2.2 and 3.1 verbatim; no runtime logic beyond constants.

**T1: procgen.** Role: developer (procgen). Depends on T0.
- Files: `procgen/generate.ts`, `procgen/backWall.ts` (new, pure: `placeAppliances(...)`, `planNorthWall(...)`,
  `componentCount(...)`), `procgen/__tests__/backWall.test.ts` (new). Existing test files are read-only unless a
  fixture has to add `northWall`.
- Acceptance:
  - **Parity sweep**: `DEFAULT_LAYOUT`, every captured fixture, and the 300 BSP samples from `bsp.test.ts` (both
    backgrounds) satisfy every rule in section 2.5, comparing `backWall: true` against `backWall: false`.
  - The existing reachability sweep, `furnish.test.ts` (including `furnish.seed` isolation) and `doors-explicit.test.ts`
    stay green, unmodified.
  - Determinism: two runs give `JSON.stringify`-equal output, and changing one room's `furnish.seed` changes only that
    room's appliances and slots.
  - Invariants for every appliance: `y === interior.y`, the tile north of each cell is `wall`, not on or next to an apron,
    front cell walkable, `blocking`, `againstNorthWall`.
  - `DEFAULT_LAYOUT` gets at least one appliance in ≥ 60% of its eligible rooms.
  - Invariants for every `northWall` slot: on wall row `interior.y - 1`, span inside a run, no overlap, ≥ 1 tile from any
    door, not over tall items, left of the label reserve is empty.
  - A room with `decor: 0` is byte-identical to `backWall: false`.
  - `perf.test.ts` passes unchanged, and the local median is within +10% of main.

**T2: themes/paint (modern + guild).** Role: developer (web themes). Depends on T0.
- Files: `themes/renderTheme.ts`, `themes/paint/walls.ts`, `themes/paint/wallDecor.ts` (new), `themes/paint/furniture.ts`,
  `themes/paint/decor.ts`, `themes/modern.ts`, `themes/guild.ts`, `themes/__tests__/painters.test.ts`,
  `themes/__tests__/renderTheme.test.ts`, `themes/__tests__/testUtils.ts`.
- Acceptance:
  - `painters.test.ts`: the exhaustive kind list includes the 10 appliances, and every modern and guild painter runs
    without throwing. A recording-Graphics check proves appliance rects stay inside the x-range and within
    `overdrawPx`, and that `TALL_AGAINST_WALL_KINDS` only overdraw when flagged.
  - Every `WallDecorKind` × span × theme paints inside `face`.
  - `renderTheme.test.ts`: call order is tiles → back wall → wall decor → doors → furniture. There is no band under
    `door` tiles, a Multiverse region's theme paints its own faces and decor, `generateTexture` is still called exactly
    once, and a theme without the optional hooks renders exactly as before.
  - Guild `fireplace` flicker is disabled when `ambient` is false.
  - Visual: screenshots of `?demo=1` in both styles (a desks room, the lounge/tavern, the server room/vault, the
    entrance) show a ≈1.3–1.5-tile face with a baseboard, decor on the face, and appliances standing against it. The PM
    or user compares them with the references for **feel**; nothing is traced (decision #21).

**T3: rift painters.** Role: developer (web themes; this can be T2's developer after T2, or a second developer).
Depends on T0.
- Files: `themes/paint/riftFurniture.ts`, `themes/paint/riftWalls.ts`, `themes/rift.ts`,
  `themes/__tests__/riftPainters.test.ts`.
- Acceptance: rift typechecks with an exhaustive Record; the painter tests cover the 10 kinds, `paintBackWall` and
  `paintWallDecor`; the Nexus renders with the tall face; `riftRegions.test.ts` is green.

**T4 (optional follow-up, after 8o merges): bloom for new sources.** Role: developer (postfx, the 8o owner).
- Files: `postfx/lights.ts`, `postfx/__tests__/lights.test.ts`.
- Acceptance: `fireplace` becomes a warm, flickering light (guild only); a guild `window` slot in `map.northWall` becomes
  a warm light. Order stays deterministic.

**T5: docs.** Role: PM.
- Files: `ROADMAP.md` (8p), `CHANGELOG.md` `[Unreleased]`, `docs/design/guild-hall.md` §3/§4 (a pointer to this file),
  `docs/architecture.md` if it lists render passes.

Then **QA, review and security in parallel.** QA re-runs the root `pnpm typecheck`, `pnpm test` and the demo in both
styles plus the Multiverse. Review checks the depth invariant (section 1) and parity (section 2.5). Security impact is
nil (web-only, no new inputs), so that check is a quick pass.

## 5. Risks

- **Top-up seat shift.** Idle "stand" spots in rooms with fewer than 12 recipe seats may move by a tile on upgrade.
  Counts are preserved and allocation stays deterministic. Documented in section 2.5.
- **Visual churn.** The rand stream shifts in pass 1 (for example, guild moss drawn only in the face branch). Floor
  noise may change slightly once. Accepted; the new passes use their own streams to keep this small.
- **Room labels on the face.** Mitigated by `labelReserve`. A nameplate plaque is left for the follow-up after 8o, since
  `OfficeScene.ts` is off-limits now.
- **Characters on the first row hide wall decor.** This is correct 3/4 behaviour. Wall-decor art stays in the upper face
  (above `(y+1)*T - 2`), so the heads of seated or standing characters cover only part of it.
- **Typecheck window during the wave.** Contracts land first, and the PM does not commit mid-wave.
- **8o bloom gap.** Until T4, guild windows and fireplaces have no bloom. Torches keep full bloom because they are still
  legacy `wall-light` slots.
- **Small rooms get few appliances.** Aprons, seats and the top-up constraint can leave no candidates. Accepted by
  design: walkability and seat count win over decoration.
- **Tall art near the map top.** A room at `interior.y = 1` overdraws into ring row 0, which is still inside the texture.

## 6. Open points (not blocking)

- Should appliances and wall decor become a user knob (for example `RoomFurnish.appliances`, or `office.backWall` in
  `SettingsSchema`)? That is a `packages/shared` change, deferred. Today `decor: 0` turns them off per room or per layout.
- North doors could get a door panel drawn in the face (as in ref `BfE3aJ`) instead of a plain gap: `paintDoor` would
  need a side hint.
- A nameplate plaque for room labels (scene work, after 8o).
