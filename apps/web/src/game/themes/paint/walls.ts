import type * as Phaser from 'phaser';
import type { RoomType } from '@tagconn/shared';
import { paintGuildFloor, paintModernFloor } from './floors';
import { darken, lighten, rectFn, T } from './util';

type FloorKind = RoomType | 'corridor';

// ------------------------------------------------------------------ modern (port of renderMap.ts)

const WALL_TOP = 0x4c4468;
const WALL_FACE = 0x2d2742;
const WALL_EDGE = 0x625a85;

export function paintModernWall(g: Phaser.GameObjects.Graphics, px: number, py: number, faceVisible: boolean, _rand?: () => number): void {
  const rect = rectFn(g);
  rect(WALL_TOP, px, py, T, T);
  rect(WALL_EDGE, px, py, T, 1);
  if (faceVisible) {
    rect(WALL_FACE, px, py + 8, T, 8);
    rect(0x3a3354, px, py + 8, T, 1);
    rect(0x000000, px, py + 15, T, 1, 0.25);
  }
}

export function paintModernVoid(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void {
  const rect = rectFn(g);
  rect(0x0d0d12, px, py, T, T);
  if (rand() < 0.15) rect(0x16161e, px + Math.floor(rand() * T), py + Math.floor(rand() * T), 1, 1, 0.6);
}

export function paintModernDoor(g: Phaser.GameObjects.Graphics, kind: FloorKind, px: number, py: number, wide: boolean, rand: () => number): void {
  paintModernFloor(g, kind, px, py, rand);
  const rect = rectFn(g);
  rect(0x8a6a4a, px, py, wide ? T * 2 : T, T, 0.9);
}

// ------------------------------------------------------------------ guild

const GUILD_WALL_TOP = 0x5a5068;
const GUILD_WALL_FACE = 0x2e283c;
const MOSS = 0x4d6b3a;

/** Ashlar block courses: a 4px coursing row with an alternating 8px/6px staggered joint. */
export function paintGuildWall(g: Phaser.GameObjects.Graphics, px: number, py: number, faceVisible: boolean, rand: () => number): void {
  const rect = rectFn(g);
  rect(GUILD_WALL_TOP, px, py, T, T);
  for (let y = 0, row = 0; y < T; y += 4, row++) {
    rect(darken(GUILD_WALL_TOP, 0.18), px, py + y, T, 1);
    rect(darken(GUILD_WALL_TOP, 0.12), px + (row % 2 === 0 ? 8 : 6), py + y + 1, 1, 3);
  }
  rect(lighten(GUILD_WALL_TOP, 0.18), px, py, T, 1);
  if (rand() < 0.2) rect(MOSS, px + Math.floor(rand() * T), py + Math.floor(rand() * T), 1, 1, 0.65);
  if (faceVisible) {
    rect(GUILD_WALL_FACE, px, py + 10, T, 6);
    rect(lighten(GUILD_WALL_FACE, 0.25), px, py + 10, T, 1);
    if (rand() < 0.15) rect(MOSS, px + Math.floor(rand() * T), py + 11 + Math.floor(rand() * 4), 1, 1, 0.5);
  }
}

export function paintGuildVoid(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void {
  const rect = rectFn(g);
  rect(0x0e0b14, px, py, T, T);
  if (rand() < 0.25) rect(lighten(0x0e0b14, 0.08), px + Math.floor(rand() * T), py + Math.floor(rand() * T), 1, 1, 0.5);
}

/** An arched wooden door frame, drawn open (floor visible). The front gate is a 2-tile portcullis arch. */
export function paintGuildDoor(g: Phaser.GameObjects.Graphics, kind: FloorKind, px: number, py: number, wide: boolean, rand: () => number): void {
  paintGuildFloor(g, kind, px, py, rand);
  const rect = rectFn(g);
  const w = wide ? T * 2 : T;
  rect(0x5a3a1e, px, py, 2, T);
  rect(0x5a3a1e, px + w - 2, py, 2, T);
  rect(0x7a5230, px, py, w, 3);
  rect(lighten(0x7a5230, 0.2), px, py, w, 1);
  if (wide) for (let x = 4; x < w - 4; x += 4) rect(0x2a2a33, px + x, py + 3, 1, T - 3, 0.55);
}
