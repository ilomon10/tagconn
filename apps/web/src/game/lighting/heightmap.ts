// M17 D3: visual height above the floor per tile (docs/design/depth-25d.md section 3.6). Pure.
// One table (`KIND_HEIGHT`) feeds walls, items and shadows alike, so a shadow length is always height x sun elevation.
import type { GeneratedMap } from '../procgen/types';
import { coveredTileRect } from '../procgen/geometry';
import { KIND_HEIGHT, WALL_HEIGHT_PX, kindHeight } from './heights';

export interface HeightMap {
  cols: number;
  rows: number;
  T: number;
  /** Per tile (`tx + ty * cols`): the max visual height above the floor, px. */
  px: Uint8Array;
}

export type HeightMapSource = Pick<GeneratedMap, 'cols' | 'rows' | 'tileSize' | 'tiles' | 'furniture'>;

/** Walls = `WALL_HEIGHT_PX`; floor/door/void = 0; each item raises every tile it touches (half-tile pins included) to
 *  `max(current, kindHeight(kind))`. A kind that is not in the table is 0. */
export function buildHeightMap(map: HeightMapSource, heights: Readonly<Record<string, number>> = KIND_HEIGHT): HeightMap {
  const { cols, rows } = map;
  const px = new Uint8Array(Math.max(0, cols * rows));
  for (let y = 0; y < rows; y++) {
    const row = map.tiles[y];
    if (!row) continue;
    for (let x = 0; x < cols; x++) if (row[x] === 'wall') px[x + y * cols] = WALL_HEIGHT_PX;
  }
  for (const f of map.furniture) {
    const h = Math.min(255, Math.round(kindHeight(f.kind, heights)));
    if (!(h > 0)) continue;
    const r = coveredTileRect(f);
    const x1 = Math.min(cols, r.x + r.w);
    const y1 = Math.min(rows, r.y + r.h);
    for (let y = Math.max(0, r.y); y < y1; y++) {
      for (let x = Math.max(0, r.x); x < x1; x++) {
        const i = x + y * cols;
        if (px[i]! < h) px[i] = h;
      }
    }
  }
  return { cols, rows, T: map.tileSize, px };
}

/** Height at a world point; 0 outside the map. */
export function heightAt(hm: HeightMap, wx: number, wy: number): number {
  const tx = Math.floor(wx / hm.T);
  const ty = Math.floor(wy / hm.T);
  if (!(tx >= 0 && ty >= 0 && tx < hm.cols && ty < hm.rows)) return 0;
  return hm.px[tx + ty * hm.cols] ?? 0;
}
