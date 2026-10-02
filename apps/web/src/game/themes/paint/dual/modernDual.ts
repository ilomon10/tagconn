// apps/web/src/game/themes/paint/dual/modernDual.ts  (M15 dual grid, docs/design/dual-grid.md section 3, modern column)
//
// Edge art for the modern office, drawn per dual cell on top of the per-tile paint: a crisp 1 px dark outline
// around every wall cap with r = 2 rounded outer and inner corners, a soft shadow on the floor where it meets a
// wall (2 px under a wall to the north), a 2 px ledge where floor or wall drops into the void to the south and a
// 1 px rim on the other void edges, and rounded corners on floor or wall peninsulas that stick into the void.
// Every rect stays inside the cell and off face, band and door quadrants (section 0 invariants). Colours are
// module constants matching `paint/walls.ts` / `paint/floors.ts`; the cell's own masks and `quadrantTile` say
// what each quadrant is, so nothing here derives a tile from the cell origin (never `tileOf`, invariant 7).
import type * as Phaser from 'phaser';
import type { Rect } from '../../../procgen/types';
import { BIT, faceMask, isUniform, quadrantRect, quadrantTile, type DualCell, type FloorKind, type Quadrant } from '../../dual/dualGrid';
import { boundaryHalfEdges, HALF_EDGE_QUADRANTS, halfEdgeStrip, shapeOf, type Side } from '../../dual/dualGeom';
import type { DualCtx } from '../../types';
import { lighten, rectFn, T, type RectFn } from '../util';

// `paint/walls.ts` WALL_TOP and `paintModernVoid`'s base.
const WALL_TOP = 0xe8e2d0;
const VOID_BASE = 0x2b2724;
/** The wall-cap outline: one dark line where the per-tile `WALL_EDGE` row used to be. */
export const CAP_OUTLINE = 0x6b6454;
/** Where floor or wall drops into the void: a 2 px solid ledge to the south, a 1 px translucent rim elsewhere. */
export const CLIFF = 0x1f1b18;
const CLIFF_RIM_ALPHA = 0.6;
const LEDGE_PX = 2;
/** Floor-side shadow along a wall: black at low alpha, so it works on every floor colour. */
const SHADOW = 0x000000;
const SHADOW_ALPHA = 0.16;
const SHADOW_NORTH_PX = 2;
/** Corner radius of the outline on outer and inner wall corners and on peninsulas (`cornerCut` r = 2 geometry). */
const CORNER_R = 2;

/** Modern floor base and accent per kind (corner cuts show them). Kept equal to `modernTheme.palette.floorBase` /
 *  `floorAccent` (a test guards it); the dual painter only receives a `DualCtx`, not the palette. */
export const MODERN_FLOOR_BASE: Record<FloorKind, number> = {
  hall: 0x6b4f3a,
  corridor: 0x6b4f3a,
  'pm-office': 0x7a4a3e,
  desks: 0x4a5870,
  'meeting-room': 0x56664a,
  whiteboard: 0x5a5472,
  library: 0x5e4533,
  'qa-lab': 0x8fa3aa,
  'review-booth': 0x645682,
  'server-room': 0x3a4252,
  lounge: 0x7d6848,
  entrance: 0x7a766d,
  stairs: 0x5d5872,
};
export const MODERN_FLOOR_ACCENT: Record<FloorKind, number> = {
  hall: 0x5d4432,
  corridor: 0x5d4432,
  'pm-office': 0x6c4036,
  desks: 0x435066,
  'meeting-room': 0x4d5c42,
  whiteboard: 0x514b68,
  library: 0x533c2c,
  'qa-lab': 0x82979e,
  'review-booth': 0x5a4d76,
  'server-room': 0x333a48,
  lounge: 0x735f40,
  entrance: 0x6d6960,
  stairs: 0x514c66,
};
/** Kinds `paintModernFloor` fills entirely with the accent on even-parity tiles. */
const CHECKER_KINDS: ReadonlySet<FloorKind> = new Set(['pm-office', 'desks', 'meeting-room', 'whiteboard', 'review-booth', 'stairs']);

