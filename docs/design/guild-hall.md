# M7 design: Magic Guild Hall (styles, office editor, procedural floors, stairs)

Status: approved for build (7b to 7e). Contract: `packages/shared/src/layout.ts` plus additive fields in
`domain.ts`, `settings.ts`, and `socket.ts`. This doc is the spec. When code and doc disagree, the shared contract wins.

## 1. Decisions and trade-offs

| # | Decision | Why |
|---|---|---|
| D1 | `office.style: 'modern' \| 'guild'`, **default `guild`**. It is separate from lighting `office.theme` (day/night/auto). A layout may override it with `layout.style`. | The user asked for the guild "instead of" the office style, so it is the new face of the product. `modern` stays one click away. The default is a settings default, so a user can pin `modern` in `config/office.yaml`. |
| D2 | **Geometry does not depend on style.** The map is `generate(layout)`: walls, doors, corridors, furniture footprints, and seats depend only on the layout and its seed. The style only paints. | Switching skins never moves characters or seats, and 7c (procgen) and 7d (themes) can be built in parallel against one type file. A theme may add purely decorative, non-blocking pixels with its own seeded RNG. |
| D3 | **Stairs are a room type (`stairs`)**, not a separate entity. | One editor gesture (draw a rectangle, pick a type), one validation path, and one data shape. The generator puts an up and a down staircase inside every stairs room. Rule: 1 to 4 stairs rooms per layout. |
| D4 | The room rectangle is the **footprint including walls**. Walled rooms may share a 1-tile wall with each other or with the outer wall. Rule: no room's interior may intersect another room's footprint. | "What you draw is what you get." Shared walls let the classic office be expressed exactly (see `DEFAULT_LAYOUT`). |
| D5 | `background: 'hall' \| 'void'`. `hall` means tiles outside any room are walkable open floor (the classic office). `void` means they are solid rock and the generator carves corridors (`corridorWidth` 1 to 3). | `hall` covers today's open-plan office. `void` gives dungeon-like guild keeps from a few drawn rooms. |
| D6 | Zones stay exactly as they are (`ZONES` is unchanged, and nothing that is `Record<Zone, …>` breaks). Room types are `ZONES + 'stairs' + 'hall'`. A zone without a room resolves through `ZONE_FALLBACKS` (the chain always ends at `entrance`, which is required). | The server activity rules and the agent `zone` field are untouched. Layouts are purely a web and render concern plus persistence. |
| D7 | Several rooms of the same type are allowed (two workshops, for example). Their seats are merged into the zone. Exactly one `entrance`. | Big floors need more desks. A single spawn point keeps walk-in and walk-out semantics. |
| D8 | `office.zones` is **deprecated** and ignored by the layout renderer. The field is kept, not renamed. | The office editor replaces it. 7e updates the settings hint text. |
| D9 | Layouts are global (not per project). A project references one with `Project.layoutId?`. Unset or unknown falls back to `office.defaultLayoutId`, then to `DEFAULT_LAYOUT`. Builtin layouts are read-only; "Duplicate" gives an editable copy. | Reuse one layout across many floors. A project never ends up without a map. |
| D10 | Floor order for the stairs is `office.floorOrder` (default `created`: the oldest project is the ground floor). | Today's picker sorts by `lastActivityAt`, which would reshuffle the building while you climb it. |

## 2. Contract (written, in `packages/shared`)

- `layout.ts`: `OFFICE_STYLES`, `ROOM_TYPES`/`RoomType`, `isZoneRoomType`, `DEFAULT_WALLED_ROOM_TYPES`,
  `ROOM_MIN_INTERIOR`, `ZONE_FALLBACKS` + `resolveZone`, `LAYOUT_LIMITS` (grid 16..128 x 12..96, max 64 rooms,
  max 4 stairs), `LayoutRoomSchema`, `OfficeLayoutInputSchema` / `OfficeLayoutSchema` (`id, name, width, height,
  seed, background, corridorWidth, rooms, style?, builtin, createdAt, updatedAt`), `LayoutIssue` (+ codes),
  `roomInterior`, `isRoomWalled`, `rectsIntersect`, **`validateLayout(geometry): LayoutIssue[]`**, `hasLayoutErrors`,
  `DEFAULT_LAYOUT_ID = 'default'`, `DEFAULT_LAYOUT` (the pre-M7 office plus a 3x3 stairs landing at (27,25); it validates
  with zero issues), `LayoutAssignSchema`.
- `domain.ts`: `Project.layoutId?: string`, `OfficeSnapshot.layouts?: OfficeLayout[]`.
- `settings.ts` (`office`): `style` (guild), `defaultLayoutId` ('default'), `floorOrder` ('created'),
  `floorTransitionMs` (600, 0..3000), `ambientEffects` (true). None are restart-required or GUI-immutable.
- `socket.ts`: server to client `layout:upsert`, `layout:remove`. Client to server `layouts:list|get|save|delete|assign`.

