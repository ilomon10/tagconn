import type { FurnitureKind } from '../../procgen/types';

// A compile-time-exhaustive list: adding a FurnitureKind without adding it here fails to typecheck.
const KIND_SET: Record<FurnitureKind, true> = {
  'work-desk': true, 'lead-desk': true, table: true, board: true, workbench: true, booth: true, rack: true, shelf: true,
  sofa: true, armchair: true, rug: true, mat: true, counter: true, plant: true, centerpiece: true, pedestal: true,
  sigil: true, 'stairs-up': true, 'stairs-down': true, 'rack-row': true, console: true, 'lab-bench': true,
  equipment: true, 'shelf-stack': true, 'reading-table': true, 'standing-table': true, 'reception-desk': true,
  bench: true, lamp: true, crate: true, 'wall-art': true, bin: true, cabinet: true, chair: true, banner: true,
  printer: true, fridge: true, 'water-cooler': true, 'filing-cabinet': true, 'notice-board': true, 'roster-board': true,
  arcade: true, 'ping-pong': true, foosball: true, 'board-game-table': true, 'coffee-machine': true, bookcase: true,
  fireplace: true, 'coat-rack': true, 'supply-stack': true, cage: true,
};
export const ALL_FURNITURE_KINDS = Object.keys(KIND_SET) as FurnitureKind[];
