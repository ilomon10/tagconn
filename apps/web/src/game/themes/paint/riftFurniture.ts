import type * as Phaser from 'phaser';
import type { FurnitureKind, PlacedFurniture } from '../../procgen/types';
import { lighten, rectFn, type RectFn } from './util';

type Painter = (g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn) => void;

const CRYSTAL = 0x2a3a6a;
const CRYSTAL_EDGE = 0x6ff5ff;
const VOID_DARK = 0x0e0b14;
// 2-3 seeded accent hues for the decor props (cyan / violet / magenta rift palette).
const RIFT_ACCENTS = [0x6ff5ff, 0x9a6bff, 0xd94ff0];

/** Deterministic per-item variety without a shared RNG stream (furniture has no `rand` argument),
 *  mirroring `furniture.ts`'s `pick` helper. */
function pick<T>(arr: readonly T[], seed: number): T {
  return arr[((seed % arr.length) + arr.length) % arr.length]!;
}

/** A small void-socketed prop with a glowing crystal core, seeded by `f.variant` — used for the
 *  decor kinds (lamp/crate/wall-art/bin/cabinet/chair/banner) so they read as distinct crystalline
 *  variants instead of one repeated block. */
function paintCrystalProp(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn): void {
  const x = f.x * T;
  const y = f.y * T;
  const accent = pick(RIFT_ACCENTS, f.variant);
  rect(0x000000, x + 4, y + 14, 8, 2, 0.2);
  rect(VOID_DARK, x + 4, y + 4, 8, 10);
  rect(accent, x + 5, y + 5, 6, 3, 0.7);
  rect(lighten(accent, 0.3), x + 5, y + 5, 6, 1, 0.5);
}

/** A plain crystal block: rift furniture is never actually rendered in practice (every realm room
 *  is always covered by its project's own region theme — see `renderTheme.ts`'s `themeAt`), but
 *  every `FurnitureKind` gets a real painter so `rift` implements the theme contract exhaustively,
 *  matching guild/modern (docs/design/living-office.md section 6.2). */
function paintCrystalBlock(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn): void {
  const x = f.x * T;
  const y = f.y * T;
  const w = f.w * T;
  const h = f.h * T;
  rect(0x000000, x + 1, y + h - 2, w - 2, 3, 0.2);
  rect(CRYSTAL, x, y, w, h);
  rect(lighten(CRYSTAL, 0.2), x, y, w, 1, 0.6);
  rect(CRYSTAL_EDGE, x, y, 1, h, 0.35);
  rect(CRYSTAL_EDGE, x + w - 1, y, 1, h, 0.35);
}

/** M8 8p (back wall + appliances, docs/design/back-wall.md): a simple crystal/void variant for the
 *  standing appliances, anchored to the footprint bottom with a modest overdraw so the shape still
 *  reads as "standing" — `RIFT` must implement every `FurnitureKind` exhaustively even though rift
 *  furniture is never actually rendered in practice (see the comment above `paintCrystalBlock`). */
function paintCrystalAppliance(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn): void {
  const x = f.x * T;
  const y = f.y * T;
  const w = f.w * T;
  const overdraw = f.w >= 2 ? 10 : 7;
  const top = y - overdraw;
  const h = y + 15 - top;
  const accent = pick(RIFT_ACCENTS, f.variant);
  rect(0x000000, x + 1, y + 14, w - 2, 2, 0.2);
  rect(VOID_DARK, x, top, w, h);
  rect(accent, x + 1, top + 1, w - 2, 3, 0.7);
  rect(lighten(accent, 0.3), x + 1, top + 1, w - 2, 1, 0.5);
  rect(CRYSTAL_EDGE, x, top, 1, h, 0.3);
  rect(CRYSTAL_EDGE, x + w - 1, top, 1, h, 0.3);
}

/** M12 G3 trigger furniture: a wall-standing crystal slab with a glowing glyph. `kind` picks the glyph
 *  (notice-board: stacked bounty shards; roster-board: a small constellation). Tall only when `againstNorthWall`. */
