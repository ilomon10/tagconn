// apps/web/src/game/themes/paint/dual/guildDual.ts  (M15 dual grid, docs/design/dual-grid.md section 3, guild column)
//
// Edge art for the ashlar keep, drawn per dual cell on top of the per-tile paint: a lit line on a wall's north
// and west edges and a dark one on its south and east, a one-pixel chamfer on outer wall corners (inner corners
// stay sharp ashlar), a darkened floor strip where floor meets wall, and a mortar ledge where floor or wall drops
// into the void. Every rect stays inside the cell and off face, band and door quadrants (section 0 invariants).
// Colours are module constants matching `paint/walls.ts` and `guild.ts`; the cell's own masks say what each
// quadrant is, so nothing here derives a tile from pixels (never `tileOf`).
import type * as Phaser from 'phaser';
import type { Rect } from '../../../procgen/types';
import { BIT, faceMask, isUniform, quadrantRect, type DualCell, type FloorKind, type Quadrant } from '../../dual/dualGrid';
import { boundaryHalfEdges, cornerCut, HALF_EDGE_QUADRANTS, halfEdgeStrip, shapeOf, type Side } from '../../dual/dualGeom';
import type { DualCtx } from '../../types';
import { darken, lighten, rectFn, T, type RectFn } from '../util';

const GUILD_WALL_TOP = 0x5a5068;
const GUILD_VOID = 0x0e0b14;
const MOSS = 0x4d6b3a;
/** Cap outline: the light comes from the top-left, so a wall's north and west edges are lit, south and east dark. */
const CAP_LIT = lighten(GUILD_WALL_TOP, 0.3);
const CAP_DARK = darken(GUILD_WALL_TOP, 0.35);
/** Mortar ledge on a cliff: 2 px of dark mortar on the void side with a 1 px lit lip against the edge. */
const LEDGE = darken(GUILD_WALL_TOP, 0.5);
const LEDGE_LIP = lighten(LEDGE, 0.1);
const LEDGE_PX = 2;
const SHADOW_DARKEN = 0.2;
const MOSS_CHANCE = 0.1;

/** Guild floor base colour per kind (the shadow strip and chamfer pixels derive from it). Kept equal to
 *  `guildTheme.palette.floorBase` (a test guards it); the dual painter only receives a `DualCtx`, not the palette. */
export const GUILD_FLOOR_BASE: Record<FloorKind, number> = {
  hall: 0x4a4458,
  corridor: 0x3e394c,
  entrance: 0x4a4458,
  'pm-office': 0x4a4458,
  whiteboard: 0x4a4458,
  'review-booth': 0x4a4458,
  stairs: 0x4a4458,
  desks: 0x6b4f3a,
  library: 0x4a3324,
  lounge: 0x4a3324,
  'server-room': 0x1c2230,
  'qa-lab': 0x4a5a4a,
  'meeting-room': 0x6d6478,
};

/** The quadrant across the cell centre from `q`. */
const DIAGONAL: Record<Quadrant, Quadrant> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
/** The wall quadrant that would be a face over a floor quadrant (back-wall.md: wall `tl` over `bl`, `tr` over `br`). */
const ABOVE: Partial<Record<Quadrant, Quadrant>> = { bl: 'tl', br: 'tr' };

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

function floorBase(cell: DualCell, q: Quadrant): number {
  return GUILD_FLOOR_BASE[cell.floorKinds[q] ?? 'corridor'];
}

/** What a chamfer pixel shows through: the colour of the quadrant it opens onto. */
function outsideColour(cell: DualCell, q: Quadrant): number {
  if (cell.kinds[q] === 'void') return GUILD_VOID;
  if (cell.kinds[q] === 'floor') return floorBase(cell, q);
  return GUILD_WALL_TOP;
}

/** `strip` with its top `bandBottom` px removed (the band under a face quadrant); null when nothing is left. */
function belowBand(strip: Rect, bandBottom: number): Rect | null {
  const top = Math.max(strip.y, bandBottom);
  const h = strip.y + strip.h - top;
  return h > 0 ? { x: strip.x, y: top, w: strip.w, h } : null;
}

function fill(rect: RectFn, c: number, r: Rect, a?: number): void {
  rect(c, r.x, r.y, r.w, r.h, a);
}

