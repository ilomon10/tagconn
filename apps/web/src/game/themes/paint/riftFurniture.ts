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
  // Office life (W0c) placeholders: replaced by real art in W1-9.
  arcade: paintCrystalAppliance,
  'ping-pong': paintCrystalAppliance,
  foosball: paintCrystalAppliance,
  'board-game-table': paintCrystalAppliance,
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
