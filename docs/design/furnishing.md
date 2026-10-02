# Harmonious rooms: furniture groups, facing, slot identity and the editor (M16 → v0.10.0)

Status: approved for implementation · Plan: `~/.claude-sessions/profiles/ilomon/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md`
sections "15.3 Furniture harmony" and "15.4 Furniture editor fixes" (renumbered M16), plus the M15 W4 carry-over
(navigation.md §6 Wave 4: T7 shape insets, T8 denser pitches, T9 painter audit) · ADR #30.
Sibling doc: `docs/design/lighting.md`; **the combined M16 wave plan is lighting.md §8** (owned files per wave for both docs).
Scope: `packages/shared/src/layout.ts` (superset schema), `apps/web/src/game/procgen/` (`harmony.ts` new, `recipes.ts`,
`generate.ts`, `pins.ts`, `facingSpec.ts` new), `apps/web/src/game/nav/shapes.ts`, `apps/web/src/game/themes/paint/*`
(painter audit + facing), `apps/web/src/features/editor/*` + `stores/editorStore.ts`.

Read first: `docs/design/game-office.md` §5 (pins, `resolvePins`, `seatsFor`, the Furniture tool),
`docs/design/navigation.md` §1-3 (half tiles, one rasterizer, `KIND_SHAPE`, property suite), `docs/design/back-wall.md`
§2.3 (appliances and north-wall decor run *after* the recipe and must keep working unchanged), `docs/design/guild-hall.md`
D2 (geometry never depends on style).

---

## 0. Goals, non-goals, invariants

**Goals.** Rooms read as furnished by someone: a desk has its chair facing it, a monitor and a lamp; a sofa has a coffee
table, a rug and a side lamp; a meeting table has chairs all round and a whiteboard on a wall. Bookcases, cabinets and
appliances stand against *any* wall with the right facing; plants and lamps take corners; rugs and tables take the
centre. Seats and doors keep a free tile in front, rows leave circulation aisles, symmetric rooms get symmetric
arrangements. The generator tries K arrangements per room and keeps the best. The Hall Planner stops duplicating a dragged
desk, keeps decor still when one item is pinned, moves displaced items instead of dropping them, and gets labels, rotate,
delete, a palette and snap guides. Characters tuck closer to desks (shape insets) and painters accept half-tile sizes.

**Non-goals (M16).** Y-sorted sprites (M17), user-drawn art, a physics layer, rotation of *every* kind (only the
asymmetric set gets facing art, §5.3), new room types, server-side generation.

**Invariants.**
1. **D2.** Groups, affinities, scoring, facing rules, shapes and heights are keyed by `FurnitureKind`/`RoomType`; a style
   paints. `FACING_SUPPORT` and `KIND_SHAPE` are data in procgen/nav, never in a theme.
2. **Determinism.** Every room draws from its own stream `rngFor(seed, 'room:<id>[:<furnish.seed>]')` exactly as today; the K
   candidates are drawn from that stream in order; decor positions are per-item hashes (§3.5). Equal inputs → equal maps.
3. **Pins first, never removed, never duplicated.** A pin with `fromSlot` *consumes* that recipe slot; a `suppressed` pin
   consumes it and places nothing. The reachability retry still never removes a pin.
4. **Conservative tile reachability** (navigation.md invariant 3) stays: `walkable` derives from the nav grid; a tile with any
   blocking overlap is blocked; seats sit on standable tiles. Shape insets open *cells*, not tiles.
5. **Budget.** `generate.perf.test.ts` ceilings are unchanged (`MEDIAN_BUDGET_MS = 400` at 128 x 96); the harmony pass must keep
   the measured median within +30 % of today's (recorded in the F5 hand-off before and after).
6. **Contract superset, no migration.** `facing`, `fromSlot`, `suppressed` are optional; `w`/`h` widen from `.int()` to
   half steps. Stored rows, `.tagconn/office.json` and `DEFAULT_LAYOUT` keep parsing and generating.
7. **Later passes untouched.** Appliances (`placeAppliances`), north-wall decor (`planNorthWall`), triggers
   (`assignTriggers`), the nav build and the global verify keep their inputs (`keptItems`, `blocked`, `seats`, aprons); the
   harmony pass only changes what the recipe hands them.
8. **Hot files are PM-only**; `renderTheme.ts` is not edited (lighting.md §8).

---

## 1. Contract (W0-F)

### 1.1 `packages/shared/src/layout.ts`

```ts
export const FACINGS = ['n', 'e', 's', 'w'] as const;
/** M16: which side an item "looks" at. `s` is the default of every painter (the 3/4 view faces the camera). */
export type Facing = (typeof FACINGS)[number];

/** M16: a recipe slot id `<group>:<index>` (furnishing.md §3.2), stable for a given room type, interior size, furnish options and seed. */
export const SLOT_ID_RE = /^[a-z][a-z0-9-]{0,23}:\d{1,3}$/;

export const PinnedFurnitureSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  x: z.number().min(0).max(LAYOUT_LIMITS.maxWidth).refine(isHalfStep, 'x must be a multiple of half a tile'),
  y: z.number().min(0).max(LAYOUT_LIMITS.maxHeight).refine(isHalfStep, 'y must be a multiple of half a tile'),
  /** M16: half-tile sizes (the painters clip to fractional footprints, furnishing.md §5). Superset of the old `.int()`. */
  w: z.number().min(0.5).max(8).refine(isHalfStep, 'w must be a multiple of half a tile'),
  h: z.number().min(0.5).max(8).refine(isHalfStep, 'h must be a multiple of half a tile'),
  variant: z.number().int().min(0).max(255).optional(),
  /** M16: facing; omitted = the recipe's or `s`. Only values in the kind's FACING_SUPPORT are honoured (others fall back, with no issue). */
  facing: z.enum(FACINGS).optional(),
  /** M16: the recipe slot this pin replaced; the recipe skips that slot instead of placing the item again (no duplicate on drag).
   *  Omitted = a free pin (palette item, legacy pin). A slot that no longer exists (room resized) is simply ignored. */
  fromSlot: z.string().regex(SLOT_ID_RE).optional(),
  /** M16: "deleted from generation": the slot is consumed and nothing is placed. The rect is the slot's rect (the planner draws a ghost).
   *  A suppressed pin occupies nothing: it is exempt from overlap and apron checks. */
  suppressed: z.boolean().optional(),
});
```