function paintCrystalGlyph(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn): void {
  const x = f.x * T;
  const y = f.y * T;
  const w = f.w * T;
  const top = f.againstNorthWall ? y - 8 : y + 1;
  const bottom = y + 13;
  const accent = pick(RIFT_ACCENTS, f.variant);
  const mx = x + w / 2;
  rect(0x000000, x + 1, y + 14, w - 2, 2, 0.2);
  rect(VOID_DARK, x + 1, bottom, w - 2, 2);
  rect(CRYSTAL, x + 1, top, w - 2, bottom - top);
  rect(lighten(CRYSTAL, 0.2), x + 1, top, w - 2, 1, 0.6);
  rect(CRYSTAL_EDGE, x + 1, top, 1, bottom - top, 0.4);
  rect(CRYSTAL_EDGE, x + w - 2, top, 1, bottom - top, 0.4);
  const midY = Math.floor((top + bottom) / 2);
  if (f.kind === 'roster-board') {
    // constellation: four stars joined by faint lines
    const pts: [number, number][] = [[mx - 4, midY - 3], [mx, midY + 1], [mx + 4, midY - 2], [mx + 1, midY - 5]];
    rect(accent, mx - 3, midY - 2, 3, 1, 0.35);
    rect(accent, mx + 1, midY - 1, 3, 1, 0.35);
    for (const [px, py] of pts) {
      rect(lighten(accent, 0.4), px, py, 1, 1);
      rect(accent, px - 1, py, 3, 1, 0.45);
    }
  } else {
    // bounty shards: three diamonds of different heights
    for (let i = 0; i < 3; i++) {
      const sx = mx - 4 + i * 4;
      const sy = midY - 3 + (i % 2) * 2;
      rect(accent, sx, sy, 2, 4, 0.85);
      rect(lighten(accent, 0.4), sx, sy, 1, 2, 0.8);
      rect(accent, sx - 1, sy + 1, 4, 1, 0.4);
    }
  }
}

/** Office life (M13): holo-arcade pillar. A 1x1 void pillar with a glowing holo screen and a button row. */
function paintHoloArcade(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn): void {
  const x = f.x * T;
  const y = f.y * T;
  const accent = pick(RIFT_ACCENTS, f.variant);
  rect(0x000000, x + 2, y + 14, 12, 2, 0.25);
  rect(VOID_DARK, x + 3, y + 1, 10, 14);
  rect(CRYSTAL, x + 2, y + 12, 12, 3);
  rect(CRYSTAL_EDGE, x + 3, y + 1, 1, 11, 0.4);
  rect(CRYSTAL_EDGE, x + 12, y + 1, 1, 11, 0.4);
  // holo screen: a bright core with a faint glow halo and scanlines
  rect(accent, x + 4, y + 2, 8, 6, 0.3);
  rect(accent, x + 5, y + 3, 6, 4, 0.75);
  rect(lighten(accent, 0.5), x + 6, y + 4, 2, 2, 0.9);
  rect(0x000000, x + 5, y + 5, 6, 1, 0.25);
  // control deck: a stick and two button gems
  rect(CRYSTAL, x + 3, y + 9, 10, 2);
  rect(lighten(accent, 0.3), x + 5, y + 9, 1, 1);
  rect(0xd94ff0, x + 9, y + 9, 1, 1);
  rect(0x6ff5ff, x + 11, y + 9, 1, 1);
}

