// apps/web/src/game/procgen/backWallSpec.ts  (M8 8p, owned by procgen, see docs/design/back-wall.md)
//
// Data only: no runtime logic beyond constants, so `themes/paint/**` can import it immediately (T0)
// and `procgen/backWall.ts` (T1) builds the actual placement algorithm on top of these tables.
import type { RoomType } from '@tagconn/shared';
import type { FurnitureKind, WallDecorKind } from './types';

export type ApplianceKind =
  | 'printer'
  | 'fridge'
  | 'water-cooler'
  | 'filing-cabinet'
  | 'coffee-machine'
  | 'bookcase'
  | 'fireplace'
  | 'coat-rack'
  | 'supply-stack'
  | 'cage';

/** Footprint width (h is always 1) and max art height above the footprint, in px. */
export const APPLIANCE_SPECS: Record<ApplianceKind, { w: 1 | 2; overdrawPx: number }> = {
  printer: { w: 1, overdrawPx: 10 },
  fridge: { w: 1, overdrawPx: 12 },
  'water-cooler': { w: 1, overdrawPx: 12 },
  'filing-cabinet': { w: 1, overdrawPx: 8 },
  'coffee-machine': { w: 1, overdrawPx: 6 },
  bookcase: { w: 2, overdrawPx: 12 },
  fireplace: { w: 2, overdrawPx: 12 },
  'coat-rack': { w: 1, overdrawPx: 10 },
  'supply-stack': { w: 1, overdrawPx: 8 },
  cage: { w: 2, overdrawPx: 12 },
};

export const MAX_OVERDRAW_PX = 12;

/** Existing kinds a painter MAY draw tall when `againstNorthWall` (wall decor avoids their columns). */
export const TALL_AGAINST_WALL_KINDS: ReadonlySet<FurnitureKind> = new Set(['board', 'shelf', 'cabinet', 'shelf-stack', 'counter']);

export const WALL_DECOR_SPANS: Record<WallDecorKind, readonly number[]> = {
  window: [1, 2],
  clock: [1],
  picture: [1, 2],
  board: [2, 3],
  chart: [1, 2],
  'wall-shelf': [1, 2],
  banner: [1],
};

/** Weighted menus per room type (weight = repeat count). Types absent here get none. */
export const APPLIANCE_MENU: Partial<Record<RoomType, readonly ApplianceKind[]>> = {
  desks: ['printer', 'printer', 'filing-cabinet', 'filing-cabinet', 'water-cooler', 'bookcase', 'supply-stack'],
  'pm-office': ['bookcase', 'bookcase', 'filing-cabinet', 'coat-rack', 'fireplace'],
  'meeting-room': ['coffee-machine', 'bookcase', 'fireplace'],
  whiteboard: ['filing-cabinet', 'supply-stack'],
  library: ['bookcase', 'bookcase', 'bookcase', 'fireplace'],
  'qa-lab': ['fridge', 'filing-cabinet', 'supply-stack'],
  'review-booth': ['filing-cabinet', 'bookcase'],
  'server-room': ['cage', 'cage', 'filing-cabinet', 'supply-stack'],
  lounge: ['fridge', 'coffee-machine', 'coffee-machine', 'water-cooler', 'fireplace'],
  entrance: ['water-cooler', 'coat-rack', 'bookcase'],
};

/** Weighted menus per room type (weight = repeat count). Types absent here get none. */
export const WALL_DECOR_MENU: Partial<Record<RoomType, readonly WallDecorKind[]>> = {
  desks: ['window', 'window', 'clock', 'picture', 'chart'],
  'pm-office': ['picture', 'picture', 'window', 'wall-shelf', 'banner'],
  'meeting-room': ['board', 'picture', 'clock', 'window'],
  whiteboard: ['chart', 'chart', 'clock'],
  library: ['wall-shelf', 'wall-shelf', 'window', 'picture'],
  'qa-lab': ['chart', 'chart', 'clock', 'wall-shelf'],
  'review-booth': ['picture', 'board', 'clock'],
  'server-room': ['chart', 'clock'], // no windows
  lounge: ['window', 'window', 'picture', 'picture', 'clock', 'banner'],
  entrance: ['banner', 'banner', 'clock', 'window', 'picture'],
};

/** Max appliances per room by density. */
export const APPLIANCE_MAX = { sparse: 1, normal: 2, dense: 3, packed: 4 } as const;