Validation rules (errors unless noted): grid bounds; room count; unique ids; footprint inside the grid and interior
inside the outer wall ring; no interior/footprint intersection; interior at least `ROOM_MIN_INTERIOR[type]`; exactly one
entrance; 1 to 4 stairs. Warnings: `entrance-not-on-edge` (no front door is drawn) and `zone-missing` (the message lists the fallback).
The generator adds `no-door` and `unreachable-room` (errors) and `unreachable-seat` (warning). The editor blocks **Save** on any
error from either source. The server can only check geometry, which is enough for safety because the generator always
produces some map.

REST (7b; errors use the standard `{ error, statusCode, details? }`, and on validation failure `details` is `LayoutIssue[]`):

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/layouts` | | `OfficeLayout[]` (builtins first, then by name) |
| GET | `/api/layouts/:id` | | `OfficeLayout` or 404 |
| POST | `/api/layouts` | `OfficeLayoutInput` (no id) | 201 `OfficeLayout` (id = slug(name) plus a 4-hex suffix) |
| PUT | `/api/layouts/:id` | `OfficeLayoutInput` | `OfficeLayout` (create or replace; 409 if builtin; body id must match or be omitted) |
| DELETE | `/api/layouts/:id` | | 204. 409 if builtin. Projects using it get `layoutId` cleared, re-emitted as `project.upserted`. |
| PATCH | `/api/projects/:id` | `{ layoutId: string \| null }` (added to the existing strict patch) | `Project`. 400 if the layout is unknown. |

## 3. Theme model (7d, web-internal: `apps/web/src/game/themes/`)

```ts
// apps/web/src/game/themes/types.ts  (owned by 7d)
import type { Activity, OfficeStyle, RoomType, Zone } from '@tagconn/shared';
import type * as Phaser from 'phaser';
import type { FurnitureKind, GeneratedMap, PlacedFurniture, DecorSlot, TileKind } from '../procgen/types';

export interface Palette { bg: number; floorBase: Record<RoomType | 'corridor', number>; floorAccent: Record<RoomType | 'corridor', number>;
  wallTop: number; wallFace: number; wallEdge: number; void: number; text: string; labelBg: string; transition: number }
export interface Costume { robe?: number; cloak?: number; hat?: 'none' | 'wizard' | 'hood' | 'crown' | 'helm' | 'bard-cap' | 'circlet';
  hatColor?: number; staff?: 'none' | 'staff' | 'wand' | 'hammer' | 'quill' | 'lute' | 'shield'; trim?: number }