/** Office life (M13): zero-g paddle field. A 2x1 hovering energy plane with a net beam, floating paddles and a ball. */
function paintPaddleField(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn): void {
  const x = f.x * T;
  const y = f.y * T;
  const w = f.w * T;
  const mx = x + w / 2;
  const accent = pick(RIFT_ACCENTS, f.variant);
  rect(0x000000, x + 3, y + 14, w - 6, 2, 0.2); // shadow under the hover
  rect(VOID_DARK, x + 1, y + 11, w - 2, 2); // emitter slab
  rect(CRYSTAL_EDGE, x + 1, y + 11, w - 2, 1, 0.5);
  rect(accent, x + 2, y + 4, w - 4, 7, 0.25); // field
  rect(CRYSTAL_EDGE, x + 2, y + 4, w - 4, 1, 0.5);
  rect(CRYSTAL_EDGE, x + 2, y + 10, w - 4, 1, 0.3);
  // net: a vertical beam
  rect(lighten(accent, 0.5), mx - 1, y + 2, 1, 9, 0.8);
  rect(accent, mx - 2, y + 2, 3, 1, 0.5);
  // paddles hover at each end
  rect(0x6ff5ff, x + 4, y + 5, 1, 4, 0.9);
  rect(0xd94ff0, x + w - 5, y + 6, 1, 4, 0.9);
  // ball with a faint trail
  rect(0xffffff, mx + 4, y + 7, 2, 2, 0.95);
  rect(accent, mx + 6, y + 7, 3, 1, 0.4);
}

/** Office life (M13): hover-puck table. A 2x1 void table with a glowing puck over a lit rink and goal gems. */
function paintHoverPuckTable(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn): void {
  const x = f.x * T;
  const y = f.y * T;
  const w = f.w * T;
  const mx = x + w / 2;
  const accent = pick(RIFT_ACCENTS, f.variant);
  rect(0x000000, x + 1, y + 14, w - 2, 2, 0.2);
  rect(VOID_DARK, x + 1, y + 3, w - 2, 11); // body
  rect(CRYSTAL, x + 1, y + 12, w - 2, 2); // base
  rect(CRYSTAL_EDGE, x + 1, y + 3, w - 2, 1, 0.5);
  rect(accent, x + 3, y + 5, w - 6, 6, 0.3); // rink
  rect(CRYSTAL_EDGE, mx, y + 5, 1, 6, 0.45); // centre line
  // goals
  rect(0xd94ff0, x + 2, y + 6, 1, 4, 0.85);
  rect(0x6ff5ff, x + w - 3, y + 6, 1, 4, 0.85);
  // levitating puck: glow above its shadow
  rect(0x000000, mx - 3, y + 9, 3, 1, 0.3);
  rect(lighten(accent, 0.5), mx - 3, y + 6, 3, 2);
  rect(0xffffff, mx - 2, y + 6, 1, 1, 0.9);
  // side rails
  rect(CRYSTAL_EDGE, x + 1, y + 3, 1, 9, 0.3);
  rect(CRYSTAL_EDGE, x + w - 2, y + 3, 1, 9, 0.3);
}

/** Office life (M13): holo-chess table. A 2x1 void table with a lit checker board and two floating holo pieces. */
function paintHoloChess(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn): void {
  const x = f.x * T;
  const y = f.y * T;
  const w = f.w * T;
  const accent = pick(RIFT_ACCENTS, f.variant);
  rect(0x000000, x + 1, y + 14, w - 2, 2, 0.2);
  rect(VOID_DARK, x + 1, y + 5, w - 2, 9);
  rect(CRYSTAL, x + 1, y + 12, w - 2, 2);
  rect(CRYSTAL_EDGE, x + 1, y + 5, w - 2, 1, 0.5);
  // checker board: 8x2 cells of 3x3 px, alternating lit and dark
  const cols = Math.floor((w - 4) / 3);
  const bx = x + 2 + Math.floor((w - 4 - cols * 3) / 2);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < 2; r++) {
      if ((c + r) % 2 === 0) rect(accent, bx + c * 3, y + 6 + r * 3, 3, 3, 0.55);
      else rect(CRYSTAL, bx + c * 3, y + 6 + r * 3, 3, 3);
    }
  }
  // floating holo pieces: a tall king (cyan) and a pawn (magenta) with glow
  const kx = bx + 3;
  rect(0x6ff5ff, kx, y + 1, 2, 5, 0.85);
  rect(lighten(0x6ff5ff, 0.5), kx - 1, y + 2, 4, 1, 0.9);
  const px = bx + cols * 3 - 6;
  rect(0xd94ff0, px, y + 3, 2, 3, 0.85);
  rect(lighten(0xd94ff0, 0.4), px, y + 2, 2, 1, 0.9);
}

