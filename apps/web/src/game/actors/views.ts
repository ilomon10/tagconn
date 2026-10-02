// M17 D2 (docs/design/depth-25d.md section 6.1): where the body overlays sit in each character view. Pure data, no Phaser.
import type { View } from './walkQueue';

export interface ViewOffsets {
  /** The chest badge (unread indicator) is drawn. */
  badge: boolean;
  /** A held prop is drawn (a laptop in front of a back-turned body would sit inside it). */
  prop: boolean;
  /** Goggles and shades are drawn (they sit on the face, so not from behind). */
  face: boolean;
  /** The cloak is drawn over the body (cape seen from behind) instead of behind it. */
  cloakOver: boolean;
  /** Default hand squares as `[x, y]` from the feet; null = that arm is hidden (the far arm in profile). */
  handL: [number, number] | null;
  handR: [number, number] | null;
  /** Shifts of the hat/goggles/shades and the prop along the facing direction (mirrored with `upper.scaleX`). */
  hatDx: number;
  propDx: number;
}

export const VIEW_OFFSETS: Record<View, ViewOffsets> = {
  s: { badge: true, prop: true, face: true, cloakOver: false, handL: [-4, -4], handR: [4, -4], hatDx: 0, propDx: 0 },
  n: { badge: false, prop: false, face: false, cloakOver: true, handL: [-4, -4], handR: [4, -4], hatDx: 0, propDx: 0 },
  e: { badge: false, prop: true, face: true, cloakOver: false, handL: null, handR: [1, -4], hatDx: 1, propDx: 4 },
};
