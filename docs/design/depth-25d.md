# Deep 3/4 RPG renderer (2.5D): y-sorted furniture, 4-direction characters, follow camera (M17 → v1.0.0)

Status: approved for implementation (architect, 2026-10-02) · Plan: `~/.claude-sessions/profiles/ilomon/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md`
section "M16: Deep 3/4 RPG renderer (2.5D)" (now M17) · ADR #31 (supersedes the "furniture baked at -10" rule of
`docs/design/back-wall.md` §1 and the "one base texture holds all furniture" part of #22).
Scope: `packages/shared` (`office.camera.*`, `office.depth.*`), `apps/web/src/game/depth/` (new), `game/textures.ts` +
`game/actors/Character.ts` (views), `game/lighting/` (height map, wall shadows), `game/camera/` (follow, snap),
`game/postfx/` (perspective), `features/editor/PreviewScene.ts`, one option on `themes/renderTheme.ts`.
**Not in scope:** isometric projection, three.js, new procgen geometry, new `GeneratedMap` fields (§1.3 says why).

Read first: `docs/design/back-wall.md` §1 (face tiles, the old depth invariant), `docs/design/lighting.md` §2.3/§2.6/§3.5
(`KIND_HEIGHT`, occluders, shadows, depth table), `docs/design/furnishing.md` §5 (painter contract, facing tiers),
`docs/design/dual-grid.md` §0 (invariants 1, 3, 5), `docs/decisions.md` #22, #29, #30.

User decision (2026-10-02): 2.5D = "deep 3/4 RPG". Keep the 16 px grid and saved layouts. Characters walk **behind** tall
bookcases and desks and sit **in** chairs; 4-direction characters with walk cycles; a height map feeding the M16 lightmap
and a see-through fade for tall items hiding a character; a smooth follow camera with a deadzone and integer-zoom snapping;
an optional subtle perspective post-shader; the Hall Planner preview on the same sprite path. Breaking = painter API and
visuals; layouts and pins load unchanged.

---

## 0. Goals, non-goals, invariants

**Goals.** The office reads as a deep 3/4 room: a character walking along the back aisle disappears behind the bookcases
and the monitors; a seated character's legs are inside the chair, the backrest in front of them; walking shows a front,
back and side view with a four-frame cycle; a tall cabinet that hides the selected character turns translucent; the
camera follows a character smoothly with a deadzone and snaps to whole zoom levels so pixels stay crisp; a subtle
perspective shader compresses the far rows and hazes the distance; the Hall Planner preview shows the same thing.