`validateLayout` pin loop: `if (f.suppressed) continue;` before the overlap/apron checks (a ghost blocks nothing).
`LAYOUT_LIMITS` unchanged (48 pins per room; a suppressed pin counts). `coveredTileRect`/`coveredTiles` already handle
fractional sizes. Tests: old integer rows parse unchanged; `{ w: 2.5 }` accepted, `{ w: 2.25 }` rejected; `fromSlot: 'desk:3'`
accepted, `'Desk:3'`/`'desk'` rejected; a suppressed pin overlapping another pin raises no warning.

### 1.2 `procgen/types.ts`

```ts
import type { Facing } from '@tagconn/shared';
export interface PlacedFurniture extends Rect {
  /* ...existing... */
  /** M16: facing (furnishing.md). Painters read `f.facing ?? 's'`; `w`/`h` are already swapped for `e`/`w`. */
  facing?: Facing;
  /** M16: the recipe slot this item came from (`<group>:<index>`); absent on pins, appliances, triggers, decor and stairs. */
  slotId?: string;
  /** M16: the group instance this item belongs to (`<group>#<n>` within the room), for the editor's "move the group" hint and tests. */
  groupId?: string;
}
```

### 1.3 `procgen/facingSpec.ts` (W0-F, data only, D2)

```ts
import type { Facing } from '@tagconn/shared';
import type { FurnitureKind } from './types';
/** Which facings a kind may be placed with. `['s']` = fixed (art is one-sided or symmetric: no rotation needed).
 *  e/w entries mean the footprint is swapped (w <-> h) by the recipe/editor before placement. */