export interface ThemeDefinition {
  id: OfficeStyle;
  palette: Palette;
  /** Paint one floor or wall tile into the base texture. `rand` is seeded per tile. */
  paintFloor(g: Phaser.GameObjects.Graphics, kind: RoomType | 'corridor', px: number, py: number, rand: () => number): void;
  paintWall(g: Phaser.GameObjects.Graphics, px: number, py: number, faceVisible: boolean, rand: () => number): void;
  paintVoid(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void;
  /** Static furniture art per semantic kind (drawn into the base texture). */
  paintFurniture(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number): void;
  /** Animated objects (torch flames, cauldron bubbles, portal swirl). Returns objects to destroy on rebuild. */
  animate(scene: Phaser.Scene, map: GeneratedMap, opts: { ambient: boolean }): Phaser.GameObjects.GameObject[];
  decorFor(slot: DecorSlot): string | null;          // texture key for a wall or floor decoration
  zoneNames: Record<Zone, string>; roomNames: Record<RoomType, string>;
  roleTitles: Record<string, string>;                 // by role name; unknown roles keep role.title
  costumes: Record<string, Costume>;                  // by role name; `default` key for unknown roles
  activityVerbs: Partial<Record<Activity, string>>;   // bubble text when the server bubble is generic
  /** Activity effects (particles) attached to a character. */
  activityFx?: Partial<Record<Activity, 'sparkles' | 'bubbles' | 'rune' | 'channel' | 'none'>>;
  lighting: { dayTint: number; nightTint: number; nightAlpha: number; glowAtNight: boolean };
  floorLabel(index: number, projectName: string): string;
}
```

Bubble rule: the server bubble stays the source of truth ("Editing auth.ts"). The theme **prefixes or replaces** only
the generic templates: guild renders `"Inscribing runes · auth.ts"` for `typing`, and uses the plain verb when the bubble
is empty or equals the tool name. Role titles apply only to the built-in role names below. Custom roles show their own
`role.title`.

### Guild mapping

| Zone / room | Guild name | Furniture (semantic kind → guild art) |
|---|---|---|
| entrance | Guild Gate | mat → rune threshold stone; plant → iron braziers (flame) |
| pm-office | Guild Master's Hall | lead-desk → carved oak desk and throne; rug → crimson rug with gold trim; shelf → trophy shelf |
| desks | Artificers' Workshop | work-desk → wooden workbench with candle, parchment, and quill |
| meeting-room | War Council | table → long oak table with map and candles |
| whiteboard | Map Room | board → wall-wide parchment map with pins; centerpiece → brass orrery on a table |
| qa-lab | Alchemy Lab | workbench → bench with coloured flasks; centerpiece → bubbling cauldron (2x2) |
| review-booth | Scribes' Alcove | booth → lectern with open tome and candle |
| server-room | Arcane Vault | rack → crystal pylon (glowing orbs); sigil → rune circle (3x3, walkable); pedestal → crystal ball |
| library | Grand Library | shelf → tall bookcase with coloured spines; armchair → velvet reading chair |
| lounge | Tavern | sofa → long bench; table → tavern table with mugs; counter → barrel with tap; armchair → stool; plant → barrel stack |
| stairs | Portal Stairs | stairs-up → teal swirl portal on a spiral stair; stairs-down → violet swirl portal |
| hall / corridor | Great Hall / Passage | none (decor slots only) |

| Role | Guild title | Costume |
|---|---|---|
| pm | Guild Master | crimson robe, gold trim, crown, staff |
| analyst | Oracle | pale blue robe, circlet, crystal orb held as the staff prop |
| architect | Archmage | deep purple robe, pointed wizard hat with stars, staff with a glowing tip |
| developer | Artificer | leather apron over the role colour, goggles, hammer |
| qa-engineer | Alchemist | green robe, hood, flask (existing prop tinted) |
| code-reviewer | Scribe | brown robe, hood, quill |
| security-engineer | Paladin | silver plate (grey body with highlight), helm, shield |
| devops | Blacksmith | dark apron, bare arms, hammer |
| tech-writer | Bard | teal tunic, feathered bard cap, lute |
| default | Adventurer | role colour cloak, hood |

The robe or tunic is still tinted with `role.color`, so user colours keep meaning. Costume colours are the trim, hat, and cloak.

| Activity | Verb | Activity | Verb |
|---|---|---|---|
| typing | Inscribing runes | running | Channeling |
| testing | Brewing potions | thinking | Pondering |
| searching | Scrying | waiting | Awaiting the Master |
| delegating | Issuing a quest | done | Quest complete |
| reading | Studying tomes | browsing | Consulting the stars |
| meeting | Holding council | blocked | Cursed! Needs aid |
| idle | Resting at the tavern | | |

### Visual recipes (16px tiles, all Graphics then `generateTexture`, no assets)
- **Stone floor**: base `0x4a4458`. Each tile is split into 2 to 4 irregular flagstones by 1px mortar lines (`0x3a3446`), picked by
  `rand`. 1 to 2 lighter speckles (`+8%`) per tile, and a 1px highlight on each stone's top-left edge. Room floors vary the hue:
  workshop is warm wood planks (`0x6b4f3a`, plank line every 4px, staggered seams), library and tavern are dark oak, the vault
  is blue-black stone with faint cyan veins, the alchemy lab is green-grey tiles, and the council room has a checkered
  marble floor.
- **Walls**: the top face (`0x5a5068`) shows ashlar block courses (a 4px row with an alternating 8px/6px brick offset). The visible
  south face is 6px of darker stone (`0x2e283c`) with a 1px lit edge. The outer wall is the same with moss pixels (`0x4d6b3a`) by `rand`.
- **Doors**: an arched wooden door frame on the wall tile with a lighter lintel, drawn open (floor visible).
  The front gate is a 2-tile portcullis arch.
- **Void**: near-black `0x0e0b14` with sparse dim rock noise.
- **Wooden desk / workbench**: a 2x1 top in `0x8a5a2b` with 1px wood-grain lines, a darker front apron of 3px, and legs as 1px
  darker columns. Props on top: a candle (2px wax, 1px flame), a rolled scroll, and an inkpot.
- **Torch** (wall-light decor): an iron bracket (2px), a wooden handle, and a flame of 3 to 4 px in yellow `0xffd84a` over orange
  `0xff8a3a`. It is animated: flame scale and alpha jitter at about 8 Hz from `rand` phase, plus a soft additive circle (radius 20px,
  alpha 0.10 by day and 0.25 at night) for the light pool.
- **Banner** (wall-hanging): a 6x10 cloth in guild crimson or blue (seeded variant) with a gold emblem pixel pattern
  (star, key, or tower) and a notched bottom edge.
- **Rune circle**: a 3x3-tile ring (outer circle, inner circle, 8 rune glyphs of 3x3 px) in cyan `0x6ff5ff`, alpha 0.5. It is animated:
  a slow rotation of a separate glyph texture and an alpha pulse.
- **Cauldron**: a black iron pot (2x2, a 12px-wide ellipse body) on 3 legs, with a green liquid surface and a fire beneath (flicker).
  Bubbles rise as 1 to 2px circles every 300 to 600ms and pop at the top.
- **Bookshelf**: a dark wood frame and 3 shelves of 1-2px spines in 6 seeded colours with random heights, and an occasional skull or candle.
- **Crystal ball**: a stone pedestal plus an 8px sphere (radial light blue to violet), a white specular pixel, and a slow hue shimmer.
- **Tavern barrels**: a 12px barrel (brown staves, 2 grey hoops), with a stacked variant of 3. The counter barrel has a brass tap.
- **Portal stairs**: 3 descending or ascending stone steps (a light-to-dark gradient) under a 12px elliptical portal ring. The inner
  swirl is 3 rotating arcs (up is teal `0x4ff0d0`, down is violet `0xb07aff`), with motes drifting inward. When disabled (no floor
  that way) the ring is grey and nothing moves.
- **Ambient particles** (if `ambientEffects`): dust or magic motes (1px, alpha 0.3, slow drift) across the map, about 1 per 60
  tiles, capped at 150.
- **Characters**: the existing bitmaps gain costume overlays: hat bitmaps (wizard, hood, crown, helm, bard-cap, circlet), a
  cloak strip behind the body, and hand props (staff, wand, hammer, quill, lute, shield) replacing the laptop when not typing.
  Keys follow the pattern `guild-hat-<id>`.

### Magic activity effects (particles attached to the character, off when `ambientEffects` is false)
- `typing`: 2 to 3 gold sparkles (`icon-sparkle` scaled 0.5) that pop above the hands every 250ms, and a faint rune glyph over the desk.
- `testing` (and anyone in the Alchemy Lab): green potion bubbles rising from the flask prop.
- `delegating`: a glowing rune circle (small, 12px) under the feet that pulses and rotates. The scroll prop replaces the clipboard.
- `running`: a channeling aura (a violet additive ring that grows and fades every 800ms).
- `done`: a burst of 8 gold sparkles.
- `blocked`: a red flicker aura.
- Modern theme: `activityFx` is empty (the current look).

The modern theme is a straight port of today's `renderMap.ts` colours, furniture art, and `ZONE_LABELS`, with identity titles and no verbs.

## 4. Procedural generation (7c: `apps/web/src/game/procgen/`, pure TS, no Phaser)

```ts
// apps/web/src/game/procgen/types.ts  (owned by 7c; created FIRST, verbatim, so 7d can code against it)
import type { LayoutIssue, OfficeLayout, RoomType, Zone } from '@tagconn/shared';
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export type TileKind = 'void' | 'floor' | 'wall' | 'door';
export type FurnitureKind =
  | 'work-desk' | 'lead-desk' | 'table' | 'board' | 'workbench' | 'booth' | 'rack' | 'shelf'
  | 'sofa' | 'armchair' | 'rug' | 'mat' | 'counter' | 'plant' | 'centerpiece' | 'pedestal' | 'sigil'
  | 'stairs-up' | 'stairs-down';
export interface PlacedFurniture extends Rect { kind: FurnitureKind; blocking: boolean; roomId: string; roomType: RoomType; variant: number }
export interface Seat extends Point { zone: Zone; roomId: string; kind: 'sit' | 'stand' }
export interface Door extends Point { roomId: string; to: string | 'hall'; vertical: boolean }
export interface StairsSpot extends Point { dir: 'up' | 'down'; roomId: string; /** walkable tile in front, for hover/tooltips */ landing: Point }
export interface DecorSlot extends Point { kind: 'wall-light' | 'wall-hanging' | 'floor-scatter'; roomId: string | null; variant: number }
export interface GeneratedRoom { id: string; type: RoomType; name?: string; footprint: Rect; interior: Rect; walled: boolean;
  seats: Seat[]; tiles: Point[]; labelAt: Point }
export interface ZoneInfo { zone: Zone; rect: Rect; walled: boolean; seats: Seat[]; tiles: Point[] }   // same shape seats.ts uses today
export interface GeneratedMap {
  layoutId: string; seed: number; cols: number; rows: number; tileSize: number;
  tiles: TileKind[][];                 // [y][x]
  walkable: number[][];                // [y][x] 0 = walkable, 1 = blocked (easystar)
  walls: boolean[][];                  // tiles === 'wall'
  roomAt: (string | null)[][];         // room id for floor tiles; null = hall/corridor
  zoneAt: (Zone | null)[][];
  rooms: GeneratedRoom[];
  zones: Record<Zone, ZoneInfo>;       // every zone present; missing ones alias their resolveZone() target
  furniture: PlacedFurniture[];
  doors: Door[];
  stairs: StairsSpot[];
  decor: DecorSlot[];
  spawn: Point;                        // inside the entrance
  frontDoor: Point | null;             // outer-wall gate tile (visual only)
  issues: LayoutIssue[];               // generation issues (validateLayout issues are included too)
}
export function generateMap(layout: OfficeLayout): GeneratedMap;                        // procgen/generate.ts
export function generateRandomLayout(opts: { width: number; height: number; seed: number;
  background?: 'hall' | 'void'; name?: string }): import('@tagconn/shared').OfficeLayoutInput;  // procgen/bsp.ts
```

**RNG**: `mulberry32` (`procgen/rng.ts`) with sub-streams `rngFor(seed, label) = mulberry32(seed ^ fnv1a(label))`
(labels such as `room:<id>`, `doors`, `decor`). Editing one room does not reshuffle the others. Same layout gives a
byte-identical map (test with `JSON.stringify` equality).

**Algorithm** (`generate.ts`):
1. `issues = validateLayout(layout)`. If there are errors, generate `DEFAULT_LAYOUT` instead and return its map with the original
   issues (the scene never crashes on a bad layout).
2. Grid: fill with `floor` for `hall`, otherwise `void`. The outer ring is `wall`.
3. Stamp rooms in array order: interior tiles become `floor` with `roomAt = id`. For walled rooms the footprint ring becomes `wall`. Open rooms
   only stamp floor. Validation guarantees that stamps never conflict except on shared walls, which stay walls.
4. **Regions**: each walled room is a region. Connected floor areas that are not in a walled room (hall tiles plus open rooms,
   found by flood fill) are regions too. Open rooms therefore join the hall they touch.
5. **Door candidates** between regions A and B: a wall tile `w` in A's ring (not a ring corner) with A-interior on one side and
   B floor on the opposite side (1-thick). A double wall (two adjacent walled rooms, each with its own ring) is also allowed: two
   aligned wall tiles, giving a 2-deep door. Group the candidates by (A, B, side) into spans.
6. **Connectivity**: build an edge list: each span is an edge with weight `1 + rand()*0.1`. In `void` mode, also add
   corridor edges between every region pair within the 4 nearest neighbours by centre distance (weight = Manhattan
   distance). Kruskal gives an MST. Then add about 15% of the remaining adjacency edges (seeded) for loops. For each chosen edge:
   - adjacent span: door in the middle of the span with ±1 jitter. Width 2 if the span is at least 4, else 1. Never place a door within 1 tile of an
     existing door on the same wall.
   - corridor edge: choose door tiles on the facing walls of both rooms (outside tile must be `void`), then run A* over `void`
     tiles (cost 1, +2 next to walls to centre corridors; walls and interiors are impassable). Carve `corridorWidth` wide
     `floor` (`roomAt = null`). If this fails, try the next candidate pair (at most 4). If all fail, record `no-door` (error) for the room.
7. **Front gate**: if the entrance interior touches the outer ring, `frontDoor` = the ring tile at the centre of the touching edge
   (prefer bottom, then left, right, top). It is visual and not walkable.
8. **Furniture** per room from `recipes.ts` (a generalised version of today's `furnish()`, by room type, working on the interior
   rect, with `variant` from the room stream). **Door aprons** (the interior tiles directly inside each door, door width x 1) are
   reserved: no blocking furniture and no seats there. An item is placed only if every cell is interior floor, free, and not reserved.
   After each room, flood fill from its door aprons inside the room. If any recipe seat or more than 10% of the floor is unreachable,
   remove the last blocking item and retry (bounded by the item count).
9. **Stairs**: in each stairs room, `stairs-up` and `stairs-down` are placed as 1x1 blocking items on the interior's top row,
   centred and side by side. Their `landing` is the tile below each one. Stairs rooms get no seats.
10. **Spawn**: in the entrance interior, the walkable tile nearest the front gate (else nearest the interior centre).
11. **Verify**: BFS from spawn. For each zone room, `tiles` = reachable interior tiles. Recipe seats that are unreachable are dropped
    (`unreachable-seat` warning). If fewer than 12 seats remain, add reachable tiles as `stand` seats. A room with 0 reachable tiles
    gets `unreachable-room` (error).
12. **Zones**: merge the seats and tiles of all rooms per zone. `rect` = the first room's interior. Zones with no room alias the
    `ZoneInfo` of `resolveZone(zone, presentTypes)`.
13. **Decor**: wall tiles whose south neighbour is floor get alternating `wall-light` and `wall-hanging` every 4 tiles
    (seeded offset, skipping door neighbours). Add 0 to 2 `floor-scatter` per room on free, non-reserved tiles.

Budget: 128x96 with 64 rooms in under 50ms (enforced in a vitest perf test at under 150ms to avoid flakiness).

**"Surprise me" BSP** (`bsp.ts`): take `rng = mulberry32(seed)` and recursively split the rect `(0,0,W,H)`. Choose the axis by aspect
ratio (split along the long side; if within 1.25 either way, pick at random) at 35 to 65%. Stop at leaf sizes of 7x6 to 16x12. In `hall`
mode each leaf's room is the leaf shrunk by 1 on the sides shared with a sibling, which leaves 2-tile halls. In `void` mode it is shrunk by 1 to 3 at random per side.
Type assignment: the entrance is the leaf touching the bottom edge nearest the centre (it is made open). Stairs is a 4x4 open room
carved at a corner of the entrance's neighbouring hall leaf, or the smallest leaf. The remaining leaves are sorted by area and filled in the order
desks (largest), meeting-room (at least a 7x7 interior), library, lounge, pm-office, qa-lab, review-booth, server-room, whiteboard. Extra leaves become
desks, lounge, or hall. Walled or open follows `DEFAULT_WALLED_ROOM_TYPES`. Run `validateLayout` and `generateMap`. On any error, retry
with `seed + k` (k at most 20). If it still fails, return `DEFAULT_LAYOUT` resized, or unchanged if it does not fit. Room ids are `r1..rn`.

## 5. Office editor UX (7e: `apps/web/src/features/editor/`)

Open it from a new TopBar button "Edit floor" (and from the FloorManager row menu). It is a full-screen modal with a left tool rail, a centre canvas,
a right inspector, and a bottom issue list.
- **Canvas**: an HTML `<canvas>` 2D plan (not Phaser), zoomable and pannable, with a tile grid and ruler. Rooms are drawn as tinted rectangles per
  type with name labels. Walls, doors, corridors, furniture blocks, seats (dots), and stairs arrows come from `generateMap(draft)`,
  debounced by 120ms, so the plan shows the real generated result.
- **Tools**: Select (V), Room (R), Stairs (S = Room tool with the type preset to stairs), Hand (H or Space-drag).
  - Room tool: drag a rectangle (snaps to tiles, shows `w x h`). On release a **room-type picker popover** opens with icons, the style names
    ("Alchemy Lab (qa-lab)"), and 1 to 9 or 0 hotkeys. Esc cancels the new room. Hall/open/walled defaults follow the type.
  - Select: click to select (Shift+click adds). Drag the body to move. Drag the 8 handles to resize. Arrows move by 1 (Shift+arrows by 5),
    Alt+arrows resize. Del or Backspace deletes. Ctrl/Cmd+D duplicates. The inspector edits type, name, walled, and exact x/y/w/h.
- **Live validation**: `validateLayout` plus generator issues are listed below the canvas. Clicking an issue selects and
  flashes `roomIds`. Rooms with errors get a red outline, rooms with warnings amber.
- **Layout meta**: name, width x height (a resize keeps rooms and flags any that fall out of bounds), background, corridor width,
  seed (with a dice button), and style override.
- **Surprise me**: a button (and Ctrl/Cmd+G) that calls `generateRandomLayout` with the current size and background and a new random seed
  (the seed stays editable, so a result can be reproduced). It replaces the draft as one undo step.
- **Preview**: the P key toggles a styled preview. A small Phaser game with `PreviewScene` renders `generateMap(draft)` through the
  selected theme, with 3 wandering demo characters. Style dropdown: modern or guild.
- **Undo/redo**: `editorStore` keeps an immutable draft history (max 100). A drag or resize gesture is one entry. Ctrl/Cmd+Z undoes;
  Ctrl/Cmd+Shift+Z or Ctrl+Y redoes.
- **Persistence**: Save (Ctrl/Cmd+S) calls `layouts:save`. It is disabled while any error exists, with a tooltip explaining why. Save as / Duplicate,
  Rename, and Delete (with a confirmation that names the floors using it) are also available. "Use on this floor" calls `layouts:assign` for the current project,
  and "Reset floor to default" assigns null. Builtins open read-only with a "Duplicate to edit" banner. A dirty draft prompts before close.
- **Other keys**: `?` shows a shortcut sheet. Esc closes the popover, then clears the selection, then closes the editor.
- In `?demo=1` mode, layouts live in `localStorage` (the same API surface is mocked in `lib/mock.ts`).

## 6. Stairs and floor transitions (7e)

- **Floors**: `floorsInOrder(projects, floorOrder, selectedId)` is a pure helper in `lib/floors.ts`. It returns non-archived projects
  (plus the selected one if it is archived) sorted by `created` (createdAt asc), `name`, or `recent`. Index 0 is the ground floor. The
  guild label is `"Floor N · <name>"` via `theme.floorLabel`.
- **Scene input**: `OfficeState` gains `layout: OfficeLayout`, `style: OfficeStyle`, and `floor: { index: number; count: number;
  above?: { id: string; name: string }; below?: { id: string; name: string } } | null` (null in "All floors").
  Stairs sprites are interactive. Hover shows a glow plus a tooltip ("Up to Floor 3 · api-server"). Click emits
  `scene.events.emit('stairs', 'up' | 'down')`. When there is no floor in that direction the portal is grey and the click does nothing.
  A nice-to-have: the stairs show a small count badge of agents on the neighbouring floor, red if any of them is `waiting`.
- **Hotkeys** (global, ignored when focus is in an input, textarea, select, or contenteditable, or while the editor is open):
  PageUp is floor up and PageDown is floor down. Home goes to the ground floor. End goes to the top floor. `F` opens the floor picker
  (the FloorManager list as a popover). The same actions exist as buttons in the top bar next to the floor name.
- **Transition** (`floorTransitionMs = T`; `prefers-reduced-motion` or T = 0 means instant):
  1. Lock input and play the portal effect at the clicked stairs (a burst of 12 motes toward the portal, guild only).
  2. `cam.fadeOut(T/2, theme.palette.transition)` with a slight zoom (x1.06) and a scroll of 12px up when going up, down when going down.
  3. On fade complete, call `selectProject(next)`. React re-renders and `setOfficeState` gets a new `floorKey` and layout. The scene
     rebuilds the world if the layout key changed (`layout.id + updatedAt + style`). Characters are recreated instantly (the existing
     `floorKey` path).
  4. `cam.fadeIn(T/2)` from the opposite scroll offset. A React toast shows "Floor 2 · tagconn" for 1.5s.
- **Characters never change floors.** They belong to their project's floor. Only the viewer moves. New agents on other
  floors appear only in the roster (and the stairs badge).
- **"All floors" mode (`*`)**: renders `office.defaultLayoutId` with every agent merged (today's behaviour). Clicking any stairs opens the
  floor picker. PageUp and PageDown go to the ground floor. The top bar shows "All floors".
- **Live layout edits**: `layout:upsert` for the current floor's layout, or `project:upsert` with a new `layoutId`, rebuilds the world
  without a transition. Characters are re-seated instantly (the existing `rebuild` path).

## 7. Server `layouts` module (7b)

- Standard module files. SQLite table `layouts(id TEXT PK, name TEXT, data TEXT JSON, builtin INTEGER, created_at INTEGER,
  updated_at INTEGER)`. `data` holds `{width,height,seed,background,corridorWidth,rooms,style}`, parsed with `OfficeLayoutSchema`
  on read. Rows that fail parsing are skipped with a warning log. Add a nullable `projects.layout_id TEXT` column.
- On boot, upsert `DEFAULT_LAYOUT` as builtin (always overwritten with the shipped version, keeping `createdAt`).
- The service validates with `OfficeLayoutInputSchema` and then `validateLayout`. If there are errors: `badRequest('Invalid layout', issues)` over REST
  and `{ ok:false, error: issues.map(i => i.message).join('; ') }` over the socket. Bus events `layout.upserted` and `layout.removed`
  are broadcast by `core/realtime` to **all** clients (`office.emit`, not per room). `snapshot` includes `layouts`.
- Delete: 409 for builtins. Clear `layoutId` on the projects that use it (emit `project.upserted` for each). Assigning an unknown
  layout id gives 400. `office.defaultLayoutId` pointing at a missing layout falls back to `DEFAULT_LAYOUT` on the client (no server error).
- Security: REST writes go through the existing Origin/Host/JSON-only guards (add routes to the regression test). Body size is bounded by the
  schema (at most 64 rooms, names at most 80 characters, fields are ints). Names are rendered as text only (React or Phaser Text), never as HTML.
  No file-system access.

## 8. Work breakdown

7b, 7c, and 7d are file-disjoint and can run in parallel once wave 2 has landed in the relevant app. 7e integrates them.

**7b. Server layouts** [developer: server]. Depends on 7a and the wave 2 server work.
Owns: `apps/server/src/modules/layouts/**` (new), `apps/server/src/modules/projects/{projects.schema,projects.service,projects.repository,projects.routes}.ts`,
`apps/server/src/modules/snapshot/**` (add `layouts`), `apps/server/src/core/db/{schema,migrations}.ts`,
`apps/server/src/core/event-bus/*.ts` (event types), `apps/server/src/core/realtime/index.ts` (2 broadcasts), `apps/server/src/core/di/index.ts`,
`apps/server/src/app.ts` (register), `apps/server/src/core/http/__tests__/security.test.ts` (add cases), `config/office.yaml` (document `office.style` etc.).
Acceptance criteria:
- CRUD over REST and socket works as specified in section 2, and saving an invalid layout returns 400 with `LayoutIssue[]` in `details`.
- The default layout is seeded, read-only, and cannot be deleted.
- `PATCH /api/projects/:id {layoutId}` sets and clears the layout, and the project is re-broadcast.
- Deleting a layout clears it from the projects that used it.
- The snapshot contains `layouts`.
- Layout routes are covered by the Origin, Host, and JSON-only tests.

Tests: vitest service and route tests (create, replace, 409 builtin, 404, 400 issues, delete cascade, assign unknown gives 400); socket ack
tests; a migration test on an existing pre-M7 DB; security tests (foreign Origin on POST and PUT gives 403).

**7c. Procgen engine** [developer: web A]. Depends on 7a and the wave 2 web work.
Owns: `apps/web/src/game/procgen/**` (new): `types.ts` (FIRST, verbatim from section 4), `rng.ts`, `generate.ts`, `regions.ts`, `doors.ts`,
`corridors.ts`, `recipes.ts`, `bsp.ts`, `index.ts`, `__tests__/*.test.ts`.
Acceptance criteria:
- `generateMap(DEFAULT_LAYOUT)` yields all 10 zones with seats, 0 errors, and at least the current map's seat counts per zone (±20%).
- Every seat is reachable from spawn, and every door touches floor on both sides.
- Output is deterministic: the same input gives an identical JSON result.
- Moving one room leaves the furniture of the other rooms unchanged.
- In `void` mode, corridors connect all rooms.
- `generateRandomLayout` has 0 errors for seeds 1..300 at 32x24, 48x30, 64x48, and 128x96, in both backgrounds.
- The perf test passes.

Tests: unit tests per step (region detection, door spans incl. double walls, corridor A*, apron reservation, fallback zones),
property tests over the seeds above (BFS reachability of all seats and stairs landings, no blocking furniture on doors or aprons),
and an invalid layout, which must return the default map plus its issues.

**7d. Theme system** [developer: web B]. Depends on 7a and 7c's `procgen/types.ts` (verbatim from this doc, so work can start immediately).
Owns: `apps/web/src/game/themes/**` (new): `types.ts` (section 3), `modern.ts` (a port of today's `renderMap.ts` art and labels),
`guild.ts`, `paint/*.ts` (floors, walls, furniture, decor), `costumes.ts` (hat, cloak, and prop bitmaps), `fx.ts` (particle helpers),
`verbs.ts` (`themedBubble(theme, activity, bubble, tool)`), `renderTheme.ts` (`renderGeneratedMap(scene, map, theme)` gives the base texture key), `index.ts`
(`getTheme(style)`), `__tests__/*.test.ts`.
Acceptance criteria:
- Both themes implement every `FurnitureKind`, every `RoomType` floor, and all zones, room names, and built-in role titles (a type-level
  exhaustive `Record`).
- The guild art matches the recipes in section 3, uses no asset files, and `ambientEffects: false` creates no tweens or particles.
- `themedBubble` follows the bubble rule.
- The modern theme renders the default layout visually equivalent to today's office.

Tests: pure unit tests (titles, verbs, `themedBubble`, costume lookup incl. `default`, exhaustiveness). Painter smoke tests call the
painters against a stub Graphics object that records the calls, so every kind is drawn and nothing throws.

**7e. Editor, stairs, and integration** [developer: web]. Depends on 7c and 7d.
Owns: `apps/web/src/features/editor/**` (new: `OfficeEditor.tsx`, `PlanCanvas.tsx`, `RoomTypePicker.tsx`, `Inspector.tsx`,
`IssueList.tsx`, `PreviewScene.ts`, `shortcuts.ts`), `apps/web/src/stores/editorStore.ts` (+ test), `apps/web/src/stores/layoutStore.ts` (+ test),
`apps/web/src/lib/floors.ts` (+ test), `apps/web/src/lib/{api,socket,mock}.ts`, `apps/web/src/game/scenes/OfficeScene.ts`,
`apps/web/src/game/seats.ts` (retype to `GeneratedMap`), `apps/web/src/game/actors/Character.ts` (costume layers, fx hooks),
`apps/web/src/game/textures.ts`, `apps/web/src/game/OfficeGame.ts`, `apps/web/src/features/office/{OfficeView,FloorManager}.tsx`,
`apps/web/src/app/{App,TopBar}.tsx`, `apps/web/src/features/settings/meta.ts` (enum options for `office.style` and `office.floorOrder`, hints, the `office.zones`
deprecation). `game/map/officeMap.ts` and `renderMap.ts` are deleted or reduced to re-exports once unused (their tests move into procgen parity tests).
Acceptance criteria:
- Drawing a room, picking a type, moving, resizing, deleting, undo/redo, Surprise me, preview, save, duplicate, rename, and assign all work
  against the server and in demo mode.
- Save is blocked while errors exist.
- The stairs up and down move between floors in `floorOrder` with the transition, and are disabled at the ends. PageUp, PageDown, Home, End, and F work,
  and are ignored in inputs.
- "All floors" behaves as specified in section 6.
- Switching the style re-skins without moving characters.
- Guild titles, costumes, verbs, and fx are visible.

Tests: reducer tests (editorStore: draw, move, resize, delete, undo coalescing; layoutStore upsert and remove), `floorsInOrder` and next/prev
resolution, the hotkey guard, seats on `GeneratedMap`, and a manual QA script in the PR (both styles, a 3-floor demo, reduced motion).

**7f. Review, security, and QA** [code-reviewer, security-engineer, qa-engineer] in parallel, then a docker rebuild.

## 9. Risks and open points
- Character costumes add draw calls. Keep them to at most 2 extra images per character, and pool the particles (limits in `fx.ts`).
- Very dense layouts can yield `unreachable-room`. The editor blocks saving them, and the server accepts them (geometry-valid),
  but the generator still renders them without crashing.
- A future `Project.floor` (manual floor number) could replace `floorOrder`. It is out of scope.
- Per-room door hints (`doors?: side[]`) are a possible later extension of `LayoutRoomSchema`. It would be additive and optional.