/** The quadrant across the cell centre from `q`. */
const DIAGONAL: Record<Quadrant, Quadrant> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
/** The wall quadrant that would be a face over a floor quadrant (back-wall.md: wall `tl` over `bl`, `tr` over `br`). */
const ABOVE: Partial<Record<Quadrant, Quadrant>> = { bl: 'tl', br: 'tr' };

const isTop = (q: Quadrant): boolean => q === 'tl' || q === 'tr';

/** On a boundary half-edge of `mask`, the quadrant that is set. */
function setQuadrant(mask: number, side: Side): Quadrant {
  const [a, b] = HALF_EDGE_QUADRANTS[side];
  return mask & BIT[a] ? a : b;
}

/** The quadrant on the other side of half-edge `side` from `q`. */
function across(side: Side, q: Quadrant): Quadrant {
  const [a, b] = HALF_EDGE_QUADRANTS[side];
  return q === a ? b : a;
}

/** Tile parity of a quadrant, as `paintModernFloor` / `paintModernVoid` compute it from `tileOf` (`(tx + ty) % 2 === 0`). */
function evenTile(cell: DualCell, q: Quadrant): boolean {
  const { x, y } = quadrantTile(cell, q);
  return (x + y) % 2 === 0;
}

/** What a floor quadrant's per-tile paint looks like at the corner: the accent on even checker tiles, else the base. */
function floorColour(cell: DualCell, q: Quadrant): number {
  const kind = cell.floorKinds[q] ?? 'corridor';
  return CHECKER_KINDS.has(kind) && evenTile(cell, q) ? MODERN_FLOOR_ACCENT[kind] : MODERN_FLOOR_BASE[kind];
}

/** `paintModernVoid`'s dithered checker colour for a void quadrant. */
function voidColour(cell: DualCell, q: Quadrant): number {
  return evenTile(cell, q) ? lighten(VOID_BASE, 0.03) : VOID_BASE;
}

/** What a corner cut opens onto: the colour of the quadrant diagonally across the centre. */
function outsideColour(cell: DualCell, q: Quadrant): number {
  const d = DIAGONAL[q];
  return cell.kinds[d] === 'floor' ? floorColour(cell, d) : voidColour(cell, d);
}

/**
 * A rect in the corner frame of quadrant `q`: `(i, j)` counts pixels from the cell centre into `q`, the same
 * frame as `cornerCut` (`frameRect(q, 0, 0, 1, 1)` is its r=1 pixel). Negative `i`/`j` reach across the centre
 * into the neighbouring quadrants, which is how a ledge under `q` or a rim beside it is placed.
 */
function frameRect(cell: Pick<DualCell, 'cx' | 'cy'>, q: Quadrant, i: number, j: number, w: number, h: number, size: number): Rect {
  const cx = cell.cx * size;
  const cy = cell.cy * size;
  const left = q === 'tl' || q === 'bl';
  return { x: left ? cx - i - w : cx + i, y: isTop(q) ? cy - j - h : cy + j, w, h };
}

/** `strip` (a `halfEdgeStrip` along `side`) with `by` px removed at its centre end. */
function trimStrip(strip: Rect, side: Side, by: number): Rect {
  switch (side) {
    case 'n':
      return { ...strip, h: strip.h - by };
    case 's':
      return { ...strip, y: strip.y + by, h: strip.h - by };
    case 'w':
      return { ...strip, w: strip.w - by };
    case 'e':
      return { ...strip, x: strip.x + by, w: strip.w - by };
  }
}

/** `rect` with its top `bandPx` rows inside quadrant `q` removed (the band and baseboard live there); null when empty. */
function clipBand(rect: Rect, cell: DualCell, q: Quadrant, bandPx: number, size: number): Rect | null {
  const top = Math.max(rect.y, quadrantRect(cell, q, size).y + bandPx);
  const h = rect.y + rect.h - top;
  return h > 0 ? { x: rect.x, y: top, w: rect.w, h } : null;
}

function fill(rect: RectFn, c: number, r: Rect, a?: number): void {
  rect(c, r.x, r.y, r.w, r.h, a);
}

