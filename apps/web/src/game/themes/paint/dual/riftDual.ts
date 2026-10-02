// apps/web/src/game/themes/paint/dual/riftDual.ts  (M15 dual grid, docs/design/dual-grid.md section 3, rift column)
//
// The rift's dual-cell edge art: a lit obsidian rim on wall caps with chamfered outer corners, a teal
// glow where floor meets a wall, and a 1 px crystal rim on the void side of every cliff. The rim is one
// pixel so the floating-island jag `paintRiftIslandEdge` paints just below it stays visible. Every rect
// is built from the cell's own masks and `dualGeom`; never `tileOf` on a cell origin (invariant 7).
import type * as Phaser from 'phaser';
import type { Rect } from '../../../procgen/types';
import { BIT, faceMask, isUniform, quadrantRect, type DualCell, type FloorKind, type Quadrant } from '../../dual/dualGrid';
import { boundaryHalfEdges, cornerCut, HALF_EDGE_QUADRANTS, halfEdgeStrip, shapeOf, type Side } from '../../dual/dualGeom';
import type { DualCtx } from '../../types';
import { lighten, rectFn, T, type RectFn } from '../util';

// Module constants matching `paint/riftWalls.ts`, `paint/riftFloors.ts` and `rift.ts`'s palette.
const OBSIDIAN = 0x161022;
const TEAL_MORTAR = 0x1f5a5a;
const VOID_BASE = 0x0b0820;
const CRYSTAL_BASE = 0x2a2350;
const BRIDGE_BASE = 0x1c1a2e;

/** The wall-cap outline: a lit obsidian rim where the per-tile top line used to be. */
export const RIFT_CAP_RIM = lighten(OBSIDIAN, 0.35);
/** Floor-side glow along a wall. */
const GLOW_ALPHA = 0.45;
/** Void-side crystal rim along a cliff. */
const CLIFF_ALPHA = 0.7;
/** The occasional brighter pixel on a glow strip (`rand() < FLICKER_CHANCE`). */
const FLICKER_CHANCE = 0.1;
const FLICKER_COLOR = lighten(TEAL_MORTAR, 0.4);

/** Same split as `rift.ts` `FLOOR_BASE`: bridges for open floor, crystal for every room. */
function floorBase(kind: FloorKind | null): number {
  return kind === 'hall' || kind === 'corridor' ? BRIDGE_BASE : CRYSTAL_BASE;
}

/** The quadrant across the cell centre from `q`. */
function diagonalOf(q: Quadrant): Quadrant {
  return q === 'tl' ? 'br' : q === 'br' ? 'tl' : q === 'tr' ? 'bl' : 'tr';
}

/** The quadrant on the other side of half-edge `side` from `q`. */
function across(side: Side, q: Quadrant): Quadrant {
  const [a, b] = HALF_EDGE_QUADRANTS[side];
  return q === a ? b : a;
}

/** Bits of the floor quadrants that sit under a face quadrant (`bl` under `tl`, `br` under `tr`). */
function underFaceMask(cell: DualCell): number {
  const faces = faceMask(cell);
  return (faces & BIT.tl ? BIT.bl : 0) | (faces & BIT.tr ? BIT.br : 0);
}

/** `rect` with its top `bandPx` rows inside quadrant `q` removed (the band and baseboard live there); null when empty. */
function clipBand(rect: Rect, cell: DualCell, q: Quadrant, bandPx: number, cellT: number): Rect | null {
  const qr = quadrantRect(cell, q, cellT);
  const top = Math.max(rect.y, qr.y + bandPx);
  const h = rect.y + rect.h - top;
  return h > 0 ? { x: rect.x, y: top, w: rect.w, h } : null;
}

/**
 * The obsidian wall top WITHOUT the lit top line (`paintDualWall` draws the rim instead). Consumes exactly
 * the `rand()` draws of `paintRiftWall(g, px, py, false, rand)`: `rand() < 0.2`, then two more for the speck.
 */
