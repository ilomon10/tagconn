// apps/web/src/game/nav/constants.ts  (M15 dual grid, see docs/design/navigation.md)
//
// The sub-tile navigation grid: one tile = SUB x SUB cells, each cell one bit in the tile's mask
// nibble (`bit = (cy % SUB) * SUB + (cx % SUB)`). Pure constants; W1 adds grid.ts/shapes.ts.

/** Pixel size of a map tile. Must equal `procgen.TILE` (asserted by a test; nav never imports procgen). */
export const TILE_PX = 16;
/** Cells per tile side. One unit for everything: the half tile. */
export const SUB = 2;
/** Pixel size of one nav cell. */
export const CELL_PX = TILE_PX / SUB;
/** Mask bits per tile: SUB*SUB cells in the low nibble of a `Uint8Array` entry. */
export const BITS_PER_TILE = SUB * SUB;
/** All cells of a tile walkable. */
export const FULL_MASK = (1 << BITS_PER_TILE) - 1;
/** Clearance values saturate here (fits any `NavClass` size with room to spare; keeps `Uint8Array` updates local). */
export const CLEARANCE_MAX = 7;
/** Nav point = feet point shifted up by this many px, so a person anchored on a tile lands on today's feet point. */
export const FEET_DY = 6;

/** Tile flags in the high nibble of the mask byte (the low nibble holds the cell bits). */
export const TILE_FLAG_FLOOR = 0x10;
export const TILE_FLAG_DOOR = 0x20;
/** Soft-blocking furniture (rugs, mats): walkable, but routing prefers to avoid it. */
export const TILE_FLAG_SOFT = 0x40;
