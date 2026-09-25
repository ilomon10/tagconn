import type * as Phaser from 'phaser';
import type { RoomType } from '@tagconn/shared';
import { lighten, rectFn, T, tileOf } from './util';

type FloorKind = RoomType | 'corridor';
type Painter = (g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number) => void;

/** docs/design/living-office.md section 6.2: hexagonal crystal tiles for the Nexus, obsidian and
 *  teal for the realm rooms that (in practice) are always covered by a realm's own region theme —
 *  they're painted here too so `rift` implements every `RoomType` exhaustively, per the design's
 *  "rift theme implements every FurnitureKind/RoomType exhaustively like the others". */
const CRYSTAL_BASE = 0x2a2350;
const CRYSTAL_EDGE = 0x6ff5ff;
const BRIDGE_PLANK = 0x1c1a2e;
const BRIDGE_RAIL = 0x9a6bff;

/** The Nexus floor: hexagonal crystal tiles, a darker base with a cyan hex edge at 30% alpha. */
function paintCrystalTile(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void {
  const rect = rectFn(g);
  const { x: tx, y: ty } = tileOf(px, py);
  rect(CRYSTAL_BASE, px, py, T, T);
  // A staggered hex look: alternate rows offset the vertical edge, giving a honeycomb read at 16px.
  const offset = ty % 2 === 0 ? 0 : T / 2;
  rect(CRYSTAL_EDGE, px, py, T, 1, 0.3);
  rect(CRYSTAL_EDGE, px + ((tx * 5 + offset) % (T - 1)), py, 1, T, 0.3);
  if (rand() < 0.35) rect(lighten(CRYSTAL_BASE, 0.1), px + Math.floor(rand() * T), py + Math.floor(rand() * T), 1, 1, 0.6);
}

/** Rift bridges: dark planks with a 1px glowing violet rail on both edges. */
function paintBridge(g: Phaser.GameObjects.Graphics, px: number, py: number): void {
  const rect = rectFn(g);
  rect(BRIDGE_PLANK, px, py, T, T);
  for (let y = 0; y < T; y += 4) rect(lighten(BRIDGE_PLANK, 0.08), px, py + y, T, 1);
  rect(BRIDGE_RAIL, px, py, T, 1, 0.7);
  rect(BRIDGE_RAIL, px, py + T - 1, T, 1, 0.7);
}

const RIFT_FLOORS: Record<FloorKind, Painter> = {
  entrance: paintCrystalTile,
  stairs: paintCrystalTile,
  corridor: (g, px, py) => paintBridge(g, px, py),
  hall: (g, px, py) => paintBridge(g, px, py),
  // Never actually rendered (realm rooms are always covered by their project's own region theme —
  // see `renderTheme.ts`'s `themeAt`), but implemented for exhaustiveness.
  'pm-office': paintCrystalTile,
  desks: paintCrystalTile,
  'meeting-room': paintCrystalTile,
  whiteboard: paintCrystalTile,
  'qa-lab': paintCrystalTile,
  'review-booth': paintCrystalTile,
  'server-room': paintCrystalTile,
  library: paintCrystalTile,
  lounge: paintCrystalTile,
};

export function paintRiftFloor(g: Phaser.GameObjects.Graphics, kind: FloorKind, px: number, py: number, rand: () => number): void {
  RIFT_FLOORS[kind](g, px, py, rand);
}
