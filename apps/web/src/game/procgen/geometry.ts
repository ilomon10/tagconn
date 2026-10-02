// apps/web/src/game/procgen/geometry.ts  (M15 T2, docs/design/navigation.md section 1.2)
//
// The one rasterizer for furniture rects. M15 lets pins sit on half tiles (`x = 2.5`), while every
// consumer of procgen (walkable, reachability, seats, spots, aprons) keeps thinking in whole tiles:
// "any overlap blocks the tile". Every cell loop over a furniture rect goes through `rectCells` /
// `cellKeys`, so an integer rect produces exactly the cells the old local loops did (integer layouts
// stay byte-identical) and a half-offset rect covers every tile it touches. Pure, no Phaser.
import { coveredTileRect, coveredTiles, rectsIntersect } from '@tagconn/shared';
import type { Point, Rect } from './types';

export { coveredTileRect, coveredTiles, rectsIntersect };

export const tileKey = (p: Point): string => `${p.x},${p.y}`;

/** Integer tiles a (possibly half-offset) rect touches, row-major. For integer rects: the old `rectCells` exactly. */
export function rectCells(r: Rect): Point[] {
  return coveredTiles(r);
}

/** `rectCells` as "x,y" keys, the shape the procgen cell sets use. */
export function cellKeys(r: Rect): string[] {
  return rectCells(r).map(tileKey);
}

/** Exact (not tile-rounded) overlap with any rect in `others`: two half-offset pins may share a tile without overlapping. */
export function overlapsAny(r: Rect, others: readonly Rect[]): boolean {
  return others.some((o) => rectsIntersect(r, o));
}

/** Nearest multiple of `HALF_TILE`. */
export const snapHalf = (v: number): number => Math.round(v * 2) / 2;

/** Position on the half-tile grid, size in whole tiles (the only rects procgen accepts this milestone). */
export const isHalfAligned = (r: Rect): boolean =>
  [r.x, r.y].every((v) => Number.isInteger(v * 2)) && Number.isInteger(r.w) && Number.isInteger(r.h);