function paintRiftStairs(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn, up: boolean): void {
  const x = f.x * T;
  const y = f.y * T;
  for (let i = 0; i < 3; i++) rect(lighten(0x1c1a2e, i * 0.1), x, y + i * 3, T, 3);
  const ring = up ? 0x4ff0d0 : 0xd94ff0; // cyan up, magenta down (the "Rift Stairs" portal art)
  g.lineStyle(1, ring, 0.75);
  g.strokeEllipse(x + T / 2, y + 9, T - 2, 10);
  g.lineStyle(1, lighten(ring, 0.3), 0.4);
  g.strokeEllipse(x + T / 2, y + 9, T - 6, 6);
}

const RIFT: Record<FurnitureKind, Painter> = {
  // Office life (M13): holo-arcade pillar, zero-g paddle field, hover-puck table, holo-chess table.
  arcade: paintHoloArcade,
  'ping-pong': paintPaddleField,
  foosball: paintHoverPuckTable,
  'board-game-table': paintHoloChess,
  // M12 G3 trigger furniture (see `paintCrystalGlyph`).
  'notice-board': paintCrystalGlyph,
  'roster-board': paintCrystalGlyph,
  'work-desk': paintCrystalBlock,
  'lead-desk': paintCrystalBlock,
  table: paintCrystalBlock,
  board: paintCrystalBlock,
  workbench: paintCrystalBlock,
  booth: paintCrystalBlock,
  rack: paintCrystalBlock,
  shelf: paintCrystalBlock,
  sofa: paintCrystalBlock,
  armchair: paintCrystalBlock,
  rug: paintCrystalBlock,
  mat: paintCrystalBlock,
  counter: paintCrystalBlock,
  plant: paintCrystalBlock,
  centerpiece: paintCrystalBlock,
  pedestal: paintCrystalBlock,
  sigil: (g, f, T, rect) => {
    const x = f.x * T + (f.w * T) / 2;
    const y = f.y * T + (f.h * T) / 2;
    const r = Math.min(f.w, f.h) * T * 0.42;
    g.lineStyle(1, CRYSTAL_EDGE, 0.5);
    g.strokeCircle(x, y, r);
    void rect;
  },
  'stairs-up': (g, f, T, rect) => paintRiftStairs(g, f, T, rect, true),
  'stairs-down': (g, f, T, rect) => paintRiftStairs(g, f, T, rect, false),
  // M8 8n (furnishing engine): the multi-tile/blocking kinds stay plain crystal blocks (they
  // already tile cleanly across whatever `f.w`/`f.h` they get, matching every other rift item —
  // this theme is never actually rendered in practice, see the comment above). The small decor
  // kinds get a seeded crystalline prop instead, for variety in the (unused) exhaustive contract.
  'rack-row': paintCrystalBlock,
  console: paintCrystalBlock,
  'lab-bench': paintCrystalBlock,
  equipment: paintCrystalBlock,
  'shelf-stack': paintCrystalBlock,
  'reading-table': paintCrystalBlock,
  'standing-table': paintCrystalBlock,
  'reception-desk': paintCrystalBlock,
  bench: paintCrystalBlock,
  lamp: paintCrystalProp,
  crate: paintCrystalProp,
  'wall-art': paintCrystalProp,
  bin: paintCrystalProp,
  cabinet: paintCrystalProp,
  chair: paintCrystalProp,
  banner: paintCrystalProp,
  // M8 8p: standing appliances (see `paintCrystalAppliance` above).
  printer: paintCrystalAppliance,
  fridge: paintCrystalAppliance,
  'water-cooler': paintCrystalAppliance,
  'filing-cabinet': paintCrystalAppliance,
  'coffee-machine': paintCrystalAppliance,
  bookcase: paintCrystalAppliance,
  fireplace: paintCrystalAppliance,
  'coat-rack': paintCrystalAppliance,
  'supply-stack': paintCrystalAppliance,
  cage: paintCrystalAppliance,
};

export function paintRiftFurniture(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number): void {
  RIFT[f.kind](g, f, T, rectFn(g));
}
