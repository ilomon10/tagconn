// M16 L2: visual heights of furniture by kind (docs/design/lighting.md section 2.3, D2: by kind only). Pure.
// Px above the floor; 0 = flat (rugs, mats, sigils, wall art, banners, chairs, crates, bins, stairs).
import type { FurnitureKind } from '../procgen/types';

export const KIND_HEIGHT: Record<FurnitureKind, number> = {
  'work-desk': 6,
  'lead-desk': 6,
  table: 5,
  board: 12,
  workbench: 6,
  booth: 8,
  rack: 13,
  shelf: 12,
  sofa: 7,
  armchair: 7,
  rug: 0,
  mat: 0,
  counter: 8,
  plant: 9,
  centerpiece: 8,
  pedestal: 6,
  sigil: 0,
  'stairs-up': 0,
  'stairs-down': 0,
  'rack-row': 14,
  console: 8,
  'lab-bench': 6,
  equipment: 10,
  'shelf-stack': 13,
  'reading-table': 5,
  'standing-table': 6,
  'reception-desk': 8,
  bench: 4,
  lamp: 10,
  crate: 0,
  'wall-art': 0,
  bin: 0,
  cabinet: 12,
  chair: 0,
  banner: 0,
  printer: 12,
  fridge: 14,
  'water-cooler': 12,
  'filing-cabinet': 12,
  'coffee-machine': 8,
  bookcase: 14,
  fireplace: 14,
  'coat-rack': 12,
  'supply-stack': 12,
  cage: 13,
  'notice-board': 12,
  'roster-board': 12,
  arcade: 14,
  'ping-pong': 5,
  foosball: 5,
  'board-game-table': 5,
};

/** Kinds at or above this height block light (bookcases, racks, cages, appliances); desks do not. */
export const OCCLUDER_MIN_HEIGHT_PX = 10;
/** The visual height of a wall tile. */
export const WALL_HEIGHT_PX = 16;

/** Height of `kind` in `table`. Own-property guard: a kind that is not a key of the table (`__proto__`, `constructor`,
 *  an unknown string from a hand-edited layout) is height 0, so it never produces an occluder or a shadow. */
export function kindHeight(kind: string, table: Readonly<Record<string, number>> = KIND_HEIGHT): number {
  if (!Object.prototype.hasOwnProperty.call(table, kind)) return 0;
  const h = table[kind];
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : 0;
}
