import type * as Phaser from 'phaser';
import type { RoomType } from '@tagconn/shared';
import { paintRiftFloor } from './riftFloors';
import { darken, lighten, rectFn, T } from './util';

type FloorKind = RoomType | 'corridor';

// ------------------------------------------------------------------ void: deep-indigo starfield

const VOID_BASE = 0x0b0820;
const STAR_DIM = 0x6a5fa0;
const STAR_MID = 0xa89bdc;
const STAR_BRIGHT = 0xf0ecff;

/** Deep indigo with seeded 1px stars (~1 per 6 tiles, 3 brightness levels) and an occasional 2x2
 *  cross star. See docs/design/living-office.md section 6.2. */
export function paintRiftVoid(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void {
  const rect = rectFn(g);
  rect(VOID_BASE, px, py, T, T);
  if (rand() >= 1 / 6) return;
  const roll = rand();
  const sx = px + Math.floor(rand() * T);
  const sy = py + Math.floor(rand() * T);
  if (roll < 0.08) {
    // A rarer 2x2 cross star: a bright centre plus two 1px arms.
    rect(STAR_BRIGHT, sx, sy, 1, 1, 0.9);
    rect(STAR_MID, sx - 1, sy, 3, 1, 0.5);
    rect(STAR_MID, sx, sy - 1, 1, 3, 0.5);
  } else {
    const color = roll < 0.4 ? STAR_BRIGHT : roll < 0.7 ? STAR_MID : STAR_DIM;
    rect(color, sx, sy, 1, 1, roll < 0.4 ? 0.9 : roll < 0.7 ? 0.6 : 0.4);
  }
}

/** Floating islands (section 6.2): a jagged rock underside on the void just below a realm's block,
 *  fading from `0x3a2f4f` (depth 1, right under the floor) to `0x1c1630` (depth 2). */
export function paintRiftIslandEdge(g: Phaser.GameObjects.Graphics, px: number, py: number, depth: 1 | 2, rand: () => number): void {
  paintRiftVoid(g, px, py, rand);
  const rect = rectFn(g);
  const color = depth === 1 ? 0x3a2f4f : 0x1c1630;
  const jagW = 6 + Math.floor(rand() * (T - 6));
  const jagX = px + Math.floor(rand() * (T - jagW));
  rect(color, jagX, py, jagW, depth === 1 ? 6 : 3, 0.85);
  if (depth === 1) rect(lighten(color, 0.15), jagX, py, jagW, 1, 0.6);
}

// ------------------------------------------------------------------ walls: obsidian, teal mortar

const OBSIDIAN = 0x161022;
const TEAL_MORTAR = 0x1f5a5a;

/** Obsidian block courses with a teal mortar line, echoing the guild's ashlar coursing but in the
 *  rift's cold palette. */
export function paintRiftWall(g: Phaser.GameObjects.Graphics, px: number, py: number, faceVisible: boolean, rand: () => number): void {
  const rect = rectFn(g);
  rect(OBSIDIAN, px, py, T, T);
  for (let y = 4, row = 0; y < T; y += 4, row++) rect(TEAL_MORTAR, px, py + y, T, 1, 0.5);
  rect(lighten(OBSIDIAN, 0.2), px, py, T, 1);
  if (rand() < 0.2) rect(TEAL_MORTAR, px + Math.floor(rand() * T), py + Math.floor(rand() * T), 1, 1, 0.7);
  if (faceVisible) {
    rect(darken(OBSIDIAN, 0.3), px, py + 10, T, 6);
    rect(TEAL_MORTAR, px, py + 10, T, 1, 0.6);
  }
}

/** The Nexus Gate (entrance) is a glowing rune ring on the threshold; every other door is a plain
 *  violet-lined threshold matching the rift bridges. `wide` doubles the tile width for the front gate. */
export function paintRiftDoor(g: Phaser.GameObjects.Graphics, kind: FloorKind, px: number, py: number, wide: boolean, rand: () => number): void {
  paintRiftFloor(g, kind, px, py, rand);
  const rect = rectFn(g);
  const w = wide ? T * 2 : T;
  if (kind === 'entrance') {
    g.lineStyle(1, 0x6ff5ff, 0.7);
    g.strokeEllipse(px + w / 2, py + T / 2, w - 3, T - 2);
    g.lineStyle(1, 0x9a6bff, 0.5);
    g.strokeEllipse(px + w / 2, py + T / 2, w - 7, T - 6);
    return;
  }
  rect(0x9a6bff, px, py, w, 1, 0.6);
  rect(0x9a6bff, px, py + T - 1, w, 1, 0.6);
}