export const FACING_SUPPORT: Record<FurnitureKind, readonly Facing[]>;
// chair, armchair, sofa, bench, booth, counter, bookcase, shelf, shelf-stack, cabinet, filing-cabinet, board, notice-board,
// roster-board, lamp, plant, crate, bin, coat-rack, supply-stack, rack, rack-row, table, reading-table, standing-table:  n e s w
// work-desk, lead-desk, workbench, lab-bench, reception-desk, console, equipment, fridge, printer, water-cooler, coffee-machine,
// fireplace, cage, arcade, ping-pong, foosball, board-game-table, centerpiece, pedestal, sigil, rug, mat, wall-art, banner,
// stairs-up, stairs-down:  s only   (M16; widened per kind when its painter grows a variant, furnishing.md §5.3)
export const facingSupported = (kind: FurnitureKind, f: Facing): boolean => FACING_SUPPORT[kind].includes(f);
/** Next facing in the kind's list (R in the editor); `s` when the kind is fixed. */
export function nextFacing(kind: FurnitureKind, f: Facing): Facing;
/** The footprint for a facing: `e`/`w` swap w and h relative to the kind's canonical (south-facing) size. */
export function footprintFor(size: { w: number; h: number }, f: Facing): { w: number; h: number };
/** The tile(s) "in front" of a rect for its facing (the clearance strip): the row south of it for `s`, north for `n`, the column east/west. */
export function frontStrip(r: Rect, f: Facing, depth?: number): Rect;
```

### 1.4 `procgen/recipes.ts` types

```ts
export interface RecipeItem {
  kind: FurnitureKind; x: number; y: number; w: number; h: number; blocking: boolean; variant: number;
  /** M16: stable slot id (§3.2); every recipe item has one. */
  slotId: string;
  groupId: string;
  facing?: Facing;
}
export interface FurnishContext {
  /** Door apron tiles (absolute "x,y"), kept clear with a 1-tile front strip. */
  aprons: ReadonlySet<string>;
  /** Interior sides that are solid wall (a side counts when >= 60 % of the tiles just outside it are `wall`). Walled rooms: all four. */
  wallSides: ReadonlySet<Facing>;
  /** Pins already placed in this room (absolute rects) and the slots they consume. */
  pinned: readonly Rect[];
  consumedSlots: ReadonlySet<string>;
}
export interface RecipeResult {
  furniture: RecipeItem[];
  seats: RecipeSeat[];
  seatsShortfall?: { wanted: number; fit: number };
  /** M16: the winning candidate's score (tests, the planner's inspector). */
  score: HarmonyScore;
  /** M16: slots the plan had but could not place (consumed, displaced-and-dropped), for the editor's ghost list. */
  skippedSlots: string[];
}
export function furnishRoom(type: RoomType, r: Rect, rand: () => number, opts: FurnishOptions, ctx: FurnishContext): RecipeResult;
export function decorateRoom(r: Rect, freeCells: readonly Point[], decor: number, roomSeed: string, ctx: DecorContext): RecipeItem[];   // §3.5
```

---

## 2. The harmony model (`procgen/harmony.ts`, pure, F1)

### 2.1 Groups

A **group** is a template of members in a local frame facing `s` (the anchor is the member marked `anchor`; offsets are
in tiles, halves allowed). Rotating a group to another facing rotates offsets, member facings and footprints.

```ts
export type Affinity = 'wall' | 'corner' | 'centre' | 'any';
export interface GroupMember {
  kind: FurnitureKind;
  w: number; h: number;                 // canonical (south-facing) size, halves allowed
  dx: number; dy: number;               // offset from the anchor's top-left, local frame
  facing?: Facing;                       // local; rotated with the group
  anchor?: true;
  optional?: true;                       // dropped first when the group does not fit
  /** Seats this member offers in the local frame (`seatsFor` rules are the default; explicit entries override). */
  seats?: readonly { dx: number; dy: number; kind: 'sit' | 'stand' }[];
}
export interface GroupTemplate {
  id: string;                            // kebab, the `<group>` of a slot id
  members: readonly GroupMember[];
  affinity: Affinity;
  /** Free tiles required in front of the anchor's facing side (seats are inside the group; this is the walkway). */
  clearance: number;
  rotatable: boolean;                    // may face e/w (members must all support it)
  /** How many instances the room wants: `fill` = as many as fit by density, a number = exactly that many (if they fit). */
  repeat: 'fill' | number;
  weight: number;                        // order of placement (higher first)
}
export const GROUPS: Record<string, GroupTemplate>;
export const ROOM_PLANS: Record<RoomType, readonly string[]>;   // group ids per room type, placement order
export function rotateGroup(t: GroupTemplate, facing: Facing): GroupMember[];
```

Groups (every kind the M13 life activities, M12 drama props and triggers rely on stays reachable):

| group | members (local, facing s) | affinity | repeat | rooms |
|---|---|---|---|---|
| `desk` | work-desk 2x1 (anchor) · chair 1x1 at (0, 1) and (1, 1) facing n (soft) · lamp 1x1 at (1.5, -0.5)? no: lamp sits *on* the desk (painted) so no member; monitor painted · optional plant at (-1, 0) corner-ish | `any` (rows) | `fill` | desks, pm-office (extra desks) |
| `desk-pair` | two `desk` facing each other across a 1-tile aisle (desk at (0,0) facing s, chairs (0,1),(1,1); desk at (0,3) facing n, chairs (0,2),(1,2)) | `any` | `fill` | desks (dense/packed prefer pairs: back-to-back chairs share the aisle) |
| `lead` | lead-desk 3x1 (anchor) · chair at (1, 1) n · rug 4x2 at (-0.5, 2) · two chairs at (0, 3) and (2, 3) (stand spots) | `centre` | 1 | pm-office |
| `meeting` | table (sized to the room as today, anchor) · chair on every ring tile facing the table · board 2-3 wide on a wall side (wall affinity resolved separately as `board`) | `centre` | 1 | meeting-room |
| `board` | board w x 1 facing into the room | `wall` | 1 (meeting, whiteboard), `fill` in whiteboard rows | whiteboard, meeting-room, review-booth |
| `standing-row` | standing-table 2x1 + 2 stand seats s | `any` | `fill` | whiteboard |
| `sofa-set` | sofa (2..4)x1 (anchor, soft, seats on itself) · table 2x1 at (0.5, 1.5) (coffee table, blocking) · rug (w+1)x3 at (-0.5, 0.5) · lamp 1x1 at (w, 0) | `wall` (back to a wall) else `centre` | 1 | lounge |
| `armchair-nook` | armchair 1x1 · lamp at (1, 0) · optional plant at (-1, 0) | `corner` | 1-2 | lounge, library, pm-office |
| `counter` | counter 1x1..3x1 facing s + stand seats | `wall` | 1 | lounge, entrance (as reception below) |
| `amenity` | one of arcade 1x1 / ping-pong 2x1 / foosball 2x1 / board-game-table 2x1 (+ stand seats) | `wall` for arcade, `centre` for tables | `fill` (slot k picks `LOUNGE_SLOT_KINDS[k]` as today, then tables) | lounge |
| `shelf-row` | shelf-stack (1..3)x1 facing s + stand seats every 2 | `wall` first (e/w rotated along side walls), then rows | `fill` | library |
| `reading` | reading-table 2x1 + 2 chairs s | `centre` | 1 | library |
| `bench-row` | lab-bench / workbench (w-2)x1 + stand seats | `any` rows | `fill` | qa-lab |
| `equipment` | equipment 2x2 | `corner` | 1 | qa-lab |
| `booth` | booth 1x1 + sit s | `wall` (along walls, facing in) then rows | `fill` | review-booth |
| `rack-row` | rack-row 1xN (merged stack as today) + stand | `any` rows (vertical) | `fill` | server-room |
| `console` | console 1x1 facing w + sit (−1, 0) · optional sigil | `corner` | 1 | server-room |
| `reception` | reception-desk 3x1 facing s + sit behind (1, -1)? no: sit at (0, 1) as today · mat 2x1 at the door side | `wall` (n preferred) | 1 | entrance |
| `bench-row-entrance` | bench 2x1 + 2 stand | `any` rows | `fill` | entrance |
| `plant-corner` | plant 1x1 | `corner` | `fill` (one per free corner, by decor) | all |

Exact member offsets are the developer's within the tests of §7 (every member inside the interior, seats on free tiles,
chairs facing their desk/table). The M12/M13 kinds (`notice-board`, `roster-board`, `coffee-machine`, `water-cooler`, …)
are appliances/triggers and keep their own passes.

### 2.2 Affinity and candidate positions

```ts
export interface PlacementCtx extends FurnishContext { interior: Rect; density: FurnishDensity; aisle: number; decor: number }
/** Anchor positions a group may take, in priority order for its affinity. Walls: along each side in `wallSides`, flush to it,
 *  facing into the room, stepping by the group's width; corners: the four corners (facing away from the walls); centre: the
 *  interior centre snapped to halves, then a ring around it; any: the `fillRows` grid (rows by `aisle` and density, with the
 *  half-gap pitch of §4.3). All positions keep `frontStrip(anchor, facing, clearance)` and door aprons + their 1-tile strip free. */
