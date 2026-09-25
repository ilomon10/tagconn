import type * as Phaser from 'phaser';
import type { RoomType } from '@tagconn/shared';
import { lighten, rectFn, T, tileOf } from './util';

type FloorKind = RoomType | 'corridor';
type Painter = (g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number) => void;

// ------------------------------------------------------------------ modern (port of renderMap.ts)

const MODERN_FLOORS: Record<FloorKind, readonly [base: number, accent: number]> = {
  hall: [0x6b4f3a, 0x5d4432],
  corridor: [0x6b4f3a, 0x5d4432],
  'pm-office': [0x7a4a3e, 0x6c4036],
  desks: [0x4a5870, 0x435066],
  'meeting-room': [0x56664a, 0x4d5c42],
  whiteboard: [0x5a5472, 0x514b68],
  library: [0x5e4533, 0x533c2c],
  'qa-lab': [0x8fa3aa, 0x82979e],
  'review-booth': [0x645682, 0x5a4d76],
  'server-room': [0x3a4252, 0x333a48],
  lounge: [0x7d6848, 0x735f40],
  entrance: [0x7a766d, 0x6d6960],
  stairs: [0x5d5872, 0x514c66],
};

export function paintModernFloor(g: Phaser.GameObjects.Graphics, kind: FloorKind, px: number, py: number, rand: () => number): void {
  const rect = rectFn(g);
  const [base, accent] = MODERN_FLOORS[kind];
  const { x: tx, y: ty } = tileOf(px, py);
  rect(base, px, py, T, T);
  switch (kind) {
    case 'hall':
    case 'corridor':
    case 'library':
    case 'lounge':
      rect(accent, px, py + 7, T, 1);
      rect(accent, px, py + 15, T, 1);
      rect(accent, px + ((tx * 7 + ty * 3) % 12) + 2, py, 1, 7);
      break;
    case 'qa-lab':
    case 'entrance':
      rect(accent, px, py, T, 1);
      rect(accent, px, py, 1, T);
      break;
    case 'server-room':
      rect(accent, px + 3, py + 3, 1, 1);
      rect(accent, px + 11, py + 11, 1, 1);
      rect(accent, px, py, T, 1);
      break;
    case 'pm-office':
    case 'desks':
    case 'meeting-room':
    case 'whiteboard':
    case 'review-booth':
    case 'stairs':
      if ((tx + ty) % 2 === 0) rect(accent, px, py, T, T);
      break;
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
    }
  }
}

// ------------------------------------------------------------------ guild

const STONE_BASE = 0x4a4458;
const STONE_MORTAR = 0x3a3446;
// A slightly darker stone base for carved void corridors, so they read as a distinct passage.
const CORRIDOR_BASE = 0x3e394c;

/** Flagstones split by 1-2 mortar lines, a speckle or two, and a lit top-left edge. */
function paintFlagstones(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number, base: number, mortar: number): void {
  const rect = rectFn(g);
  rect(base, px, py, T, T);
  const splitAt = () => 1 + Math.floor(rand() * (T - 2));
  if (rand() < 0.6) rect(mortar, px + splitAt(), py, 1, T);
  else rect(mortar, px, py + splitAt(), T, 1);
  if (rand() < 0.5) rect(mortar, px, py + splitAt(), T, 1);
  const speck = lighten(base, 0.08);
  const speckles = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < speckles; i++) rect(speck, px + Math.floor(rand() * T), py + Math.floor(rand() * T), 1, 1);
  rect(lighten(base, 0.12), px, py, T - 1, 1, 0.5);
  rect(lighten(base, 0.12), px, py, 1, T - 1, 0.5);
}

function paintPlanks(g: Phaser.GameObjects.Graphics, px: number, py: number, base: number, line: number): void {
  const rect = rectFn(g);
  const { x: tx, y: ty } = tileOf(px, py);
  rect(base, px, py, T, T);
  for (let y = 0; y < T; y += 4) rect(line, px, py + y, T, 1);
  rect(line, px + ((tx + ty) % 2 === 0 ? 4 : 10), py, 1, T);
}

function paintVault(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void {
  const rect = rectFn(g);
  rect(0x1c2230, px, py, T, T);
  rect(0x161b26, px, py + 7, T, 1);
  if (rand() < 0.4) rect(0x2c7a7a, px + Math.floor(rand() * (T - 2)), py + Math.floor(rand() * (T - 2)), 2, 1, 0.55);
}

function paintAlchemyTile(g: Phaser.GameObjects.Graphics, px: number, py: number): void {
  const rect = rectFn(g);
  rect(0x4a5a4a, px, py, T, T);
  rect(0x3d4b3d, px, py, T, 1);
  rect(0x3d4b3d, px, py, 1, T);
}

function paintMarble(g: Phaser.GameObjects.Graphics, px: number, py: number): void {
  const rect = rectFn(g);
  const { x: tx, y: ty } = tileOf(px, py);
  rect(0x6d6478, px, py, T, T);
  if ((tx + ty) % 2 === 0) rect(0x5a5268, px, py, T, T, 0.55);
}

const GUILD_FLOORS: Record<FloorKind, Painter> = {
  hall: (g, px, py, rand) => paintFlagstones(g, px, py, rand, STONE_BASE, STONE_MORTAR),
  corridor: (g, px, py, rand) => paintFlagstones(g, px, py, rand, CORRIDOR_BASE, STONE_MORTAR),
  entrance: (g, px, py, rand) => paintFlagstones(g, px, py, rand, STONE_BASE, STONE_MORTAR),
  'pm-office': (g, px, py, rand) => paintFlagstones(g, px, py, rand, STONE_BASE, STONE_MORTAR),
  whiteboard: (g, px, py, rand) => paintFlagstones(g, px, py, rand, STONE_BASE, STONE_MORTAR),
  'review-booth': (g, px, py, rand) => paintFlagstones(g, px, py, rand, STONE_BASE, STONE_MORTAR),
  stairs: (g, px, py, rand) => paintFlagstones(g, px, py, rand, STONE_BASE, STONE_MORTAR),
  desks: (g, px, py) => paintPlanks(g, px, py, 0x6b4f3a, 0x5d4432),
  library: (g, px, py) => paintPlanks(g, px, py, 0x4a3324, 0x3a2818),
  lounge: (g, px, py) => paintPlanks(g, px, py, 0x4a3324, 0x3a2818),
  'server-room': (g, px, py, rand) => paintVault(g, px, py, rand),
  'qa-lab': (g, px, py) => paintAlchemyTile(g, px, py),
  'meeting-room': (g, px, py) => paintMarble(g, px, py),
};

export function paintGuildFloor(g: Phaser.GameObjects.Graphics, kind: FloorKind, px: number, py: number, rand: () => number): void {
  GUILD_FLOORS[kind](g, px, py, rand);
}