**Non-goals (M17).** Isometric or 3D projection; a sprite pack or Tiled import (ADR #22 holds: all art is code-drawn);
4-direction art for NPC creatures (they keep two frames and a flip); hats and props with per-view art (one symmetric view,
shifted); dynamic furniture (items never move at runtime); character shadows falling *on* furniture; a wall see-through
(§5 explains that no wall ever covers a character in this geometry, so there is nothing to fade); server changes.

**Invariants (every task keeps these).**
1. **D2.** Which items become sprites, their depth, their front strips and their heights are keyed by `FurnitureKind` and
   `Facing` only (`game/depth/tables.ts`, `game/lighting/heights.ts`). A style paints; it never decides depth.
2. **One art source.** Sprite frames are painted by the **existing** `ThemeDefinition.paintFurniture` painters, translated
   onto an atlas with `g.save(); g.translateCanvas(); …; g.restore()`. No painter is duplicated or forked; a style change
   repaints the atlas (ADR #22: code-drawn, one texture per theme).
3. **Depth rule.** Baked art (base texture, depth −10) is *flat*: floors, walls, dual edges, the back-wall face and decor,
   doors, furniture with `KIND_HEIGHT = 0`, and the whole art of *sit-in* kinds. Everything with a height is a y-sorted
   sprite at `depth = baseY − DEPTH_EPSILON` where `baseY = (f.y + f.h) · T` is the footprint's south edge in world px.
   Characters stay at `depth = feet y`. **A character is behind an item iff its feet are north of the item's south edge.**
   The back-wall face keeps its one exception (it is taller than its tile, but nothing walkable is north of it).
4. **Sit-in kinds duplicate pixels, never invent them.** A chair's front strip sprite is a sub-rectangle of the same art
   that is baked under the character; with nobody seated the two copies coincide and nothing changes visually.
5. **Layouts and pins load unchanged.** No `packages/shared/src/layout.ts` change, no procgen output change: `generateMap`
   is byte-identical to v0.10.0 (`m15-parity.json` and every furnish/backWall parity test stay green).
6. **Flags restore the old look.** `office.depth.sprites = false` bakes every item as in v0.10.0 (`renderGeneratedMap` without a
   predicate produces the exact v0.10.0 command stream; the §4 test proves it); `office.depth.fourDirections = false` keeps
   the single front view with the horizontal flip; `office.camera.perspective = 0` and `integerZoom = false` are today's camera.
7. **Lighting is untouched in its contract.** `LightmapLayer` (90 000, multiply), bloom `LightLayer` (95 000), `ShadowLayer`
   (−5) and the camera post pipelines keep their depths and roles (lighting.md §3.5). Sprites live in `[0, worldH)`, under the
   lightmap, so they are darkened like the base texture. The height map *extends* `KIND_HEIGHT`; it does not replace it.
8. **Determinism and budgets.** The sprite plan, the atlas packing and the frame keys are pure functions of
   `(map, settings)`; two builds are identical. Per-frame cost of M17 (see-through + follow + view selection) ≤ 0.5 ms with
   60 characters; the atlas build ≤ 30 ms per style page at 128 × 96; the Multiverse base texture stays ≤ 1920 × 1408; sprite
   count is capped by `office.depth.maxSprites` (§8).
9. **Hot files are PM-only.** `OfficeScene.ts`, `OfficeView.tsx`, `OfficeGame.ts` are wired by the PM in Wave 3 (§11).

---

## 1. Contract (W0)

### 1.1 Settings (`packages/shared/src/settings.ts`, inside `office`)

```ts
/** M17: camera behaviour (docs/design/depth-25d.md section 7). */
camera: z
  .object({
    /** `manual`: only the Follow button follows a character (today). `selected`: selecting a character also starts following it. */
    follow: z.enum(['manual', 'selected']).default('manual'),
    /** Fraction of the safe viewport (width and height) the followed character may roam before the camera moves; 0 = always centred. */
    deadzone: z.number().min(0).max(0.8).default(0.3),
    /** Follow smoothing time constant (ms, exponential); 0 = instant. Reduced motion is always instant. */
    followLagMs: z.number().int().min(0).max(2000).default(180),
    /** Snap zoom levels at or above 1 to whole numbers so art pixels stay crisp; below 1 the zoom stays continuous so a floor can still fit a phone. */
    integerZoom: z.boolean().default(true),
    /** Subtle perspective post-shader (far rows compressed, distance haze); 0 = off. WebGL only; keep below 0.3 for exact pointer hits. */
    perspective: z.number().min(0).max(1).default(0.1),
  })
  .prefault({}),
/** M17: depth rendering (docs/design/depth-25d.md): y-sorted furniture sprites, see-through, 4-direction characters. */
depth: z
  .object({
    /** Tall furniture as y-sorted sprites (walk behind bookcases and desks). Off = every item baked flat, the v0.10 look. Seat front strips always render. */
    sprites: z.boolean().default(true),
    /** Alpha of a tall item while it hides a character (1 = no fade). */
    seeThrough: z.number().min(0).max(1).default(0.45),
    /** Fade in/out time of the see-through, ms. */
    seeThroughFadeMs: z.number().int().min(0).max(1000).default(160),
    /** Cap on furniture sprites per floor; the lowest items past it are baked flat (tall items are kept first). */
    maxSprites: z.number().int().min(0).max(5000).default(1500),
    /** Front, back and side views with walk cycles. Off = the single front view with a horizontal flip. */
    fourDirections: z.boolean().default(true),
    /** Walls cast day shadows onto the floor (length from the wall height and the sun's elevation). */
    wallShadows: z.boolean().default(true),
  })
  .prefault({}),
```

`features/settings/meta.ts`: `ENUM_OPTIONS['office.camera.follow']`, a `KEY_HINTS` line per key (the comments above,
shortened). Not restart-required, not GUI-immutable, no arrays (deep-merge patches work). `config/office.yaml` gets the
commented example block. ROOT `pnpm typecheck` after the change (CLAUDE.md). The `OfficeState` the scene receives already
carries `settings.office`, so no `OfficeState`/`OfficeView` change is needed for these keys.

### 1.2 Depth tables and types (`apps/web/src/game/depth/{types,tables,index}.ts`, W0, verbatim)

```ts
// game/depth/types.ts  (type-only, no Phaser)
import type { Facing } from '@tagconn/shared';
import type { PlacedFurniture, Rect } from '../procgen/types';

/** How an item renders. `baked`: in the base texture only. `sprite`: one y-sorted image, nothing baked.
 *  `sit-in`: the whole art baked AND a front-strip sprite (a character can be inside the footprint). */
export type SpriteClass = 'baked' | 'sprite' | 'sit-in';

/** One y-sorted sprite the scene creates. World px. */
export interface FurnitureSprite {
  item: PlacedFurniture;
  /** Atlas frame (`frameKey(item)`, plus `#strip` for a sit-in strip); many items share a frame. */
  frame: string;
  /** Theme id whose atlas holds the frame (a Multiverse realm uses its project's style). */
  themeId: string;
  /** Top-left of the frame in world px (slot origin minus `SPRITE_MARGIN`, or the strip's own origin). */
  x: number;
  y: number;
  /** South edge of the footprint in world px: `(item.y + item.h) * T`. Depth = `baseY - DEPTH_EPSILON`. */
  baseY: number;
  /** Sit-in strips: the world px rect the strip covers; null for whole sprites. */
  strip: Rect | null;
  /** `kindHeight(item.kind)`; 0 for strips (they never fade and never occlude). */
  height: number;
}

/** A unique frame to paint into a theme's atlas. The slot is the footprint plus `SPRITE_MARGIN`. */
export interface FrameSpec {
  key: string;
  themeId: string;
  /** A representative item: painters read kind, variant, facing, w, h, againstNorthWall, roomType and trigger from it. */
  item: PlacedFurniture;
  /** Slot size in px, margins included. */
  w: number;
  h: number;
}

export interface SpritePlan {
  sprites: FurnitureSprite[];
  /** Items painted into the base texture: height-0 kinds, sit-in whole art, and the overflow past `maxSprites`. */
  baked: PlacedFurniture[];
  frames: Map<string, FrameSpec>;
  /** How many `sprite`-class items were demoted to baked by `maxSprites` (dev log + tests). */
  demoted: number;
}

/** Shelf-packed atlas layout (pure; pages are `ATLAS_WIDTH` wide, heights grow in powers of two up to `ATLAS_MAX_HEIGHT`). */
export interface PackedFrame { key: string; page: number; x: number; y: number; w: number; h: number }
export interface AtlasLayout { pages: { w: number; h: number }[]; frames: Map<string, PackedFrame> }

/** Per-tile bucket of occluding sprites for the see-through test (CSR like `LightIndex`). */
export interface SeeThroughIndex {
  cols: number; rows: number; T: number;
  sprites: readonly FurnitureSprite[];
  start: Int32Array; items: Int32Array;
}
```

```ts
// game/depth/tables.ts  (data + tiny pure helpers; D2: by kind and facing only)
import type { Facing } from '@tagconn/shared';
import type { FurnitureKind, PlacedFurniture } from '../procgen/types';
import { kindHeight } from '../lighting/heights';
import type { SpriteClass } from './types';

/** Kinds a character can be inside: the whole art is baked under them, a south strip is drawn over them. */
export type SitInKind = 'chair' | 'armchair' | 'sofa' | 'booth' | 'bench' | 'reception-desk';
/** Px of the footprint's SOUTH strip that becomes the front sprite, per facing. 0 = no strip for that facing. Tuned by eye in W2 A1. */
export const FRONT_STRIP_PX: Record<SitInKind, Record<Facing, number>> = {
  chair:            { n: 7,  e: 3,  w: 3,  s: 0 },
  armchair:         { n: 8,  e: 4,  w: 4,  s: 0 },
  sofa:             { n: 8,  e: 4,  w: 4,  s: 0 },
  booth:            { n: 10, e: 4,  w: 4,  s: 2 },
  bench:            { n: 4,  e: 2,  w: 2,  s: 0 },
  /** The counter front: today's `RECEPTIONIST_DESK_FRONT_DY = 6` cut, i.e. the bottom 10 px (OfficeScene.ts:82, 602). */
  'reception-desk': { n: 10, e: 10, w: 10, s: 10 },
};
/** Px around a footprint a painter may use (overdraw against a north wall is `MAX_OVERDRAW_PX = 12`; shadows poke 2 px; booth backs 2 px sideways). */
export const SPRITE_MARGIN = { top: 16, side: 2, bottom: 2 } as const;
/** Sprite depth = south edge minus this, so a character whose feet sit exactly on the edge row (`y*T + 14` vs `(y+1)*T`) is behind it. */
export const DEPTH_EPSILON = 0.5;
/** Sprites at or above this height take part in the see-through fade (desks and tables do not; bookcases, racks, appliances do). */
export const SEE_THROUGH_MIN_HEIGHT = 10;
export const ATLAS_WIDTH = 1024;
export const ATLAS_MAX_HEIGHT = 2048;

export const isSitInKind = (k: FurnitureKind): k is SitInKind => Object.hasOwn(FRONT_STRIP_PX, k);
/** `sit-in` for the table above, `sprite` when `kindHeight(kind) > 0`, else `baked`. Own-property guarded (`constructor` → `baked`). */
export function spriteClassOf(kind: string): SpriteClass;
/** Everything a painter reads, so equal keys paint identical command streams (property-tested, §9 test 2). */
export const frameKey = (f: PlacedFurniture): string =>
  `${f.kind}|${f.variant}|${f.facing ?? 's'}|${f.w}x${f.h}|${f.againstNorthWall ? 1 : 0}|${f.roomType}|${f.trigger ?? ''}`;
```

### 1.3 No new `GeneratedMap` fields

The sprite plan is derived from `map.furniture` and the kind tables (D2), the height map from `tiles` + `furniture` +
`KIND_HEIGHT`, the seat facing from the chair item on the seat tile. Adding fields would only cache derivations and would
break every snapshot-style procgen test for nothing. `generate.ts` is not edited in M17.

### 1.4 Character views (`game/actors/walkQueue.ts`, W0)

```ts
export type { Facing } from '@tagconn/shared';            // the local 'n'|'e'|'s'|'w' alias becomes the shared type
/** The three drawn views; `w` is `e` flipped. */
export type View = 's' | 'n' | 'e';
export const viewOf = (f: Facing): { view: View; flip: boolean } => (f === 'w' ? { view: 'e', flip: true } : { view: f, flip: false });
```

### 1.5 `renderTheme.ts` option (W1 D1, additive)

```ts
export interface RenderOptions {
  dualGrid?: boolean;
  /** M17: paint only the items this returns true for (the sprite plan's `baked` set). Omitted = every item, the v0.10 stream. */
  bakeItem?: (f: PlacedFurniture) => boolean;
}
```

---

## 2. The furniture sprite split

### 2.1 Classes

| class | kinds (from `KIND_HEIGHT` and `FRONT_STRIP_PX`) | baked | sprite |
|---|---|---|---|
| `baked` | height 0 and not sit-in: rug, mat, sigil, stairs-up/down, crate, wall-art, bin, banner | whole art | none |
| `sprite` | height > 0 and not sit-in: desks, tables, workbench, lab-bench, racks, shelves, bookcase, cabinets, counter, plant, lamp, centerpiece, pedestal, console, equipment, boards, every appliance, arcade, ping-pong, foosball, board-game-table, standing-table | nothing | one image, whole art incl. north-wall overdraw and shadow |
| `sit-in` | chair, armchair, sofa, booth, bench, reception-desk | whole art (as today) | the south strip of `FRONT_STRIP_PX[kind][facing]` px (none when 0) |

Why not split every kind into back and front halves: for a `sprite` item nobody can stand inside the footprint (blocking,
or inset cells only `small` creatures reach), so one whole image sorted by its south edge is exactly right; a character
north of it is behind, a character south of it is in front. The split is only needed where a character *is* inside the
footprint, and there the "back part" is simply the whole art under the character and the "front part" is the strip of it
nearest the viewer. This is the `receptionist-desk-front` hack (`OfficeScene.ts:598-607`) made general: the reception desk
becomes a sit-in kind with a 10 px strip and the hack is deleted.

### 2.2 Sitting "in" a chair

Procgen already places a 1 × 1 soft `chair` on every `sit` seat tile with a `facing` toward its desk or table
(`harmony.ts:171`: `m('chair', 1, 1, dx, dy, { facing, seats: [{ dx: 0, dy: 0, kind: 'sit' }] })`). A seated character's
feet are at the tile centre + `FEET_DY` = `ty*T + 14`; its legs occupy `ty*T + 11 .. 14`, its body `ty*T + 5 .. 11`.

- **Chair facing `n`** (desk to the north, the character's back to the viewer): the `n` seat view (`paintSeatView`,
  `furniture.ts:51-62`) draws the cushion on top and the backrest panel below it. The strip is the bottom 7 px
  (`ty*T + 9 .. 16`): backrest and post over the legs, the torso and head above it. Depth `(ty+1)*T − 0.5 > ty*T + 14` ✓.
- **Chair facing `s`** (character faces the viewer, backrest to the north): strip 0 px; the backrest is baked under the
  torso, which is right for 3/4 (a 7 px backrest sits entirely behind an 18 px person).
- **Chair facing `e`/`w`** (side profile): the bottom 3 px (near arm or knob) over the feet.
- Sofa/armchair (life activities `sit` on them): same rule, 8 px for `n`. Booth: 10 px for `n`, a 2 px front lip for `s`.
  Bench: 4 px. Reception desk: the counter front for every facing.
- The seated character shows the chair's view: the scene calls `c.setSeatFacing(seatFacingAt(map, tile))` (§3.3) when the
  walk arrives seated; `seatFacingAt` returns the facing of a sit-in item covering the tile, else `'s'` (today's look).

Guild stools (`paintGuildFurniture` `stool` branch) have no backrest; the strip then shows the stool's lower part over the
legs ("sitting on"), which is still correct. A walking character crossing a chair tile (chairs are soft) is briefly covered
by the strip, as it is already visually "through" the chair today. Accepted.

### 2.3 Sprite geometry

For an item `f` at tile size `T`: footprint px `fx = f.x·T, fy = f.y·T, fw = f.w·T, fh = f.h·T`; slot
`w = fw + 2·side, h = fh + top + bottom` (`SPRITE_MARGIN`); world position of the frame `(fx − side, fy − top)`;
`baseY = fy + fh`; depth `baseY − 0.5`. The frame's painter runs in the atlas with a canvas translate of
`(slot.x − (fx − side), slot.y − (fy − top))`, so the painter still receives the untouched world-space item and draws the
same pixels it draws into the base texture today. `paintRotated`'s own `translate/rotate/translate` composes with the outer
translate (rotation about the translated footprint centre), so rotation-safe kinds and the seat views need no change.

A sit-in strip is a second Phaser frame over the same slot: `key#strip`, rect `(slot.x + side, slot.y + top + fh − px,
fw, px)`, world position `(fx, fy + fh − px)`, same depth rule.

The §9 harness proves every `sprite`/`sit-in` painter of every style stays inside `SPRITE_MARGIN` at every footprint in
`integerFootprints ∪ fractionalFootprints` × every supported facing × `againstNorthWall` on/off; a painter that pokes out
is fixed in W2 A1 (today's known overhangs: north-wall overdraw ≤ 12 px, shadows 2 px below, the modern booth back 2 px sideways).

### 2.4 Tie-breaks and edge cases

| case | feet depth | sprite depth | result |
|---|---|---|---|
| seated in a chair at tile `ty` | `ty·T + 14` | `(ty+1)·T − 0.5` | strip over the legs ✓ |
| standing on the row **south** of a bookcase at `ty` | `(ty+1)·T + 14` | `(ty+1)·T − 0.5` | character over the bookcase's bottom 3 px ✓ (3/4) |
| walking the aisle **north** of a bookcase | `ty·T − 2` | `(ty+1)·T − 0.5` | lower body hidden by the bookcase (art spans `ty·T − 11 .. ty·T + 15`) ✓ |
| walking the aisle north of a desk row | `ty·T − 2` | `(ty+1)·T − 0.5` | feet pass behind the monitors (art from `ty·T − 3`) ✓ |
| Receptionist behind the reception desk | `ty·T + 10` | `(ty+1)·T − 0.5` | counter front strip over her lap, torso above ✓ (today's look) |
| cat on a desk's south inset cell (`KIND_SHAPE` inset) | `(ty+1)·T + 6 .. 14` | `(ty+1)·T − 0.5` | cat over the desk edge ✓ |
| theme `animate()` objects | n/a | fireplace flame `f.y·T + f.h·T + 2` (`guild.ts:140`), torches `slot.y·T + 1`, chandeliers `CHANDELIER_DEPTH` | unchanged; the flame sorts just above its fireplace sprite ✓ |
| `FurnitureTriggerLayer` outline (today `−2`) | n/a | moves to `baseY + 0.5` of its item (W2 T1), else the sprite hides the hover outline |
| room labels (depth 1) | n/a | can be covered by a tall item on the label row | accepted (label reserve keeps decor off those columns; appliances rarely land there); listed in §10 |

---

## 3. Modules

### 3.1 `game/depth/spritePlan.ts` (pure, W1 D1)

```ts
export interface PlanInput {
  map: Pick<GeneratedMap, 'furniture' | 'tileSize' | 'cols' | 'rows'>;
  /** `office.depth.sprites`; false = every item baked, strips still emitted. */
  sprites: boolean;
  maxSprites: number;
  /** Theme id at a tile (base theme or the Multiverse realm's), for `FrameSpec.themeId`. */
  themeIdAt: (x: number, y: number) => string;
}
/** Classifies every item (§2.1), builds strips, dedupes frames by `frameKey` + theme id, and applies the cap: `sprite`-class items are
 *  kept by `kindHeight` desc, then `baseY` asc (deterministic), the rest are demoted to `baked`. Strips never count against the cap. */