export function anchorCandidates(t: GroupTemplate, facing: Facing, ctx: PlacementCtx): Point[];
/** Place one instance: tries facings (s first; e/w when `rotatable` and the side is a wall) and anchors in order; returns the
 *  members as RecipeItems with slot ids, or null. Honours `consumedSlots` (a consumed member is skipped, the rest placed). */
export function placeGroup(t: GroupTemplate, instance: number, ctx: PlacementCtx, occupied: OccupancyGrid, rand: () => number): RecipeItem[] | null;
```

`OccupancyGrid` is a half-tile `Uint8Array` over the interior (cells = `w * 2 x h * 2`): 0 free, 1 blocking, 2 soft, 3
reserved (apron, clearance). Group members are written at half-cell resolution so two half-offset items may share a tile
without overlapping (`rectsIntersect` semantics); the tile-level `blocked` set that `generate.ts` keeps is derived from it
(`coveredTiles` of blocking rects: invariant 4).

### 2.3 Scoring

```ts
export interface HarmonyScore { reach: number; clearance: number; alignment: number; symmetry: number; density: number; total: number }
export const SCORE_WEIGHTS = { reach: 0.35, clearance: 0.25, density: 0.2, alignment: 0.1, symmetry: 0.1 } as const;
export const DENSITY_TARGET: Record<FurnishDensity, number> = { sparse: 0.18, normal: 0.3, dense: 0.45, packed: 0.6 };   // blocking coverage of the interior
export const CANDIDATES: Record<FurnishDensity, number> = { sparse: 3, normal: 4, dense: 5, packed: 6 };
/**
 * reach: 0 when any seat is unreachable from the aprons (tile flood over the interior minus blocking, as generate.ts' localReach),
 *   else the reachable fraction of the walkable floor; clearance: fraction of seats whose front tile is free and of aprons with a
 *   free strip; alignment: fraction of blocking items sharing an x or y edge line with another item or an interior edge;
 *   symmetry: for rooms with `w` or `h` >= 6, overlap ratio of the blocking mask with its mirror (max over the two axes), else 1;
 *   density: 1 - |coverage - target| / target, clamped to [0, 1]. total = weighted sum; reach = 0 forces total = 0.
 */
export function scoreCandidate(items: readonly RecipeItem[], seats: readonly RecipeSeat[], ctx: PlacementCtx): HarmonyScore;
/** K candidates from the room's stream (the stream advances the same amount per candidate: `CANDIDATE_DRAWS = 64` draws reserved,
 *  so candidate j always starts at the same stream offset), scored; the best wins, ties by index. */