export function paintRiftWallBase(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void {
  const rect = rectFn(g);
  rect(OBSIDIAN, px, py, T, T);
  for (let y = 4; y < T; y += 4) rect(TEAL_MORTAR, px, py + y, T, 1, 0.5);
  if (rand() < 0.2) rect(TEAL_MORTAR, px + Math.floor(rand() * T), py + Math.floor(rand() * T), 1, 1, 0.7);
}

/**
 * Floor-side art of one cell: a 1 px teal glow on the floor side of every wall/floor boundary half-edge
 * (never on a door quadrant; under a face quadrant it starts `bandPx` lower when `facePass`), plus a 1 px
 * crystal rim on the void side of every cliff. The rim is exactly one pixel into the void, touching the
 * boundary, so `paintIslandEdge`'s jag under a realm reads through it.
 */
export function paintRiftDualFloor(g: Phaser.GameObjects.Graphics, ctx: DualCtx, rand: () => number): void {
  const { cell, px, py, T: cellT } = ctx;
  if (isUniform(cell)) return;
  const rect = rectFn(g);
  const underFace = ctx.facePass ? underFaceMask(cell) : 0;

  const glows: Rect[] = [];
  for (const side of boundaryHalfEdges(cell.floorMask)) {
    const [a, b] = HALF_EDGE_QUADRANTS[side];
    const q = cell.floorMask & BIT[a] ? a : b;
    if (cell.doorMask & BIT[q]) continue;
    if (cell.kinds[across(side, q)] !== 'wall') continue;
    let strip: Rect | null = halfEdgeStrip(px, py, cellT, side, q, 1);
    if (underFace & BIT[q]) strip = clipBand(strip, cell, q, ctx.bandPx, cellT);
    if (!strip) continue;
    rect(TEAL_MORTAR, strip.x, strip.y, strip.w, strip.h, GLOW_ALPHA);
    glows.push(strip);
  }

  for (const side of boundaryHalfEdges(cell.voidMask)) {
    const [a, b] = HALF_EDGE_QUADRANTS[side];
    const q = cell.voidMask & BIT[a] ? a : b;
    const strip = halfEdgeStrip(px, py, cellT, side, q, 1);
    rect(TEAL_MORTAR, strip.x, strip.y, strip.w, strip.h, CLIFF_ALPHA);
  }

  // An occasional brighter pixel somewhere along one of the glow strips.
  if (glows.length && rand() < FLICKER_CHANCE) {
    const strip = glows[Math.floor(rand() * glows.length)]!;
    const along = Math.floor(rand() * Math.max(strip.w, strip.h));
    const x = strip.w > strip.h ? strip.x + along : strip.x;
    const y = strip.h > strip.w ? strip.y + along : strip.y;
    rect(FLICKER_COLOR, x, y, 1, 1, 0.6);
  }
}

/** The rim pixel one step in from the centre on the diagonal of quadrant `q`: `cornerCut(.., 2)`'s (1,0) x and (0,1) y. */
function stepPixel(cuts: Rect[]): Rect {
  return { x: cuts[1]!.x, y: cuts[2]!.y, w: 1, h: 1 };
}

/**
 * Wall-side art of one cell: the lit obsidian rim on the wall side of every wall/non-wall boundary half-edge,
 * a chamfered outer corner (r = 2 cut in the outside colour, rim stepped in by one) and an obsidian inner
 * corner (r = 1). Face quadrants are never touched; a door notch stays square; a notch under a face
 * quadrant is left to the band when `facePass`. Diagonal masks get rims on all four half-edges, no cuts.
 */
export function paintRiftDualWall(g: Phaser.GameObjects.Graphics, ctx: DualCtx, _rand: () => number): void {
  const { cell, px, py, T: cellT } = ctx;
  if (isUniform(cell)) return;
  const rect: RectFn = rectFn(g);
  const faces = faceMask(cell);

  for (const side of boundaryHalfEdges(cell.wallMask)) {
    const [a, b] = HALF_EDGE_QUADRANTS[side];
    const q = cell.wallMask & BIT[a] ? a : b;
    if (faces & BIT[q]) continue;
    const strip = halfEdgeStrip(px, py, cellT, side, q, 1);
    rect(RIFT_CAP_RIM, strip.x, strip.y, strip.w, strip.h);
  }

  const shape = shapeOf(cell.wallMask);
  if (shape.kind === 'convex') {
    if (faces & BIT[shape.q]) return;
    const outside = diagonalOf(shape.q);
    const color = cell.kinds[outside] === 'floor' ? floorBase(cell.floorKinds[outside]) : VOID_BASE;
    const cuts = cornerCut(cell, shape.q, 2, cellT);
    for (const c of cuts) rect(color, c.x, c.y, c.w, c.h);
    const step = stepPixel(cuts);
    rect(RIFT_CAP_RIM, step.x, step.y, step.w, step.h);
  } else if (shape.kind === 'concave') {
    const { notch } = shape;
    if (cell.doorMask & BIT[notch]) return;
    if (ctx.facePass && underFaceMask(cell) & BIT[notch]) return;
    const [pixel] = cornerCut(cell, notch, 1, cellT);
    rect(OBSIDIAN, pixel!.x, pixel!.y, pixel!.w, pixel!.h);
  }
}
