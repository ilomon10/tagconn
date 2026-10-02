// apps/web/src/game/procgen/facingSpec.ts  (M16 W0-F: data only, D2; docs/design/furnishing.md section 1.3)
//
// Which facings a furniture kind may be placed with. Keyed by kind, never by theme: a style paints, it
// does not decide geometry. Pure TS, no Phaser.
import type { Facing } from '@tagconn/shared';
import type { FurnitureKind, Rect } from './types';

const ALL: readonly Facing[] = ['n', 'e', 's', 'w'];
const FIXED: readonly Facing[] = ['s'];

/** `['s']` = fixed (art is one-sided or symmetric: no rotation needed). e/w entries mean the footprint is swapped
 *  (w <-> h) by the recipe/editor before placement. Widened per kind when its painter grows a variant (furnishing.md section 5.3). */
export const FACING_SUPPORT: Record<FurnitureKind, readonly Facing[]> = {
  chair: ALL,
  armchair: ALL,
  sofa: ALL,
  bench: ALL,
  booth: ALL,
  counter: ALL,
  bookcase: ALL,
  shelf: ALL,
  'shelf-stack': ALL,
  cabinet: ALL,
  'filing-cabinet': ALL,
  board: ALL,
  'notice-board': ALL,
  'roster-board': ALL,
  lamp: ALL,
  plant: ALL,
  crate: ALL,
  bin: ALL,
  'coat-rack': ALL,
  'supply-stack': ALL,
  rack: ALL,
  'rack-row': ALL,
  table: ALL,
  'reading-table': ALL,
  'standing-table': ALL,
  'work-desk': FIXED,
  'lead-desk': FIXED,
  workbench: FIXED,
  'lab-bench': FIXED,
  'reception-desk': FIXED,
  console: FIXED,
  equipment: FIXED,
  fridge: FIXED,
  printer: FIXED,
  'water-cooler': FIXED,
  'coffee-machine': FIXED,
  fireplace: FIXED,
  cage: FIXED,
  arcade: FIXED,
  'ping-pong': FIXED,
  foosball: FIXED,
  'board-game-table': FIXED,
  centerpiece: FIXED,
  pedestal: FIXED,
  sigil: FIXED,
  rug: FIXED,
  mat: FIXED,
  'wall-art': FIXED,
  banner: FIXED,
  'stairs-up': FIXED,
  'stairs-down': FIXED,
};

/** Own-property lookup: a kind from stored data (`constructor`, `__proto__`) is never a key, so it is fixed (`['s']`). */
const supportOf = (kind: string): readonly Facing[] => (Object.hasOwn(FACING_SUPPORT, kind) ? FACING_SUPPORT[kind as FurnitureKind] : FIXED);

export const facingSupported = (kind: FurnitureKind, f: Facing): boolean => supportOf(kind).includes(f);

/** Next facing in the kind's list (R in the editor); `s` when the kind is fixed. */
export function nextFacing(kind: FurnitureKind, f: Facing): Facing {
  const list = supportOf(kind);
  if (list.length <= 1) return 's';
  const i = list.indexOf(f);
  return list[(i + 1) % list.length] ?? 's';
}

/** The footprint for a facing: `e`/`w` swap w and h relative to the kind's canonical (south-facing) size. */
export function footprintFor(size: { w: number; h: number }, f: Facing): { w: number; h: number } {
  return f === 'e' || f === 'w' ? { w: size.h, h: size.w } : { w: size.w, h: size.h };
}

/** The tile(s) "in front" of a rect for its facing (the clearance strip): the row south of it for `s`, north for `n`, the column east/west. */
export function frontStrip(r: Rect, f: Facing, depth = 1): Rect {
  switch (f) {
    case 'n':
      return { x: r.x, y: r.y - depth, w: r.w, h: depth };
    case 'e':
      return { x: r.x + r.w, y: r.y, w: depth, h: r.h };
    case 'w':
      return { x: r.x - depth, y: r.y, w: depth, h: r.h };
    default:
      return { x: r.x, y: r.y + r.h, w: r.w, h: depth };
  }
}
