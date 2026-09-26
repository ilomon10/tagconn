import type * as Phaser from 'phaser';
import type { RoomType } from '@tagconn/shared';
import type { WallDecorSlot } from '../../procgen/types';
import type { BackWallCtx } from './walls';
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

/**
 * The tall 3/4 back-wall face for the rift (M8 8p): obsidian courses under a teal mortar line,
 * echoing `paintRiftWall`'s own face branch but stretched across `capPx..T` plus (when `ctx.band`)
 * an overdraw band into the floor tile below, ending in a dark plinth. No band under a door tile.
 * `openLeft`/`openRight` add a teal-lit jamb edge.
 */
export function paintRiftBackWall(g: Phaser.GameObjects.Graphics, px: number, py: number, ctx: BackWallCtx, rand: () => number): void {
  const rect = rectFn(g);
  const faceTop = py + ctx.capPx;
  const faceH = T - ctx.capPx;
  rect(darken(OBSIDIAN, 0.3), px, faceTop, T, faceH);
  rect(TEAL_MORTAR, px, faceTop, T, 1, 0.6);
  if (rand() < 0.2) rect(TEAL_MORTAR, px + Math.floor(rand() * T), faceTop + Math.floor(rand() * faceH), 1, 1, 0.6);
  let totalH = faceH;
  if (ctx.band) {
    const bandTop = py + T;
    rect(darken(OBSIDIAN, 0.3), px, bandTop, T, ctx.bandPx);
    rect(darken(OBSIDIAN, 0.5), px, bandTop + ctx.bandPx - 2, T, 2);
    totalH += ctx.bandPx;
  }
  if (ctx.openLeft) rect(TEAL_MORTAR, px, faceTop, 1, totalH, 0.4);
  if (ctx.openRight) rect(TEAL_MORTAR, px + T - 1, faceTop, 1, totalH, 0.4);
}

const RIFT_DECOR_ACCENTS = [0x6ff5ff, 0x9a6bff, 0xd94ff0] as const;

/**
 * A simple crystal/void variant for every `WallDecorKind` (M8 8p): a realm rendered without its own
 * project theme (or the Nexus itself) still shows *something* on a north-wall run — a small void
 * panel with a seeded accent glow, well inside `face`. Every realm room is normally covered by its
 * own project theme (`renderTheme.ts`'s `themeAt`), so in practice this is the Nexus's fallback.
 */
export function paintRiftWallDecor(g: Phaser.GameObjects.Graphics, slot: WallDecorSlot, T: number, face: { top: number; bottom: number }): void {
  const rect = rectFn(g);
  const x = slot.x * T;
  const w = slot.span * T;
  const top = Math.round(face.top + 2);
  const h = Math.max(5, Math.min(Math.round(face.bottom - top - 3), 11));
  const accent = RIFT_DECOR_ACCENTS[((slot.variant % RIFT_DECOR_ACCENTS.length) + RIFT_DECOR_ACCENTS.length) % RIFT_DECOR_ACCENTS.length]!;
  rect(OBSIDIAN, x + 1, top, Math.max(1, w - 2), h);
  rect(accent, x + 2, top + 1, Math.max(1, w - 4), Math.max(1, h - 2), 0.6);
  rect(lighten(accent, 0.3), x + 2, top + 1, Math.max(1, w - 4), 1, 0.5);
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