export function planSprites(input: PlanInput): SpritePlan;
```

### 3.2 `game/depth/pack.ts` (pure, W1 D1)

```ts
/** Shelf packing: frames sorted by height desc then key; rows of `ATLAS_WIDTH`; a page grows to the next power of two up to
 *  `ATLAS_MAX_HEIGHT`, then a new page starts. Deterministic; no frame overlaps; every frame inside its page (§9 test 3). */
export function packFrames(frames: Iterable<FrameSpec>): AtlasLayout;
```

### 3.3 `game/depth/furnitureAtlas.ts` (Phaser, W1 D1)

```ts
export interface FurnitureAtlas { themeId: string; pageKeys: string[]; frames: Map<string, PackedFrame>; destroy(): void }
export const atlasKey = (themeId: string, page: number, generation: number) => `furniture-atlas-${themeId}-${page}-${generation}`;
/** One `make.graphics` per page: for each frame `g.save(); g.translateCanvas(dx, dy); theme.paintFurniture(g, spec.item, T); g.restore()`,
 *  then `g.generateTexture(pageKey, w, h)` (transparent where nothing was drawn) and `texture.add(frameKey, 0, x, y, w, h)` for every
 *  frame and `texture.add(frameKey + '#strip', …)` for sit-in frames (strip rect from `FRONT_STRIP_PX`). `generation` makes keys
 *  unique across rebuilds so an in-flight image never points at a removed texture; `destroy()` removes the pages. */
