import type { PlacedFurniture } from '../procgen/types';

/** M17 (depth-25d.md section 2.4): the ring sits at the item's south edge + 0.5 px so its sprite (depth baseY - 0.5) never hides it. */
const RING_DEPTH_OFFSET = 0.5;

/** Hover-outline depth for a footprint (tile rect): its south edge in px + 0.5. */
export function ringDepthOf(f: Pick<PlacedFurniture, 'y' | 'h'>, tileSize: number): number {
  return (f.y + f.h) * tileSize + RING_DEPTH_OFFSET;
}
