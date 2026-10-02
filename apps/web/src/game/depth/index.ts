// M17 depth barrel: W0 exports only; the PM completes it in Wave 3 (docs/design/depth-25d.md section 11).
export type { AtlasLayout, FrameSpec, FurnitureSprite, PackedFrame, SeeThroughIndex, SpriteClass, SpritePlan } from './types';
export {
  ATLAS_MAX_HEIGHT,
  ATLAS_WIDTH,
  DEPTH_EPSILON,
  FRONT_STRIP_PX,
  SEE_THROUGH_MIN_HEIGHT,
  SPRITE_MARGIN,
  frameKey,
  isSitInKind,
  spriteClassOf,
} from './tables';
export type { SitInKind } from './tables';
// Wave 1-3 (PM): the pure planners plus the Phaser layers. Pure tests should import from the module files, not this
// barrel, because `furnitureAtlas`/`renderFloor`/`SeeThroughController` load Phaser.
export * from './spritePlan';
export * from './pack';
export * from './seeThrough';
export * from './furnitureAtlas';
export * from './renderFloor';
export * from './SeeThroughController';
