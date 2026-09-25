import type { Zone } from '@tagconn/shared';

/**
 * Reduced to a re-export (M7 7e): the pre-M7 fixed office grid (`buildOfficeMap`, `renderMap`) is
 * gone — the map is now `generateMap(layout)` from `../procgen` painted by a theme
 * (`../themes/renderTheme`). `Rect` and `DEFAULT_ZONE_RECTS` survive only because the deprecated
 * `office.zones` settings editor (`features/settings/RecordEditors.tsx`) still shows them as the
 * default value for a manual zone override. Delete this file once that editor is removed.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DEFAULT_ZONE_RECTS: Record<Zone, Rect> = {
  'pm-office': { x: 1, y: 1, w: 9, h: 7 },
  'meeting-room': { x: 11, y: 1, w: 11, h: 7 },
  whiteboard: { x: 23, y: 1, w: 8, h: 7 },
  library: { x: 32, y: 1, w: 15, h: 7 },
  desks: { x: 1, y: 10, w: 27, h: 10 },
  'review-booth': { x: 30, y: 11, w: 7, h: 8 },
  'qa-lab': { x: 39, y: 11, w: 8, h: 8 },
  lounge: { x: 1, y: 22, w: 13, h: 7 },
  entrance: { x: 17, y: 22, w: 10, h: 7 },
  'server-room': { x: 31, y: 22, w: 16, h: 7 },
};
