/**
 * Pure, Phaser-free types for the M8 8e bubble/label declutter engine (docs/design/guild-hall.md
 * doesn't cover this — see ROADMAP.md M8 8e). `OfficeScene`/`Character` are the only Phaser-side
 * consumers; everything in `game/labels/**` is plain math so it can be unit tested without a scene.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/** One character's speech bubble (or name tag) up for placement this pass. */
export interface LabelSubject {
  id: string;
  /** World-space point the label points down at — roughly the character's head, at zoom 1. */
  anchor: Point;
  /** Measured content size at zoom 1 (bubble text box, or the name tag's box). */
  box: Size;
  /** The drawer is open on this agent: always kept, never collapsed, first pick of the slots. */
  selected: boolean;
  /** waiting-for-you or blocked: kept ahead of "others", still shown when collapsed elsewhere applies LOD. */
  waiting: boolean;
  /** Higher = more recently active; the tiebreak among plain "others" (docs: "most recent > others"). */
  recency: number;
}

/** Where a subject's box ended up relative to its `above` default. */
export type SlotKind = 'above' | 'above-left' | 'above-right' | 'stacked';

export interface LabelPlacement {
  id: string;
  /** Offset from the subject's `anchor`, world px at zoom 1. */
  dx: number;
  dy: number;
  slot: SlotKind;
  /** True once displaced off the plain "above" slot — the caller draws a short leader line back to the anchor. */
  leader: boolean;
  /** Past `maxBubbles` (in priority order): show a small "…" badge instead of the real content. */
  collapsed: boolean;
}

export interface LayoutOptions {
  /** How many subjects (in priority order) get their real box; the rest collapse to a badge. */
  maxBubbles: number;
  /** Extra clearance required between any two placed boxes. */
  padding?: number;
  /** Vertical gap between the anchor and the "above" slot's bottom edge. */
  gap?: number;
  /** Extra horizontal clearance the above-left/above-right slots add beyond the box's own half-width. */
  lateralGap?: number;
  /** Extra vertical clearance between stacked levels. */
  stackGap?: number;
  /** How many stacked levels to try before giving up and using the highest one anyway (best effort). */
  maxStackLevels?: number;
  /** Box size used for a collapsed ("…" badge) placement, regardless of the subject's real box. */
  badgeSize?: Size;
}