export function bestCandidate(type: RoomType, ctx: PlacementCtx, rand: () => number, K: number): { items: RecipeItem[]; seats: RecipeSeat[]; score: HarmonyScore; skippedSlots: string[] };
```

Why K per room and not per layout: rooms are independent given their interiors, so the search is local and parallel
in spirit; the cost is `K x (place + flood)` per room, a few hundred microseconds each, well inside +30 % at 64 rooms.

---

## 3. Recipe plan, slots, consumption, displacement, decor (`recipes.ts` F1; `generate.ts` + `pins.ts` F5)

### 3.1 `furnishRoom` on groups

`furnishRoom(type, interior, rand, opts, ctx)` = `bestCandidate(type, { ...ctx, interior, ...opts }, rand, CANDIDATES[opts.density])`
plus the existing seat dedupe and `seatsShortfall`. Half-gap pitches (§4.3) are inside `anchorCandidates`. The old
per-type `switch` is deleted; `seatsFor` stays (pins, appliances and the editor still use it) and gains `facing` awareness:
`seatsFor(kind, rect, interior, facing = 's')` seats the *front* strip for one-sided kinds (desks, booths, benches, counters,
shelves) and the ring for tables; sofas/armchairs sit on themselves.

### 3.2 Slot identity

`slotId = `${group.id}:${ordinal}`` where `ordinal` is the member's index in the room's **plan** (the ordered list of
`(group instance, member)` the room *wants*, computed before any collision test, from `ROOM_PLANS[type]`, the interior size,
the density and the repeat rule). Removing a neighbour (a pin consumes it, a displaced item is dropped) does not renumber:
the plan is the same, only its placement differs. The per-instance `groupId` is `${group.id}#${instance}`. Stability
property (test): two generations of the same room spec give the same plan, and the same `slotId` maps to the same kind,
size and group even when pins consume other slots; changing `furnish.seed` keeps slot ids (positions may move); resizing
the room may change them (documented; the editor's stale `fromSlot` is harmless).

### 3.3 Half-tile sizes and positions

Groups may use half offsets (a side lamp at `w + 0.5`, a coffee table at `y + 1.5`) and half sizes (`rug` `(w + 1) x 2.5`),
only where `isHalfAligned` holds (positions multiples of 0.5, sizes multiples of 0.5). `coveredTiles` blocks conservatively;
seats stay integer tiles (`seatsFor` on `coveredTileRect`). Density gains come from §4.3, not from shrinking furniture.

### 3.4 Generator integration (F5, `generate.ts` room loop; line numbers as of v0.9.0)

1. Build `FurnishContext` before the recipe (`:610`): `aprons = reserved`, `wallSides` from `tiles` around `interior`,
   `pinned` = accepted pin rects (absolute), `consumedSlots` = `fromSlot` of every accepted pin (suppressed included).
2. `resolvePins` (`pins.ts`) accepts `facing`/`fromSlot`/`suppressed`: a suppressed pin is validated for kind only, emitted
   into `ResolvedPins.consumed` (not into `items`), and never placed. A blocking pin over an apron is **kept** and reported
   `pinned-blocks` (warning) instead of skipped (spec §5.2 reconciled; `prunePins`/`pinFits` in the editor still refuse
   *explicit* aprons, so this only bites auto-door aprons and hand-edited files; the reachability overlay shows it).
3. Recipe items whose `slotId` is consumed never appear (the recipe skipped them), so a dragged desk is placed exactly once
   (the pin). Seats: the pin's `seatsFor(..., pin.facing)` replace the slot's; the "dropped seat support" filter (`:643-654`)
   keeps working for displaced-and-dropped items.
4. **Displacement**: a recipe item that collides with a pin (`pinnedCells`) or `reserved` is moved, not dropped:
   `relocate(item, group, ctx, occupancy)` tries, in order, (a) the whole group instance shifted along its row/wall axis by
   ±0.5, ±1, … up to 3 tiles (same facing, affinity preserved: wall items slide along the wall, centre items stay within 1 tile
   of the centre), (b) the single item the same way, (c) drop it (today's behaviour) and record it in `skippedSlots`. Pure, in
   `harmony.ts`; called from the room loop where `fits` fails (`:634-638`). Seats move with the item.
5. `pinned-blocks` + the retry: unchanged (`:730-743`); a kept apron pin can leave a room `unreachable-*`, which the global
   verify reports with the existing fix suggestions.
6. `decorateRoom` gets `roomSeed` and a `DecorContext` (§3.5) at `:997`; `takenCells`/`seatCells` are passed as today.
7. `PlacedFurniture.facing/slotId/groupId` flow through `keptItems` into `map.furniture`; `pins` emit `facing` and
   `slotId: undefined`, `pinned: true`.

### 3.5 Decor fix (`decorateRoom`, F1)

```ts
export interface DecorContext { wallSides: ReadonlySet<Facing>; seats: ReadonlySet<string>; corners: readonly Point[]; aprons: ReadonlySet<string> }
export const DECOR_AFFINITY: Record<'plant' | 'rug' | 'lamp' | 'crate' | 'banner' | 'wall-art' | 'bin', Affinity | 'seat'> =
  { plant: 'corner', rug: 'centre', lamp: 'seat', crate: 'wall', banner: 'wall', 'wall-art': 'wall', bin: 'wall' };
```

Eligible cells per kind: `wall` = free interior cells 4-adjacent (across the interior edge) to a side in `wallSides`;
`corner` = the free cells among the interior's four corners, then cells adjacent to two walls; `seat` = free cells 4-adjacent
to a seat or a corner; `centre` = free cells inside the interior inset by 1. **Per-item seeded positions**: item `i`
(`count = round(perimeter * decor * 0.25)` as today) picks `kind = DECOR_KINDS[hash(roomSeed, i, 'kind') % n]` and its cell by
`hash(roomSeed, i, 'cell') % eligible.length` with linear probing over `eligible` when the cell is taken; no shared pool is
spliced, so pinning or consuming one item never reshuffles the others. `wall-art` and `banner` are placed only when the
chosen cell's wall side is in `wallSides` (never mid-floor). Lamps never land on a cell with no seat or corner within 1 tile.

### 3.6 Issues

No new `LayoutIssueCode`. `pinned-invalid` covers a bad `facing` (silently fixed, no issue) and a bad `fromSlot` (ignored, no
issue): neither can break a floor, so neither is reported.

---

## 4. Collision insets and denser pitches (`nav/shapes.ts` F2; `harmony.ts` F1; gated in F5)

### 4.1 `KIND_SHAPE` (navigation.md §2.3; D2)

| kind | shape | why |
|---|---|---|
| `work-desk`, `lead-desk`, `reading-table`, `booth` | `{ inset: { n: 0, e: 0, s: 1, w: 0 } }` (1 cell = half a tile on the chair side) | a chair tucks under the desk edge; a cat walks under |
| `standing-table` | `{ inset: { n: 1, e: 0, s: 1, w: 0 } }` | people stand at it on both long sides |
| `plant` | `'none'` (unchanged; soft) | |
| `table` (meeting/coffee) | `'full'` | seats ring it; no tuck |
| `counter`, `bench`, `rack-row`, appliances, boards, amenities | `'full'` | stood against, not under |
| everything else | as today (`KIND_BLOCKING ? 'full' : 'none'`) | |

Shapes are **direction-aware via facing**: `applyFurniture` rotates an inset by `f.facing` (`s` = canonical; `n` flips n/s;
`e`/`w` rotate) — `nav/shapes.ts` exports `insetFor(shape, facing)`. For `person` (k = 2) nothing changes at the tile level
(a tile with one inset cell is still non-standable), so `walkable`, seats and reachability are byte-identical (property 1);
`small` creatures route through the opened cells (property 10 extended with a desk fixture).

### 4.2 Gating

F5 runs navigation.md §5 properties 1, 5, 6, 10 and the frame-sampled walk test over 300 seeds; a regression blocks the
inset table, not the milestone (the table collapses back to `'full'` per kind).

### 4.3 Half-gap pitches (navigation.md T8)

`anchorCandidates` for `any`-affinity rows uses `rowPitch = stackHeight + aisle + (HALF_GAPS ? 0.5 : 1)` where the 0.5 is the
chair row sharing half a tile with the next desk's inset: with `aisle = 1`, a `desk-pair` block (desk, chairs, chairs, desk)
repeats every 4.5 tiles instead of 5; single rows every 2.5 instead of 3. `HALF_GAPS = true` is a module constant toggled off
by the gate if property 5 (every seat reachable) fails on any seed. Expected: +15-20 % seats in `desks` rooms at `normal`.

---

## 5. Painter audit and facing (`themes/paint/*`, F3 W1, F6 W2)

### 5.1 Why painters break on fractional sizes

Painters compute `w = f.w * T` and loop per integer tile; with `w = 2.5` several draw past the footprint. Audit of v0.9.0
(`themes/paint/furniture.ts`; `riftFurniture.ts` has no per-tile loops but shares the `f.w / 2` pattern):

| line | kind | loop | fix |
|---|---|---|---|
| `:161` | work-desk (MODERN) | `for i < f.w` monitors at `x + i*T + 3`, 10 wide | loop `i < ceil(f.w)`, `if (mx + 10 > x + w) break` |
| `:191` | table | `for i < max(1, f.w / 2)` paper at `x + 4 + i*2T` | `i < Math.max(1, Math.floor(f.w / 2))` + clip |
| `:200` | board | `for i < f.w * 2` notes at `x + 3 + i*7` | `i < floor(f.w * 2)` + clip `x + 3 + i*7 + 6 <= x + w` |
| `:214` | workbench | `for i < f.w` tools per tile | `ceil` + clip |
| `:357`, `:1062` | rack-row (MODERN, GUILD) | `for row < f.h` | `row < ceil(f.h)` + clip `ry + 14 <= y + h` |
| `:382`, `:1091` | lab-bench / shelf-stack | `for i < f.w` | `ceil` + clip |
| `:822`, `:866`, `:877`, `:914` | GUILD shelf, bookcase spines, counter, chest | per-tile loops | `ceil` + clip |

Rule for every painter (enforced by the harness): with `rect = (x, y, w, h)` = `f.x*T, f.y*T, f.w*T, f.h*T`, every drawn rect
lies in `[x, x + w) x [y - overdraw, y + h)` where `overdraw` is 0 unless `againstNorthWall` (back-wall.md rules), and the
helper `clipRect(rectFn, footprint)` in `paint/util.ts` (F3) wraps `rect` so a 1-px overrun is clipped rather than
drawn (defensive; the loops are still fixed so art is not cut mid-glyph). `testUtils.ts` gains
`fractionalFootprints = [{w:1.5,h:1},{w:2.5,h:1},{w:1,h:1.5},{w:2.5,h:2.5}]` and `painters.test.ts` runs every kind x every
footprint x every facing in `FACING_SUPPORT` and asserts the bounds.

### 5.2 Facing strategy (painter contract)

`ThemeDefinition.paintFurniture(g, f, T)` keeps its signature. `f.facing ?? 's'` is read by the painter; `f.w`/`f.h` are
already the rotated footprint. Three tiers, in `themes/paint/facing.ts` (F3):

```ts
/** Kinds whose art is rotation-safe (rects only, no text/asymmetric detail): draw once in the south frame and rotate the
 *  Graphics canvas (`g.save(); g.translateCanvas(cx, cy); g.rotateCanvas(angle); ... g.restore()`) for e/n/w.
 *  Phaser records these as commands and `generateTexture` honours them on WebGL and Canvas. */
export function paintRotated(g: Graphics, f: PlacedFurniture, T: number, drawSouth: (g, f: PlacedFurniture, T) => void): void;
/** Mirror only (n): `scaleCanvas(1, -1)` about the footprint centre. */
export function paintMirroredNS(...): void;
/** Rect-recording harness support: maps a recorded south-frame rect to its rotated bounds for the bounds tests. */
export function rotateRectForFacing(r: Rect, footprint: Rect, facing: Facing): Rect;
```

| tier | kinds | M16 |
|---|---|---|
| rotation-safe (canvas rotate) | table, reading-table, standing-table, rack, rack-row, bench, counter, shelf, shelf-stack, bookcase, cabinet, filing-cabinet, crate, bin, supply-stack, coat-rack, board, notice-board, roster-board, lamp, plant | F3 (W1) wraps them in `paintRotated`; only `s` is emitted by the recipe until F6 confirms the look per style |
| explicit variants | chair, armchair, sofa, booth | F6 (W2): a back view for `n` (cushions/backrest at the bottom), side views for `e`/`w` (sofa: swapped footprint, arm at the top) in modern, guild and rift |
| fixed (`s` only) | desks, benches of the lab, appliances with a front face (fridge, printer, water-cooler, coffee-machine, fireplace, cage), consoles, equipment, amenities, stairs, rugs, mats, sigils, wall-art, banner | unchanged; `FACING_SUPPORT` lists `['s']` so the recipe/editor never rotate them |

`rectFn` in the harness records untransformed rects; the test applies `rotateRectForFacing` with the footprint, so bounds
hold in every facing. The depth invariant (back-wall.md §1) is unaffected: rotation stays inside the footprint; overdraw
is only allowed facing `s` against a north wall.

### 5.3 Which painters get variants (F6)

Modern: chair (4 views), armchair (4), sofa (4), booth (n: back panel). Guild: same kinds (bench-style chair, tavern sofa).
Rift: chair/armchair/sofa (crystal seat with a glow stripe on the facing side). Tests: each variant inside bounds; the
`s` variant is byte-identical to today's command stream for every kind (the harness compares recorded rects), so existing
floors look the same until a recipe or the user rotates something.

---

## 6. Editor (`features/editor/*`, `stores/editorStore.ts`; F4)

### 6.1 Slot consumption and suppression

- `pinFromPlaced(item, interior)` copies `slotId → fromSlot` and `facing` (F4 updates `FurnitureHit.item` to carry
  `slotId?`/`facing?` from `PlacedFurniture`). Dragging a generated item (`PlanCanvas.tsx:675-692`, `pinDirect` +
  `setPinPos`) therefore produces a pin with `fromSlot`, and the next generation skips the slot: **one desk**. Regression test
  (`editorStore.test.ts` + `procgen/__tests__/pins.test.ts`, enabled in W2): drag a `work-desk` of `DEFAULT_LAYOUT`'s desks room
  by one tile → `generateMap(draft).furniture.filter(kind === 'work-desk').length` equals the count before the drag.
- **Delete** (`shortcuts.ts` `delete`): on a generated item → `suppressSlot(roomId, pinFromPlaced(item) + { suppressed: true })`
  (one commit) and the item disappears from the next preview; on a free pin → `releasePin` as today; on a suppressed ghost
  → `restoreSlot` (removes the suppression). Ghosts are drawn as a dashed outline with the glyph at 40 % alpha, hit-testable
  (so Del/restore and the inspector work), never movable.
- `FurnitureSelection` gains `{ roomId; pinIndex }` for ghosts as well (they are pins); the Inspector shows "Removed from
  generation · Restore".

### 6.2 Rotate (R)

`shortcuts.ts`: `R` → `rotate` action (the editor is a modal context; the global `R` = Roles hotkey is already suppressed
under the open planner, `OfficeEditor.tsx` key handler). `editorStore.rotatePin(roomId, index)`: `facing = nextFacing(kind,
facing ?? 's')`, footprint via `footprintFor`, re-clamped with `clampPinPos` and refused by `pinFits` (the pin stays) when the
rotated rect does not fit; one commit. On a generated item: materialise (`lockFurniture` with `fromSlot`) then rotate, one
commit (`beginGesture`/`endGesture`). The inspector gets a "Facing: N E S W" segmented control (disabled for fixed kinds).

### 6.3 Palette

`FurniturePalette.tsx` (toolbar popover of the Furniture tool): `PALETTE_KINDS: { kind, w, h, label }[]` (chair, work-desk 2x1,
table 2x1, sofa 3x1, armchair, rug 3x2, plant, lamp, bookcase 2x1, cabinet, crate, bin, bench 2x1, counter 2x1, board 2x1,
notice-board, roster-board, arcade, ping-pong 2x1, foosball 2x1, board-game-table 2x1, water-cooler, coffee-machine, printer,
filing-cabinet, fridge). Picking a kind arms `placing: { kind, w, h }` in the store; the next click in a room's interior
calls `addPin(roomId, { kind, x, y (snapped halves), w, h })` (a free pin; refused with the existing hint when it does not
fit or the cap is reached); Esc disarms. Builtin layouts stay read-only.

### 6.4 Snap guides (`features/editor/snap.ts`, pure)

```ts
export interface SnapResult { x: number; y: number; guides: { axis: 'x' | 'y'; at: number }[] }
/** Snaps a dragged rect's edges/centre to other items' edges/centres and the interior edges within `tol` (0.5 tile), after the half-tile snap. */
export function snapRect(rect: Rect, others: readonly Rect[], interior: Rect, tol?: number): SnapResult;
```

`PlanCanvas` applies `snapRect` inside the furniture drag (after `clampPinPos`), draws the guides as 1-px cyan lines for
the frame, and ignores guides while Alt is held (free placement).

### 6.5 Schematic glyphs and labels (`features/editor/glyphs.ts`)

`kindGlyph(kind): string` (one or two characters: desk `▭`, chair `⌐`, table `▢`, sofa `⊏`, plant `♣`, lamp `♀`, board `▬`,
bookcase `▤`, rack `▥`, arcade `◧`, …; a tested exhaustive map) and `kindLabel(kind)` (`Inspector.tsx:272`'s existing
label, moved here and shared). `PlanCanvas` draws the glyph centred in every item at `T >= 12`, the label under it at
`T >= 20` (clipped to the rect), and a small facing triangle on the facing side for rotatable kinds. Pins keep the padlock.

### 6.6 Store API additions

```ts
suppressSlot(roomId: string, pin: PinnedFurniture): void;      // commit; pin has fromSlot + suppressed
restoreSlot(roomId: string, index: number): void;              // commit; removes the suppressed pin
rotatePin(roomId: string, index: number): void;                // commit; refused when it does not fit
addPin(roomId: string, pin: PinnedFurniture): void;            // commit; palette placement (free pin)
placing: { kind: string; w: number; h: number } | null; setPlacing(p): void;
```

`prunePins` keeps suppressed pins unless their rect left the interior (then they are dropped like any pin). `planLockAll`
copies `slotId → fromSlot` so "Lock all" never duplicates either.

---

## 7. Perf budgets and test plan

Budgets (`generate.perf.test.ts`, existing; `pnpm test:perf`): ceilings unchanged; F5's hand-off records the 128 x 96
median before and after (target ≤ +30 %). Painter tests are unit tests (no budget). Editor: `snapRect` with 48 others ≤ 0.05 ms
(plain unit assertion, not a perf test).

1. `harmony.test.ts` (F1): every `GROUPS` member kind is a `FurnitureKind` and supports its facing; `rotateGroup` keeps
   relative geometry (rotating four times is the identity); `anchorCandidates` positions keep front strips and aprons free;
   `OccupancyGrid` matches `rectsIntersect` on 200 random half-aligned rects; `scoreCandidate` components in [0, 1], reach 0
   when a seat is walled off, symmetry 1 for a mirrored arrangement; `bestCandidate` deterministic and stream-offset stable
   (consuming a slot changes no other candidate's draws); `relocate` prefers the group move, stays within 3 tiles, keeps
   the facing and wall contact.
2. `furnish.test.ts` (F1, re-baselined): the M8 8n coverage bands per density still hold on `DEFAULT_LAYOUT` and 100 BSP
   seeds; every room type produces its required kinds (lounge: sofa + table + counter + at least one amenity; entrance:
   reception-desk; server-room: rack-row + console; meeting: table + chairs on every ring tile + board; library: shelf-stack +
   reading-table; desks: chairs facing their desk); chairs sit exactly on their seat tiles; lamps within 1 tile of a seat or
   corner; `wall-art`/`banner` only on wall-adjacent cells; rugs never on aprons; `decorateRoom` per-item stability (removing
   one eligible cell moves at most that one item).
3. `slots.test.ts` (F1): slot id format; stability across regeneration, across `furnish.seed`, under consumption.
4. `pins.test.ts` (F5): `fromSlot` consumes (one desk after a drag; 100 seeds x 1-3 dragged items: `count(kind)` unchanged);
   `suppressed` removes exactly its slot; apron pins kept + `pinned-blocks`; displaced items relocate (count of blocking
   items after pinning a foreign item onto a slot drops by at most 1 per pin); `facing` emitted; stale `fromSlot` ignored.
5. `shapes.test.ts` (F2): the table of §4.1; `insetFor` rotation; navigation.md properties 1, 5, 6, 10 (+ a desk fixture: a
   cat passes under a desk's chair side, a person does not).
6. Painter harness (F3/F6): §5.1 bounds for every kind x fractional footprint x facing; `s` byte-identity; rift exhaustive.
7. Editor (F4): drag writes `fromSlot`; Del on generated → ghost; Del on ghost → restore; R cycles facing with w/h swap and
   refuses when it does not fit; palette places a free pin and respects the cap; `snapRect` cases; glyph map exhaustive over
   `FurnitureKind`; undo/redo of each new action; a draft never fails `validateLayout` (suppressed pins exempt).
8. PM smoke (`?demo=1` + the planner): rooms in all three styles look grouped (desk + chair + lamp; sofa + coffee table + rug;
   meeting table with chairs all round + a board on a wall); drag a desk → one desk; Del → gone; R → rotated chair; palette →
   a plant in a corner; snap guides appear; cat walks under a desk; `pnpm test:perf` green.

---

## 8. Tasks

The owned-files tables (W0-F, F1-F6, PM, Gate) live in **lighting.md §8** together with the lighting tasks so the per-wave
file ownership is visible in one place. Summary of the furnishing lane:

| id | wave | role | depends on | delivers |
|---|---|---|---|---|
| W0-F | 0 | developer (contract) | none | §1 (shared schema, procgen types, `facingSpec.ts`, editor type plumbing) |
| F1 | 1 | developer (procgen) | W0-F | §2, §3.1-3.3, §3.5, §4.3 in `harmony.ts` + `recipes.ts`; tests 1-3 |
| F2 | 1 | developer (nav) | W0-F | §4.1 `KIND_SHAPE` + `insetFor`; test 5 |
| F3 | 1 | developer (themes) | W0-F | §5.1 audit + `paint/facing.ts` + harness; test 6 (bounds) |
| F4 | 1 | developer (editor) | W0-F | §6; test 7 (the duplicate regression enabled after F5) |
| F5 | 2 | developer (procgen) | F1, F2, L3 | §3.4, §3.6, §4.2 gate; `generate.ts`/`pins.ts`; tests 4-5 on 300 seeds; perf before/after |
| F6 | 2 | developer (themes) | F3 | §5.3 facing variants; test 6 (variants) |
| PM | 3 | PM | F5, L4, L5 | no furnishing edits to hot files are needed (the editor and procgen are self-contained); smoke 8 |

---

## 9. Risks and trade-offs

- **Visual churn on existing floors.** Every room is re-arranged once by the harmony recipe (new `furnish.test.ts` baselines
  and a one-time re-capture of `m15-parity.json`'s furniture half; its `walkable`/nav parity half stays). Pins survive (they
  are absolute), but a pin with a stale `fromSlot` no longer consumes anything, which is harmless. The CHANGELOG says
  "rooms are re-furnished; locked items stay".
- **Slot ids depend on the plan.** A room resize changes the plan and may renumber slots; the user's `fromSlot` then points
  nowhere and the recipe places the slot's item again next to the pin (the old duplicate, once, until they drag again or
  press Del). Accepted: resize already prunes pins today. Mitigation: the plan numbers groups by `(group, instance,
  member)` and instances by row order, so a *wider* room keeps the first rows' ids.
- **K candidates and the budget.** The flood fill per candidate is the cost; at `packed` (K = 6) on 64 rooms it is about
  64 x 6 x 0.1 ms. If the measured median exceeds +30 %, drop `CANDIDATES` by one across the board before anything else.
- **Canvas rotation in painters.** `rotateCanvas` on `Graphics` is well supported but rarely used in this codebase; F3
  proves it on both renderers in the harness (recorded commands) and in a browser screenshot before F6 relies on it.
  If a renderer mis-draws, the fallback is explicit variants for the rotation-safe tier (more painter code, no contract change).
- **Insets vs. seats.** A desk inset frees the chair-side half tile; a seated person's feet already sit on the chair tile,
  so nothing moves. A `small` creature may now walk "through" a desk's chair gap during a meeting; cosmetic.
- **Apron pins kept.** A blocking pin over an auto-door apron now seals that door on purpose (the spec); the warning and the
  reachability overlay make it visible, and the editor still refuses explicit aprons. If users hit it, the one-click fix is
  "move the door".
- **Half-tile sizes in the editor.** Sizes are only produced by the palette (whole) and by recipes (halves on rugs/lamps);
  the Inspector shows `2.5` via `fmtTile`. No resize handles for furniture in M16.
- **Facing on the Receptionist desk.** `reception-desk` stays `s`-only, so `pickReceptionistSpot`/`isReceptionDeskTile` and
  the desk-front cut in `OfficeScene` are untouched.