/** `q` is the only non-void quadrant: a floor or wall peninsula whose void-side corner the floor pass rounds. */
function isPeninsula(cell: DualCell, q: Quadrant): boolean {
  return cell.voidMask === (0xf & ~BIT[q]);
}

/** An inner wall corner is rounded into a void notch, or a floor notch beside the walls (`tl`/`tr`); a floor notch
 *  under a wall sits under the back-wall band, and a door notch stays square (invariant 8). */
function roundsNotch(cell: DualCell, notch: Quadrant): boolean {
  if (cell.kinds[notch] === 'void') return true;
  return cell.kinds[notch] === 'floor' && isTop(notch) && !(cell.doorMask & BIT[notch]);
}

/**
 * The plain wall top WITHOUT the per-tile edge line (`paintDualWall` draws the real outline). Zero `rand()` draws,
 * exactly like `paintModernWall(g, px, py, false, rand)`, so the pass-1 stream is identical with the dual grid on
 * and off.
 */
export function paintModernWallBase(g: Phaser.GameObjects.Graphics, px: number, py: number, _rand: () => number): void {
  rectFn(g)(WALL_TOP, px, py, T, T);
}

/**
 * The void side of a peninsula corner (`q` is the only non-void quadrant). Void to the south: the 2 px ledge under
 * `q` climbs through the corner pixels as a stair, so the corner reads rounded with its ledge following it, and
 * the rim beside `q` steps around the stair. Void to the north: the three corner pixels (`cornerCut` r=2) take
 * the void colour and the rims above and beside `q` step around the cut.
 */
function paintRoundedCliff(rect: RectFn, cell: DualCell, q: Quadrant, size: number): void {
  const half = size / 2;
  const rim = (i: number, j: number, w: number, h: number): void => fill(rect, CLIFF, frameRect(cell, q, i, j, w, h, size), CLIFF_RIM_ALPHA);
  if (isTop(q)) {
    rim(-1, 0, 1, half);
    fill(rect, CLIFF, frameRect(cell, q, CORNER_R, -LEDGE_PX, half - CORNER_R, LEDGE_PX, size));
    fill(rect, CLIFF, frameRect(cell, q, 1, -1, 1, LEDGE_PX, size));
    fill(rect, CLIFF, frameRect(cell, q, 0, 0, 1, LEDGE_PX, size));
    rim(0, -1, 1, 1);
    rim(1, -2, 1, 1);
  } else {
    const v = voidColour(cell, DIAGONAL[q]);
    fill(rect, v, frameRect(cell, q, 0, 0, 2, 1, size));
    fill(rect, v, frameRect(cell, q, 0, 1, 1, 1, size));
    rim(-1, CORNER_R, 1, half - CORNER_R);
    rim(CORNER_R, -1, half - CORNER_R, 1);
    rim(1, 0, 1, 1);
    rim(0, 1, 1, 1);
  }
}

/**
 * Floor-side art of one cell: a translucent shadow on the floor side of every wall/floor half-edge (1 px, 2 px
 * under a wall to the north; never on a door quadrant; under a face quadrant it starts `bandPx` lower when
 * `facePass`), then the cliffs on the void side of every floor-or-wall/void half-edge: a 2 px ledge where the
 * void is south, a 1 px rim elsewhere, rounded on a peninsula (see `paintRoundedCliff`). No `rand()` draws.
 */