export function buildFurnitureAtlas(scene: Phaser.Scene, theme: ThemeDefinition, frames: readonly FrameSpec[], T: number, generation: number): FurnitureAtlas;
```

Dev log: `[depth] atlas <theme>: N frames, WxH (P pages) in X ms`. Budget §8.

### 3.4 `game/depth/renderFloor.ts` (Phaser, W1 D1): the one entry point both scenes use

```ts
export interface RenderFloorOptions { dualGrid: boolean; sprites: boolean; maxSprites: number }
export interface FloorRender {
  base: Phaser.GameObjects.Image;              // THEME_BASE_TEXTURE at depth -10 (as today)
  sprites: Phaser.GameObjects.Image[];         // one per `plan.sprites`, `setOrigin(0).setDepth(baseY - DEPTH_EPSILON)`
  plan: SpritePlan;
  atlases: FurnitureAtlas[];                   // one per theme id present (≤ 3 on the Multiverse)
  index: SeeThroughIndex;                      // from D3's `buildSeeThroughIndex` (W1: D1 calls the W0 type's builder stub until D3 lands, see §11 ordering)
  destroy(): void;                             // images, atlases, base texture
}
/** `planSprites` → `renderGeneratedMap(scene, map, theme, regions, { dualGrid, bakeItem: (f) => bakedSet.has(f) })` → one atlas per
 *  theme id → images. Regions: an item inside a realm rect is painted by the realm's theme (same `themeAt` rule as `renderTheme.ts:71`). */
export function renderFloor(scene: Phaser.Scene, map: GeneratedMap, theme: ThemeDefinition, regions: ThemeRegion[], opts: RenderFloorOptions): FloorRender;
```

`OfficeScene.renderVisuals` and `PreviewScene.build` call this instead of `renderGeneratedMap` + `add.image` (§11, §6).
Reskin (`applySkin`) and rebuild destroy the previous `FloorRender` (today's `worldLayer` loop) and call it again.

### 3.5 `game/depth/seeThrough.ts` (pure, W1 D3) and `SeeThroughController.ts` (Phaser, D3)

```ts
export function buildSeeThroughIndex(sprites: readonly FurnitureSprite[], cols: number, rows: number, T: number, minHeight = SEE_THROUGH_MIN_HEIGHT): SeeThroughIndex;
/** A character's occluders: sprites in the index whose frame rect intersects `head` and whose depth is greater than `feetY`
 *  (the character is behind them). Allocation-free: writes sprite indices into `out`, returns the count (≤ out.length). */
export function occludersOf(index: SeeThroughIndex, head: Rect, feetY: number, out: Int32Array): number;
/** The head/torso box that must stay visible: `(x - 4, y - 18, 8, 12)` in world px (feet at `(x, y)`). */
export function headRectOf(x: number, y: number, out: Rect): Rect;

export interface SeeThroughHost { characters(): Iterable<{ x: number; y: number; gone?: boolean }>; render(): FloorRender | null; reducedMotion(): boolean }
export class SeeThroughController {
  constructor(scene: Phaser.Scene, host: SeeThroughHost);
  applySettings(depth: Settings['office']['depth']): void;    // alpha, fade ms; alpha 1 disables the controller (every sprite back to 1)
  /** Per frame: for each character (cast + Receptionist, ≤ 64), collect occluders; each sprite's target alpha is `seeThrough` while it
   *  occludes someone this frame and for `HOLD_MS = 120` after (hysteresis against flicker), else 1; alpha moves toward the target by
   *  `dt / seeThroughFadeMs` (instant under reduced motion). Touches only sprites whose alpha changes. */
  update(time: number, delta: number): void;
  destroy(): void;
}
```

Why this is enough: the only things that can cover a character in this geometry are tall sprites (invariant 3). The
back-wall face overdraws only the top `bandPx ≤ 10` px of the first floor row, below a character's feet at `+14`
(back-wall.md §1), and walls draw inside their own tile, so a character is never covered by a wall and "see-through
walls" has nothing to fade. Desks/tables (height < 10) hide only feet and are excluded so a seated row never flickers.

### 3.6 `game/lighting/heightmap.ts` (pure, W1 D3) and wall shadows

```ts
export interface HeightMap { cols: number; rows: number; T: number; px: Uint8Array /* per tile: max visual height above the floor */ }
/** Walls = `WALL_HEIGHT_PX` (16); floor/door/void = 0; each furniture item raises its covered tiles to `max(current, kindHeight(kind))`
 *  (half-tile rects via `coveredTileRect`). Pins included; a kind not in the table is 0. */
export function buildHeightMap(map: Pick<GeneratedMap, 'cols' | 'rows' | 'tileSize' | 'tiles' | 'furniture'>, heights?: Record<string, number>): HeightMap;
export const heightAt = (hm: HeightMap, wx: number, wy: number): number;   // 0 outside
```

```ts
// game/lighting/shadows.ts (+)
/** Day shadows of wall runs: every occluder segment whose floor side is south or east of a wall (from `buildOccluders`, reused) is extruded
 *  along `sunShadowVector(sun, WALL_HEIGHT_PX, T)` as a parallelogram, clipped to floor/door tiles like furniture shadows, alpha
 *  `shadowAlpha * 0.8 * daylight`. Nothing at night (room lights are inside the room). `blob` mode: none. */
