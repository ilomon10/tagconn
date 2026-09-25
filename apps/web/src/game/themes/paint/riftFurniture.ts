import type * as Phaser from 'phaser';
import type { FurnitureKind, PlacedFurniture } from '../../procgen/types';
import { lighten, rectFn, type RectFn } from './util';

type Painter = (g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn) => void;

const CRYSTAL = 0x2a3a6a;
const CRYSTAL_EDGE = 0x6ff5ff;

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
};

export function paintRiftFurniture(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number): void {
  RIFT[f.kind](g, f, T, rectFn(g));
}