export function paintModernDualFloor(g: Phaser.GameObjects.Graphics, ctx: DualCtx, _rand: () => number): void {
  const { cell, px, py, T: size } = ctx;
  if (isUniform(cell)) return;
  const rect = rectFn(g);
  const faces = faceMask(cell);

  for (const side of boundaryHalfEdges(cell.floorMask)) {
    const q = setQuadrant(cell.floorMask, side);
    if (cell.doorMask & BIT[q]) continue;
    // Floor/void half-edges get the cliff below, not a shadow.
    if (cell.kinds[across(side, q)] !== 'wall') continue;
    const wallNorth = (side === 'e' || side === 'w') && !isTop(q);
    let strip: Rect | null = halfEdgeStrip(px, py, size, side, q, wallNorth ? SHADOW_NORTH_PX : 1);
    const above = ABOVE[q];
    if (ctx.facePass && above && faces & BIT[above]) strip = clipBand(strip, cell, q, ctx.bandPx, size);
    if (strip) fill(rect, SHADOW, strip, SHADOW_ALPHA);
  }

  const solid = shapeOf(0xf & ~cell.voidMask);
  if (solid.kind === 'convex' && !(cell.doorMask & BIT[solid.q])) {
    paintRoundedCliff(rect, cell, solid.q, size);
    return;
  }
  // Rims first, ledges after: where the two meet at a notch the solid ledge overdraws the translucent rim.
  const ledges: Rect[] = [];
  for (const side of boundaryHalfEdges(cell.voidMask)) {
    const q = setQuadrant(cell.voidMask, side);
    const ledge = (side === 'e' || side === 'w') && !isTop(q);
    if (ledge) ledges.push(halfEdgeStrip(px, py, size, side, q, LEDGE_PX));
    else fill(rect, CLIFF, halfEdgeStrip(px, py, size, side, q, 1), CLIFF_RIM_ALPHA);
  }
  for (const ledge of ledges) fill(rect, CLIFF, ledge);
  // A door peninsula stays square: the rim beside it runs on down alongside its ledge.
  if (solid.kind === 'convex' && isTop(solid.q)) fill(rect, CLIFF, frameRect(cell, solid.q, -1, -LEDGE_PX, 1, LEDGE_PX, size), CLIFF_RIM_ALPHA);
}

/**
 * Wall-side art of one cell: the 1 px cap outline on the wall side of every wall/non-wall half-edge, never on a
 * face quadrant; r = 2 rounded corners. On an outer corner the two outline strips stop short, the three corner
 * pixels take the outside colour (or the ledge stair the floor pass laid on a peninsula) and one outline pixel
 * steps in diagonally. On a rounded inner corner the strips stop short too, the notch's centre pixel becomes
 * wall top and two outline pixels close the diagonal. Diagonal masks get outlines on all four half-edges and no
 * cut. No `rand()` draws.
 */
export function paintModernDualWall(g: Phaser.GameObjects.Graphics, ctx: DualCtx, _rand: () => number): void {
  const { cell, px, py, T: size } = ctx;
  if (isUniform(cell)) return;
  const rect = rectFn(g);
  const faces = faceMask(cell);
  const shape = shapeOf(cell.wallMask);

  // The quadrant whose centre corner gets rounded: the wall of an outer corner or the notch of an inner one.
  let corner: Quadrant | null = null;
  if (shape.kind === 'convex' && !(faces & BIT[shape.q])) corner = shape.q;
  else if (shape.kind === 'concave' && roundsNotch(cell, shape.notch)) corner = shape.notch;

  for (const side of boundaryHalfEdges(cell.wallMask)) {
    const q = setQuadrant(cell.wallMask, side);
    if (faces & BIT[q]) continue;
    let strip = halfEdgeStrip(px, py, size, side, q, 1);
    if (corner && HALF_EDGE_QUADRANTS[side].includes(corner)) strip = trimStrip(strip, side, CORNER_R);
    fill(rect, CAP_OUTLINE, strip);
  }

  if (!corner) return;
  if (shape.kind === 'convex') {
    if (!isPeninsula(cell, corner)) {
      const c = outsideColour(cell, corner);
      fill(rect, c, frameRect(cell, corner, 0, 0, 2, 1, size));
      fill(rect, c, frameRect(cell, corner, 0, 1, 1, 1, size));
    }
    fill(rect, CAP_OUTLINE, frameRect(cell, corner, 1, 1, 1, 1, size));
  } else {
    fill(rect, WALL_TOP, frameRect(cell, corner, 0, 0, 1, 1, size));
    fill(rect, CAP_OUTLINE, frameRect(cell, corner, 1, 0, 1, 1, size));
    fill(rect, CAP_OUTLINE, frameRect(cell, corner, 0, 1, 1, 1, size));
  }
}
