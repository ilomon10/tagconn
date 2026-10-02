// apps/web/src/game/nav/types.ts  (M15, docs/design/navigation.md)
//
// Type-only (no runtime code) so procgen/types.ts can reference `NavGrid` without a cycle.

/** The sub-tile collision grid: the source of truth for walkability (`map.walkable` is derived from it). */
export interface NavGrid {
  /** Map size in tiles. */
  cols: number;
  rows: number;
  /** Grid size in nav cells (`cols * SUB`, `rows * SUB`). */
  ccols: number;
  crows: number;
  /** Per tile (`y * cols + x`): low nibble = walkable cell bits, high nibble = `TILE_FLAG_*`. */
  masks: Uint8Array;
  /** Per cell (`cy * ccols + cx`): true clearance, 0 = blocked, saturating at `CLEARANCE_MAX`. */
  clearance: Uint8Array;
}

/** Inclusive-exclusive rect in nav cells: `x0 <= cx < x1`, `y0 <= cy < y1`. */
export interface CellRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
