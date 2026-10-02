// M17 depth rendering contract (docs/design/depth-25d.md section 1.2). Type-only, no Phaser.
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
/** `demoted`: keys of frames that would have opened a page past `ATLAS_MAX_PAGES`; they are not in `frames`. */
export interface AtlasLayout { pages: { w: number; h: number }[]; frames: Map<string, PackedFrame>; demoted: string[] }

/** Per-tile bucket of occluding sprites for the see-through test (CSR like `LightIndex`). */
export interface SeeThroughIndex {
  cols: number; rows: number; T: number;
  sprites: readonly FurnitureSprite[];
  start: Int32Array; items: Int32Array;
}