/**
 * The ashlar wall top without the per-tile lit top line: the dual pass draws the real edges instead. Same
 * coursing, joints and moss as `paintGuildWall(g, px, py, false, rand)` and exactly the same `rand()` draws
 * (`rand() < 0.2`, then two more), so the pass-1 stream is identical with the dual grid on and off.
 */
export function paintGuildWallBase(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void {
  const rect = rectFn(g);
  rect(GUILD_WALL_TOP, px, py, T, T);
  for (let y = 0, row = 0; y < T; y += 4, row++) {
    rect(darken(GUILD_WALL_TOP, 0.18), px, py + y, T, 1);
    rect(darken(GUILD_WALL_TOP, 0.12), px + (row % 2 === 0 ? 8 : 6), py + y + 1, 1, 3);
  }
  if (rand() < 0.2) rect(MOSS, px + Math.floor(rand() * T), py + Math.floor(rand() * T), 1, 1, 0.65);
}

/**
 * Floor-side art of one cell: a 1 px darkened strip on the floor side of every wall/floor half-edge (skipping
 * door quadrants and, when `facePass`, the band under a face quadrant), and a mortar ledge on the void side of
 * every floor-or-wall/void half-edge, with an optional moss speck on the ledge (`rand() < 0.1`).
 */
export function paintGuildDualFloor(g: Phaser.GameObjects.Graphics, ctx: DualCtx, rand: () => number): void {
  const { cell, px, py, T: size } = ctx;
  if (isUniform(cell)) return;
  const rect = rectFn(g);
  const faces = faceMask(cell);

  for (const side of boundaryHalfEdges(cell.floorMask)) {
    const q = setQuadrant(cell.floorMask, side);
    if (cell.doorMask & BIT[q]) continue;
    // Floor/void half-edges get the cliff below, not a shadow.
    if (!(cell.wallMask & BIT[across(side, q)])) continue;
    let strip: Rect | null = halfEdgeStrip(px, py, size, side, q, 1);
    const above = ABOVE[q];
    if (ctx.facePass && above && faces & BIT[above]) strip = belowBand(strip, quadrantRect(cell, q, size).y + ctx.bandPx);
    if (strip) fill(rect, darken(floorBase(cell, q), SHADOW_DARKEN), strip);
  }

  let ledgeForMoss: Rect | null = null;
  for (const side of boundaryHalfEdges(cell.voidMask)) {
    const q = setQuadrant(cell.voidMask, side);
    const ledge = halfEdgeStrip(px, py, size, side, q, LEDGE_PX);
    fill(rect, LEDGE, ledge);
    fill(rect, LEDGE_LIP, halfEdgeStrip(px, py, size, side, q, 1));
    ledgeForMoss ??= ledge;
  }
  if (ledgeForMoss && rand() < MOSS_CHANCE) {
    rect(MOSS, ledgeForMoss.x + Math.floor(rand() * ledgeForMoss.w), ledgeForMoss.y + Math.floor(rand() * ledgeForMoss.h), 1, 1, 0.65);
  }
}

/**
 * Wall-side art of one cell: a 1 px cap outline on the wall side of every wall/non-wall half-edge, lit on the
 * wall's north and west edges and dark on its south and east, never on a face quadrant; a one-pixel chamfer
 * on a convex corner showing the colour of the diagonal quadrant. Inner corners and diagonals get no cut.
 */
export function paintGuildDualWall(g: Phaser.GameObjects.Graphics, ctx: DualCtx, _rand: () => number): void {
  const { cell, px, py, T: size } = ctx;
  if (isUniform(cell)) return;
  const rect = rectFn(g);
  const faces = faceMask(cell);

  for (const side of boundaryHalfEdges(cell.wallMask)) {
    const q = setQuadrant(cell.wallMask, side);
    if (faces & BIT[q]) continue;
    // The second quadrant of a half-edge lies east (n/s) or south (e/w) of the line, so the wall's own edge
    // there faces west or north: the lit side.
    const lit = q === HALF_EDGE_QUADRANTS[side][1];
    fill(rect, lit ? CAP_LIT : CAP_DARK, halfEdgeStrip(px, py, size, side, q, 1));
  }

  const shape = shapeOf(cell.wallMask);
  if (shape.kind === 'convex' && !(faces & BIT[shape.q])) {
    const c = outsideColour(cell, DIAGONAL[shape.q]);
    for (const r of cornerCut(cell, shape.q, 1, size)) fill(rect, c, r);
  }
}