export function wallShadows(map: GeneratedMap, occluders: Occluders, sun: SunState, shadowAlpha: number): ShadowQuad[];
```

`LightingController.rebuildGeometry` builds the height map once per map; the shadow bake appends `wallShadows` when
`office.depth.wallShadows` and `mode.furniture === 'cast'`. `furnitureShadows` keeps using `kindHeight` (same table), so
"shadow length from height and sun elevation" is one function (`sunShadowVector`) fed by one table for walls and items alike.
Occluders for the lightmap are unchanged (`OCCLUDER_MIN_HEIGHT_PX`); the height map is exported through `lighting/index.ts`
for the see-through controller's tests and a later milestone (character shadows clipped at tall items is a non-goal).

---

## 4. Depth sorting rules and invariants (summary table)

| layer | depth | blend | M17 |
|---|---|---|---|
| base texture: tiles, dual edges, back-wall face, wall decor, doors, `baked` furniture, sit-in whole art | −10 | normal | fewer items; `bakeItem` predicate; `sprites=false` ⇒ v0.10 stream |
| `ShadowLayer`: furniture + **wall** shadows | −5 | normal | `wallShadows` added |
| trigger outlines / zones | item `baseY + 0.5` / −3 | | outline moves above its sprite (W2 T1) |
| room labels | 1 | | unchanged |
| **furniture sprites and sit-in strips** | `baseY − 0.5` ∈ [0, worldH) | normal, alpha by see-through | new |
| characters (containers) | `feet y` | | views per facing; seated facing from the chair |
| theme `animate()` sprites | as today (`slot.y·T + k`, `f.y·T + f.h·T + 2`) | | unchanged |
| character overlays (plates, bubbles) | 100 000 + y | | unchanged |
| realm banners | 50 000 | | unchanged |
| `LightmapLayer` | 90 000 | multiply | unchanged (sprites are below it) |
| flicker glows / bloom `LightLayer` | 90 001 / 95 000 | add | unchanged |
| camera post pipelines | camera | | **perspective** first, then grading → screen → vignette |
| tooltip | 200 000 (scrollFactor 0) | | unchanged |

Phaser sorts the display list only when a depth changed (`sortChildrenFlag`); characters change depth every frame today,
so the per-frame sort already exists and grows from ~N characters + ~40 ambient objects to +≤ 1500 sprites (a stable sort
of ~1600 entries, well under 0.2 ms). Camera culling (`Camera#cull`, on by default) drops off-screen sprites before the
WebGL batch; the batch flushes on texture change, and furniture sprites share one atlas texture per style, so the number of
flushes is bounded by the characters interleaved between them (today's cost), not by the sprite count.

---

## 5. See-through fade algorithm (cheap per frame)

Per frame (`SeeThroughController.update`): for each tracked character (cast + Receptionist; NPCs are excluded so a courier
never fades a bookcase), `headRectOf(c.x, c.y)` → `occludersOf(index, head, c.y, out)` using the per-tile CSR bucket over the
tiles the head rect spans (≤ 2 × 2 tiles), so the cost is O(characters × sprites-near-head) with no allocation. Each hit
stamps `lastSeen[i] = time`. Then for every sprite whose `alpha !== target`: `target = time − lastSeen[i] < HOLD_MS ?
seeThrough : 1`, `alpha += clamp((target − alpha), ±delta / fadeMs)`; reduced motion snaps. A sprite with `height <
SEE_THROUGH_MIN_HEIGHT` is not in the index at all. `seeThrough = 1` turns the controller into a no-op after restoring alphas.
Budget: 60 characters → ≤ 0.2 ms (§8, stub-scene perf test). Walls: nothing to fade (§3.5).

---

## 6. 4-direction characters

### 6.1 Bitmaps (`game/textures.ts`, W1 D2)

Legacy keys keep their bitmaps and become the `s` view (so `heroPreview.ts`, `costumes.ts` and existing tests are
untouched): `ch-body` (= `s`), `ch-legs-0/1/2`, `ch-legs-sit`, `ch-head`, `ch-hair-<i>`. New keys:

| key | size | content |
|---|---|---|
| `ch-body-n` | 8 × 6 | the `s` silhouette without the collar highlight; a 1 px darker spine column (`SHADE`) |
| `ch-body-e` | 6 × 6 | narrower profile: 1 px shaded back edge, lighter front |
| `ch-legs-n-{0,1,2}`, `ch-legs-n-sit` | 8 × 3 | mirror of the `s` frames (heel highlights swapped) |
| `ch-legs-e-{0,1,2}`, `ch-legs-e-sit` | 6 × 3 | profile stride: frame 1 front leg forward, frame 2 back leg forward; sit = knees forward (2 px wider to the front) |
| `ch-head-n` | 6 × 5 | no eyes/mouth; the neck shade row stays |
| `ch-head-e` | 6 × 5 | one eye (`e`+`k`) in column 4, the mouth shade shifted right |
| `ch-hair-<i>-n` | ≤ 6 × 6 | each of the 7 styles seen from behind (fuller: covers rows 2-3) |
| `ch-hair-<i>-e` | ≤ 6 × 6 | each style in profile (fringe on the front column) |

`viewTexture(base: 'ch-body' | 'ch-head' | 'ch-legs-0' | …, view: View): string` returns the legacy key for `s` and
`${base}-n` / `${base}-e` otherwise (legs: `ch-legs-n-0`). `textures.test.ts` asserts every key exists after
`generateTextures` and the sizes above. Hats, goggles, shades, cloak and props keep one bitmap; per view they shift:
`VIEW_OFFSETS: Record<View, { badge: boolean; prop: boolean; handL: [x, y] | null; handR: [x, y] | null; hatDx: number; propDx: number }>`
(`s`: today's numbers; `n`: no badge, no prop, hands at the sides, cloak drawn *over* the body (`upper.moveTo(cloak, upper.getIndex(head))`);
`e`: badge off, one hand, prop at `+4`, hat `+1`). Pure table in `game/actors/views.ts` with a test.

### 6.2 Character (`game/actors/Character.ts`, W1 D2)

```ts
/** M17: facing while seated (from the chair, `seatFacingAt`); null = `s`. */
setSeatFacing(f: Facing | null): void;
/** M17: `office.depth.fourDirections`; false = `s` view + horizontal flip (v0.10). */
setFourDirections(on: boolean): void;
```

`animate()` picks the view: walking → `viewOf(this.facing)` (already updated per step from `facingOf(dx, dy)`,
`Character.ts:1052`); sitting → `viewOf(seatFacing ?? 's')`; standing with `faceX` → `e` flipped toward `faceX`; standing
otherwise → `s` (today's readable faces). The view is applied only when it changes (texture keys + offsets + `upper.scaleX` /
`legs.setFlipX`), so the per-frame cost is one comparison. The 4-frame walk cycle (`floor(t · 8) % 4`, bob on odd frames) is
unchanged and indexes the view's leg frames. Creatures (`setCreature`) are untouched. `heroPreview.ts` gets an optional
`view` (default `s`) so the Hero editor can later show a turnaround; the editor itself is unchanged in M17.

### 6.3 Seat facing (`game/seats.ts`, W1 D2)

```ts
/** Facing of the sit-in item (chair, armchair, sofa, booth, bench, reception-desk) covering `tile`, else `'s'`. Pure; D2. */
export function seatFacingAt(map: Pick<GeneratedMap, 'furniture'>, tile: Point): Facing;
```

---

## 7. Camera: follow, deadzone, integer zoom, perspective

### 7.1 `game/camera/follow.ts` (pure, W2 C1)

```ts
export interface FollowInput {
  target: Point;                                  // world px (the scene passes `(c.x, c.y - 8)` as today)
  scrollX: number; scrollY: number; camWidth: number; camHeight: number; zoom: number;
  insets: SafeInsets; worldW: number; worldH: number;
  deadzone: number; lagMs: number; dtMs: number; instant: boolean;
}
/** Deadzone = the safe rect shrunk to `deadzone` of its size about its centre. Inside: no change. Outside: the desired scroll puts the
 *  target on the nearest deadzone edge per axis (not the centre), then `scroll += (desired - scroll) * a` with `a = instant || lagMs === 0
 *  ? 1 : 1 - exp(-dtMs / lagMs)`, then `clampScrollToSafeBounds`. Uses Phaser's scroll convention (camera/insets.ts note). */
export function followStep(i: FollowInput): { scrollX: number; scrollY: number; moved: boolean };
```

Replaces the fixed `Linear(…, 0.25)` in `OfficeScene.recenterFollow` (`:1155-1170`); `instant` = reduced motion (today's
behaviour) or the first frame after `setFollow`. `office.camera.follow = 'selected'`: `OfficeGame.setSelected` → the scene
also `setFollow(agentId)`; a drag still cancels (`cancelFollow`).

### 7.2 `game/camera/snap.ts` (pure, W2 C1)

```ts
/** `integerZoom`: zoom >= 1 → whole numbers (`fit` rounds down so the map still fits; `round` for wheel/pinch so each tick lands on the next stop);
 *  zoom < 1 unchanged (phones must fit a floor). Clamped to [0.2, 6]. */
export function snapZoom(zoom: number, integer: boolean, mode: 'fit' | 'round'): number;
```

`OfficeScene.targetZoom()` returns `snapZoom(fit · cfg · userZoom, integerZoom, panned ? 'round' : 'fit')`; the camera gets
`setRoundPixels(true)` when `integerZoom` so scroll lands on whole screen pixels. The `+6 %` floor-transition bump
(`runTransition`) tweens the raw zoom and `finishTransition` restores the snapped one, as today. The pixel vignette and LCD
grid already follow `postFx.setZoom(zoom)`.

### 7.3 Perspective (`game/postfx/perspective.ts` pure + `PerspectivePipeline.ts`, W2 C1; WebGL only)

```ts
export interface PerspectiveUniforms { k: number; hazeStrength: number; haze: [number, number, number]; texel: number }
export const PERSPECTIVE_K_MAX = 0.3;       // compression of the top row at perspective = 1
export const PERSPECTIVE_HAZE_MAX = 0.18;
/** k = perspective * K_MAX; hazeStrength = perspective * HAZE_MAX; haze = theme `palette.bg` as rgb 0..1; texel = 1 / viewportHeightPx
 *  (one screen row in UV units) so the remap snaps to whole screen rows. perspective 0 → every value 0 (identity). */
export function perspectiveUniforms(perspective: number, zoom: number, viewportH: number, bgColor: number): PerspectiveUniforms;
```

Fragment: with `t` = distance from the **top** of the screen in [0, 1] (same orientation convention as `VignettePipeline`,
checked against it), `srcT = t + k · (t − t²)` (monotonic, derivative `1 + k` at the top and `1 − k` at the bottom: the far
rows are compressed, the near rows stretched), `srcT = (floor(srcT / texel) + 0.5) · texel` (whole screen rows, no blur; rows snap to screen pixels, not art pixels, because name plates and bubble text are drawn at screen resolution and an art-row snap collapsed them into vertical strips at zoom ≥ 5),
`color = mix(sample(uv.x, srcT), haze, hazeStrength · (1 − t))`. Registered in `PostFxController` as `office-perspective`
and attached **first** (before grading), toggled by uniform like the others (`k = 0` is identity; the pipeline stays
attached, no `setPostPipeline` churn). Canvas renderer and `perspective = 0`: nothing. Known cost: pointer → world mapping
ignores the remap, so hits drift by up to `k · H / 4` px at the top/bottom (≈ 6 px at the default on a 800 px canvas, under
the 24 px hit targets); the hint says keep it below 0.3. A `low`-quality device keeps it (one texture read per pixel).

---

## 8. Perf budgets (`game/depth/__tests__/depth.perf.test.ts`, `lighting.perf.test.ts`; `pnpm test:perf` only)

At 128 × 96 (`maxRoomsLayout()` from `game/nav/__tests__/perfLayout.ts`), medians of 9 after a warm-up:

| what | budget |
|---|---|
| `planSprites` (≈ 600-900 items) | ≤ 3 ms |
| `packFrames` (≤ 400 frames) | ≤ 2 ms; every page ≤ 1024 × 2048, ≤ 2 pages per style |
| `buildFurnitureAtlas` on the fake scene (command count) | ≤ 1.1 × the furniture share of today's base bake (same painters, once per unique frame instead of once per item) |
| `renderFloor` in the browser (dev log) | base + atlas + images ≤ 1.3 × v0.10.0's base-texture time; atlas page ≤ 30 ms |
| `buildHeightMap` / `wallShadows` | ≤ 2 ms / ≤ 3 ms per bake |
| `buildSeeThroughIndex` | ≤ 2 ms per floor |
| `SeeThroughController.update` with 60 characters and 1500 sprites (stub) | ≤ 0.2 ms, zero allocations after warm-up |
| `followStep` + `snapZoom` + 60 × view selection | ≤ 0.1 ms |
| sprite count | ≤ `maxSprites` (1500); demotion keeps the tallest; the Multiverse (1920 × 1408 px = 120 × 88 tiles) fits under the same cap |
| textures | Multiverse base ≤ 1920 × 1408 (unchanged); atlas pages ≤ 3 styles × 2 × 1024 × 2048 worst case, typically one 1024 × 512 per style |
| `generate.perf.test.ts`, `renderTheme.perf.test.ts` | unchanged ceilings (procgen untouched; the base bake only shrinks) |

Browser (QA gate, `?demo=1`, Chrome Performance panel): `OfficeScene.update` total not more than +0.5 ms per frame
against v0.10.0 with 40 characters; no dropped frames while following a walking character at zoom 3.

---

## 9. Test plan (vitest; pure first)

1. `tables.test.ts` (W0): `spriteClassOf` table (every `FurnitureKind` classified; `constructor` → `baked`); `FRONT_STRIP_PX` values ≤ `T`; `frameKey` distinguishes kind, variant, facing, size, wall flag, room type, trigger.
2. `spritePlan.test.ts` (D1): classes per §2.1 over `DEFAULT_LAYOUT` + 300 BSP seeds; `baseY` = south edge; strips only for sit-in kinds with a non-zero entry; cap keeps the tallest and is deterministic; `sprites=false` ⇒ every non-strip item in `baked`; **property**: two items with equal `frameKey` + theme paint identical command streams (`makeCommandGraphics`); Multiverse regions assign the realm's theme id.
3. `pack.test.ts` (D1): no overlaps, all inside, deterministic, page split at `ATLAS_MAX_HEIGHT`, degenerate inputs (0 frames, one huge frame).
4. `furnitureAtlas.test.ts` (D1, fake scene with a `textures.get(key).add` stub): one `generateTexture` per page; `save`/`translateCanvas`/`restore` balanced around every frame; frame rects match the layout; strip frames present for sit-in frames; `destroy` removes pages.
5. `renderFloor.test.ts` (D1): images = 1 + sprites; depth of every sprite = `baseY − 0.5`; the base bake received exactly the `baked` items (predicate); with `sprites=false` and no sit-in items the `renderGeneratedMap` command stream equals the v0.10.0 stream (recorded with `recordRects`, compared to a no-option call); rebuild destroys the previous atlases.
6. `renderTheme.test.ts` (D1, one case): `bakeItem` skips items; no option = unchanged stream; pass order unchanged.
7. `painters.test.ts` (W2 A1): every `sprite`/`sit-in` painter of modern, guild and rift stays inside `SPRITE_MARGIN` at `integerFootprints ∪ fractionalFootprints` × supported facings × wall flag; the `s` command streams still match `painterRects.snap.json` (art unchanged).
8. `views.test.ts` + `textures.test.ts` (D2): `viewOf`; `viewTexture` keys exist; sizes per §6.1; `VIEW_OFFSETS` complete.
9. `Character` (D2, stub scene like `characterNav.test.ts`): walking east/west/north/south sets the expected textures and flips; `setSeatFacing('n')` while seated shows the `n` view; standing idle returns to `s`; `setFourDirections(false)` never leaves the legacy keys; the view applies only on change (texture setter call count).
10. `seats.test.ts` (D2): `seatFacingAt` finds the chair under a desk seat of `DEFAULT_LAYOUT` (facing `n`), a meeting chair (`s`/`e`/`w`), `'s'` on a bare tile, a half-tile pinned sofa by `coveredTileRect`.
11. `heightmap.test.ts` (D3): walls 16, floor 0, item max-of-overlaps, half-tile pins, `heightAt` outside = 0; equals `kindHeight` for single items.
12. `shadows.test.ts` (D3, +): `wallShadows` quads start on wall/floor boundary segments, lie on floor/door tiles, zero at night, length follows `sunShadowVector(…, 16)`; `furnitureShadows` unchanged.
13. `seeThrough.test.ts` + `SeeThroughController.test.ts` (D3): `occludersOf` equals brute force on 300 random (sprites, head) cases; height filter; allocation-free (`out` reuse); controller: a hidden character fades its occluder to `seeThrough` within `fadeMs`, holds `HOLD_MS`, restores; `seeThrough = 1` restores everything and stops touching alphas; reduced motion snaps.
14. `follow.test.ts` + `snap.test.ts` (C1): inside the deadzone → unchanged; outside → converges to the edge, monotonic, never overshoots; `instant` lands in one step; clamped at world bounds; `deadzone = 0` ≡ centre; `snapZoom` table (0.7 → 0.7, 1.4 fit → 1, 1.6 round → 2, 6.5 → 6, integer off = identity).
15. `perspective.test.ts` (C1): uniforms identity at 0; `texel = zoom / H`; haze from `palette.bg`; monotonic remap for k ≤ `K_MAX` (sampled); `PostFxController` attaches `office-perspective` first and toggles by uniform (existing controller test pattern).
16. `furnitureTriggerLayer` (W2 T1): outline depth = item `baseY + 0.5`.
17. `PreviewScene` (P1, stub Phaser game as the existing editor tests do, or a `buildPreview` unit): `renderFloor` called with the settings' `dualGrid`/`sprites`; wanderers are `Character`s with depth = y.
18. `meta.test.ts` (W0): a hint for every new key; `ENUM_OPTIONS['office.camera.follow']`.
19. PM smoke (`?demo=1`, modern, guild, Multiverse, phone): a character walks the back aisle **behind** a bookcase and the monitors; sits in a desk chair with the backrest over the legs and its back to the viewer; all four directions animate on a long walk; the selected character behind a cabinet fades it; Follow with the deadzone at zoom 2 and 3 (crisp pixels, no shimmer); wheel zoom lands on whole stops; perspective 0 / 0.1 / 0.5 screenshots; `sprites=false` and `fourDirections=false` restore v0.10; canvas renderer (`?renderer=canvas` or WebGL disabled): sprites fine, perspective off; Hall Planner preview shows sprites and walking Characters; 0 console errors; `[depth]` dev logs within budget.

---

## 10. Risks and trade-offs

- **Draw-call growth.** Interleaving sprites and characters in one depth order defeats batching only at texture changes; characters already switch textures ~10 times each, so the added flushes are bounded by the character count. If a profile shows otherwise, the lever is a shared character atlas (pack `ch-*` into one texture), out of scope here.
- **Painters outside the margin.** A painter that draws beyond `SPRITE_MARGIN` gets clipped in the atlas (visible as a cut). Test 7 catches it before the gate; W2 A1 fixes offenders. Today's known overhangs fit.
- **Equal-key painters that differ.** The frame key must cover every input a painter reads. Test 2's property over 300 seeds proves it; if a painter ever reads `f.roomId` or `f.x` parity for variety, it must move that into `variant`.
- **Seated backs hide faces.** A desk chair faces its desk (`n`), so a working hero shows its back. Name plates, emotes, strain icons and bubbles are unchanged, the hair colour still identifies the hero; `fourDirections=false` restores faces. Accepted by the user decision.
- **Room labels under tall items.** Depth 1 labels can be covered by a bookcase on the label row (today they draw over baked art). Listed as a follow-up: a wall-mounted plaque, or depth `labelAt.y·T + T` with a tested no-overlap against sprites on that row.
- **Integer zoom leaves margins.** `fit` rounds down, so a floor that fit at 1.4 now shows at 1 with a border. Below 1 the zoom stays continuous, so phones are unaffected. `integerZoom=false` is one toggle away.
- **Perspective pointer drift.** Documented in §7.3 (≤ 6 px at the default). Hit targets are ≥ 24 px (M9). The hint caps the recommendation at 0.3; the schema allows 1 as the user asked.
- **Perspective resampling.** Snapping to whole screen rows avoids blur but duplicates rows near the bottom at high `k`; at the default it is one duplicated row per ~30. Scrolling shows no shimmer because the snap is in screen space.
- **See-through flicker.** A character walking along a cabinet row toggles occluders every tile; `HOLD_MS` and the fade make it a smooth ripple. Desks are excluded by the height threshold.
- **Atlas rebuild on reskin.** `applySkin` rebuilds base + atlas + images (today it rebuilds the base + ambient). ~+30 ms once per reskin. Generation-suffixed keys avoid an image referencing a removed texture mid-frame.
- **Memory.** Up to three 1024 × 512 atlases (Multiverse) ≈ 6 MB of GPU textures, next to the 1920 × 1408 base (≈ 10 MB). Fine on every target; `maxTextureSize` is checked and a page over the limit falls back to baking those frames (same path as `demoted`).
- **Receptionist regression.** The bespoke desk-front cut is replaced by the general strip; the W3 smoke checks her at the modern desk, the guild counter and the Nexus gate.
- **Trigger outlines.** Moving the outline depth above the sprite is a small but easy-to-forget change (W2 T1); without it the hover outline of the notice board disappears.

---

## 11. Wave plan (file-disjoint; PM commits after each verified wave)

Paths under `apps/web/src/` unless they start with `packages/`. Hot files (`OfficeScene.ts`, `OfficeView.tsx`,
`OfficeGame.ts`) are PM-only. Barrels (`game/depth/index.ts`, `game/lighting/index.ts`) are written in W0 with the W0 exports
only and completed by the PM in W3, so no W1/W2 task edits a barrel. Every developer runs the ROOT `pnpm typecheck`, the web
tests and `pnpm test:perf` before hand-off.

### Spike first (recommended, after W0, before W1 starts)

**Prototype one room and two kinds: the modern `desks` room of `DEFAULT_LAYOUT` (`layout.ts:514`), with `bookcase`
(walk behind) and `chair` facing `n` (sit in).** It is the most common room, holds the most seated characters, has
appliances against the north wall (overdraw frames), a plant in a corner (rotation-safe kind), and desks with chairs facing
`n` (the strip rule and the seated view). Time-box: 3 hours, D1's developer, in an `isolation: "worktree"` branch, hard-wired
in a scratch copy of `renderVisuals` on an own vite port (never the live office). Exit criteria: a screenshot of a character
half-hidden behind the bookcase and one seated with the backrest over its legs; `generateTexture` + `translateCanvas` frames
verified on WebGL **and** canvas; atlas time for the whole floor logged; a count of painters outside `SPRITE_MARGIN`; a note in
`.tagconn/work/handoffs/m17-spike.md`. Go/no-go: if atlas frames via canvas translate misbehave on either renderer, D1 falls
back to one `generateTexture` per unique frame key (same dedupe, more textures, same images); everything else in this doc stands.

### Wave 0 (contract; one developer, sequential; architect docs in parallel)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| W0 | developer (contract) | `packages/shared/src/settings.ts` (+ its test), `features/settings/meta.ts` + `meta.test.ts`, `config/office.yaml`, `game/depth/{types,tables,index}.ts` + `game/depth/__tests__/tables.test.ts`, `game/actors/walkQueue.ts` (§1.4 only) | none | §1.1, 1.2, 1.4 verbatim; tests 1, 18; ROOT typecheck green; PM commits before the spike/W1 |

### Wave 1 (parallel)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| D1 | developer (sprites) | `game/depth/{spritePlan,pack,furnitureAtlas,renderFloor}.ts`, `game/depth/__tests__/{spritePlan,pack,furnitureAtlas,renderFloor,depth.perf}.test.ts`, `themes/renderTheme.ts` (§1.5), `themes/__tests__/renderTheme.test.ts` (one case), `themes/__tests__/testUtils.ts` (fake-scene frame stub) | W0 (+ spike notes) | §2, §3.1-3.4; tests 2-6; §8 budgets; `renderFloor` builds the see-through index through the W0 type with D3's builder imported by path (lands in the same wave; until then a local stub) |
| D2 | developer (characters) | `game/textures.ts` + `textures.test.ts`, `game/actors/Character.ts`, `game/actors/views.ts` + `actors/__tests__/views.test.ts`, `actors/__tests__/characterNav.test.ts` (view cases), `game/heroPreview.ts` + `heroPreview.test.ts`, `game/seats.ts` + `seats.test.ts` | W0 | §6; tests 8-10; legacy keys unchanged; v0.10 look with `setFourDirections(false)` |
| D3 | developer (lighting + see-through) | `game/lighting/{heightmap,shadows,ShadowLayer,LightingController}.ts`, `game/lighting/__tests__/{heightmap,shadows,lighting.perf}.test.ts`, `game/depth/{seeThrough,SeeThroughController}.ts`, `game/depth/__tests__/{seeThrough,SeeThroughController}.test.ts` | W0 | §3.5, 3.6, §5; tests 11-13; budgets; `LightingController` gains `applyDepth(depth: Settings['office']['depth'])` for `wallShadows` |

Quick gate after W1 (QA + review on the pure modules; PM commits).

### Wave 2 (parallel)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| C1 | developer (camera) | `game/camera/{follow,snap}.ts` + `camera/__tests__/{follow,snap}.test.ts`, `game/postfx/{perspective,PerspectivePipeline,PostFxController}.ts`, `postfx/__tests__/perspective.test.ts` (+ the controller test) | W0 | §7; tests 14-15; canvas = no-op; `PostFxController.applySettings` reads `office.camera.perspective` and the theme bg |
| P1 | developer (editor + triggers) | `features/editor/PreviewScene.ts` (+ a test), `game/scenes/furnitureTriggerLayer.ts` + its test | D1, D2 | §6 of this doc via `renderFloor`; wanderers are `Character`s walking real paths (`PathFinder`) with facing from the path, depth = y; `generateTextures` + the costume/fx texture bootstrap `OfficeScene.create` uses; test 16-17 |
| A1 | developer (art) | `themes/paint/furniture.ts`, `themes/paint/riftFurniture.ts`, `themes/__tests__/painters.test.ts`, `themes/__tests__/painterRects.snap.json` (only if a fix changes a stream, documented), `game/depth/tables.ts` (strip px tuning only), `game/lighting/heights.ts` (tuning only, e.g. `banner`/`crate` > 0 if they should sort) | D1 | test 7 green for all three styles; seat strips read right in modern/guild/rift screenshots (n/e/w); no `s`-stream change unless documented |

### Wave 3 (sequential: PM wiring, then the gate)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| W3-PM | PM | `game/scenes/OfficeScene.ts`, `features/office/OfficeView.tsx` (if anything), `game/OfficeGame.ts` (`setSelected` → follow when `office.camera.follow = 'selected'`), `game/depth/index.ts`, `game/lighting/index.ts` | W1, W2 | §12 applied; ROOT typecheck/test/build + `pnpm test:perf`; smoke 19 |
| Gate | qa-engineer, code-reviewer, security-engineer, tech-writer (parallel) | qa: tests only; tech-writer: `docs/guide/display.md` (depth, camera, perspective rows), `docs/guide/office.md`, `docs/architecture.md` (web section + depth table), `CHANGELOG.md` `[Unreleased]` (breaking: painter/atlas path, visuals; layouts unchanged) | W3-PM | QA desktop + phone, three styles, Multiverse, canvas fallback, reduced motion; review of invariants 3-6 and the depth table; security: no new input surface (settings are numbers/enums/booleans inside `office`; atlas keys are derived, never from user strings beyond the kind/variant already validated by `validateLayout`); then `pnpm release major` → v1.0.0 |

---

## 12. PM wiring (Wave 3, the only edits to hot files)

`OfficeScene.ts`:
1. `renderVisuals`: replace `renderGeneratedMap(...)` + `this.add.image(THEME_BASE_TEXTURE)` with
   `this.floor = renderFloor(this, this.map, this.theme, this.regions, { dualGrid, sprites: office.depth.sprites, maxSprites })`;
   `worldLayer` keeps the labels; `floor.destroy()` where `worldLayer` is destroyed; `applySkin` goes through the same path.
2. `rebuildReceptionist`: delete the `receptionist-desk-front` frame, `receptionistDeskFront` and `RECEPTIONIST_DESK_FRONT_DY`
   (`:82, :582-583, :598-607, :630`); keep `RECEPTIONIST_DESK_FEET_DY`; after `c.setSeated(behindDesk)` call
   `c.setSeatFacing(behindDesk ? seatFacingAt(this.map, spot) : null)`.
3. Seating: wherever a walk arrives with `seated = true` (the `walk`/`walkNav` callers with the seat assignment), call
   `c.setSeatFacing(seatFacingAt(this.map, tile))`; on unseat `c.setSeatFacing(null)`.
4. `create()`: `this.seeThrough = new SeeThroughController(this, { characters: () => [...this.characters.values(), this.receptionist].filter(Boolean), render: () => this.floor, reducedMotion: () => this.reducedMotion.value })`;
   `update()`: `this.seeThrough.update(time, delta)` after the characters loop; SHUTDOWN: destroy.
5. `setOfficeState`: `this.seeThrough.applySettings(office.depth)`, `this.lighting.applyDepth(office.depth)`,
   `for (c of characters) c.setFourDirections(office.depth.fourDirections)`, `this.postFx.applySettings(...)` already receives
   `office` (add `camera.perspective`); `cam.setRoundPixels(office.camera.integerZoom)`; when `integerZoom` changes, `fitCamera()`.
6. Camera: `targetZoom()` → `snapZoom(...)` (§7.2); `recenterFollow(instant)` → `followStep({...})` (§7.1) with
   `office.camera.{deadzone, followLagMs}`; `setFollow` marks `instant` for the first frame.
7. `OfficeGame.setSelected(agentId)`: when `office.camera.follow === 'selected'`, also `scene.setFollow(agentId)` (and `null` on deselect).

`OfficeView.tsx`: nothing expected (settings already flow through `settings.office`); the Follow button keeps working.
`game/depth/index.ts`, `game/lighting/index.ts`: complete the re-exports.
