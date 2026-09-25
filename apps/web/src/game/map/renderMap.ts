import type * as Phaser from 'phaser';
import type { Zone } from '@tagconn/shared';
import type { Furniture, OfficeMap } from './officeMap';

/** Paints the static office (floors, walls, furniture) into one generated texture. */

const FLOORS: Record<Zone | 'hall', [base: number, accent: number]> = {
  hall: [0x6b4f3a, 0x5d4432],
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
};

const WALL_TOP = 0x4c4468;
const WALL_FACE = 0x2d2742;
const WALL_EDGE = 0x625a85;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BASE_TEXTURE = 'office-base';

export function renderMap(scene: Phaser.Scene, map: OfficeMap): string {
  const T = map.tileSize;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  const rand = rng(1337);
  const rect = (c: number, x: number, y: number, w: number, h: number, a = 1) => {
    g.fillStyle(c, a);
    g.fillRect(x, y, w, h);
  };

  // Floors.
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      const zone = map.zoneAt[y]![x] ?? 'hall';
      const [base, accent] = FLOORS[zone];
      const px = x * T;
      const py = y * T;
      rect(base, px, py, T, T);
      switch (zone) {
        case 'hall':
        case 'library':
        case 'lounge':
          // Wood planks.
          rect(accent, px, py + 7, T, 1);
          rect(accent, px, py + 15, T, 1);
          rect(accent, px + ((x * 7 + y * 3) % 12) + 2, py, 1, 7);
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
        default:
          if ((x + y) % 2 === 0) rect(accent, px, py, T, T);
      }
    }
  }

  // Doors (threshold strips).
  for (const d of map.doors) rect(0x8a6a4a, d.x * T, d.y * T, T, T);

  // Walls with a visible front face where floor is below.
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      if (!map.walls[y]![x]) continue;
      const px = x * T;
      const py = y * T;
      const floorBelow = y + 1 < map.rows && !map.walls[y + 1]![x];
      rect(WALL_TOP, px, py, T, T);
      rect(WALL_EDGE, px, py, T, 1);
      if (floorBelow) {
        rect(WALL_FACE, px, py + 8, T, 8);
        rect(0x3a3354, px, py + 8, T, 1);
        rect(0x000000, px, py + 15, T, 1, 0.25);
      }
    }
  }

  // Front door + windows along the top wall.
  if (map.frontDoor.x >= 0) {
    const px = map.frontDoor.x * T;
    const py = map.frontDoor.y * T;
    rect(0x9a6a3a, px - T / 2, py, T * 2, T);
    rect(0x7a4e28, px - T / 2 + 2, py + 2, T * 2 - 4, T - 2);
    rect(0xe8c070, px + T - 2, py + 8, 2, 2);
  }
  for (let x = 3; x < map.cols - 3; x += 6) {
    if (!map.walls[0]![x]) continue;
    rect(0x9fd0ff, x * T + 3, 3, T * 2 - 6, 8);
    rect(0xd8f0ff, x * T + 5, 4, 3, 6, 0.8);
    rect(WALL_EDGE, x * T + T - 1, 3, 2, 8);
  }

  // Chairs under sitting spots (drawn before furniture so desks overlap).
  for (const zone of Object.values(map.zones)) {
    if (!['desks', 'meeting-room', 'review-booth', 'pm-office'].includes(zone.zone)) continue;
    for (const s of zone.seats) {
      if (s.kind !== 'sit') continue;
      const px = s.x * T;
      const py = s.y * T;
      rect(0x2c3046, px + 3, py + 4, 10, 9);
      rect(0x3e4462, px + 4, py + 5, 8, 6);
      rect(0x1c1e2c, px + 7, py + 13, 2, 2);
    }
  }

  for (const f of map.furniture) drawFurniture(f, T, rect, rand);

  const key = BASE_TEXTURE;
  if (scene.textures.exists(key)) scene.textures.remove(key);
  g.generateTexture(key, map.cols * T, map.rows * T);
  g.destroy();
  return key;
}

type RectFn = (c: number, x: number, y: number, w: number, h: number, a?: number) => void;

const BOOK_COLORS = [0xb5433a, 0x3a7ab5, 0x5aa04a, 0xd6a852, 0x8a4ab5, 0xe07a3a, 0x3ab5a0];

function drawFurniture(f: Furniture, T: number, rect: RectFn, rand: () => number) {
  const x = f.x * T;
  const y = f.y * T;
  const w = f.w * T;
  const h = f.h * T;
  switch (f.kind) {
    case 'desk': {
      rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
      rect(0x7a5230, x, y + 3, w, 11);
      rect(0xa47148, x, y + 3, w, 8);
      for (let i = 0; i < f.w; i++) {
        const mx = x + i * T + 3;
        rect(0x22252e, mx, y - 3, 10, 8);
        rect(0x5fb8ff, mx + 1, y - 2, 8, 5);
        rect(0xa8dcff, mx + 2, y - 2, 3, 1);
        rect(0x22252e, mx + 4, y + 5, 2, 2);
        rect(0xd8d4cc, mx + 1, y + 8, 8, 2);
      }
      break;
    }
    case 'boss-desk': {
      rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
      rect(0x5a3418, x, y + 2, w, 12);
      rect(0x7a4a2a, x, y + 2, w, 9);
      rect(0x22252e, x + 18, y - 2, 12, 8);
      rect(0x5fb8ff, x + 19, y - 1, 10, 5);
      rect(0xf5f0e0, x + 5, y + 4, 7, 5);
      rect(0xe8c070, x + 36, y - 1, 4, 3);
      rect(0x444444, x + 37, y + 2, 2, 5);
      break;
    }
    case 'table': {
      rect(0x000000, x + 2, y + h - 2, w - 2, 3, 0.25);
      rect(0x6a4a30, x, y, w, h);
      rect(0x9a7450, x + 1, y + 1, w - 2, h - 3);
      for (let i = 0; i < Math.max(1, f.w / 2); i++) rect(0xf5f0e0, x + 4 + i * 2 * T, y + 4 + (i % 2) * 6, 6, 4);
      rect(0xe8e8e8, x + w - 10, y + 5, 3, 3);
      break;
    }
    case 'whiteboard': {
      rect(0x8a8a9a, x, y + 1, w, 12);
      rect(0xf4f4f0, x + 1, y + 2, w - 2, 9);
      for (let i = 0; i < f.w * 2; i++) {
        const c = [0x3a7ab5, 0xb5433a, 0x5aa04a][i % 3]!;
        rect(c, x + 3 + i * 7, y + 4 + (i % 3) * 2, 4 + (i % 2) * 2, 1);
      }
      rect(0x9013fe, x + 6, y + 8, 10, 1);
      rect(0x6a6a7a, x, y + 13, w, 2);
      break;
    }
    case 'rack': {
      rect(0x000000, x + 1, y + h - 1, w, 3, 0.3);
      rect(0x1b1e26, x + 1, y, w - 2, h);
      for (let yy = y + 2; yy < y + h - 2; yy += 4) rect(0x2e3440, x + 2, yy, w - 4, 3);
      break;
    }
    case 'shelf': {
      rect(0x4a2c14, x, y, w, h);
      for (let row = 0; row < 2; row++) {
        const sy = y + 2 + row * 7;
        rect(0x6b4424, x + 1, sy + 5, w - 2, 1);
        for (let bx = x + 2; bx < x + w - 2; ) {
          const bw = 1 + Math.floor(rand() * 3);
          const bh = 3 + Math.floor(rand() * 3);
          rect(BOOK_COLORS[Math.floor(rand() * BOOK_COLORS.length)]!, bx, sy + 5 - bh, bw, bh);
          bx += bw + (rand() < 0.2 ? 2 : 0);
        }
      }
      break;
    }
    case 'sofa': {
      rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
      rect(0x6a2a3a, x, y, w, 14);
      rect(0x8a3b4a, x + 2, y + 5, w - 4, 7);
      for (let i = 1; i < f.w; i++) rect(0x6a2a3a, x + i * T, y + 5, 1, 7);
      break;
    }
    case 'armchair': {
      rect(0x2a5a6a, x + 1, y + 1, w - 2, 13);
      rect(0x3b7a8a, x + 3, y + 5, w - 6, 7);
      break;
    }
    case 'plant': {
      rect(0x000000, x + 3, y + 13, 10, 3, 0.25);
      rect(0xa0522d, x + 4, y + 9, 8, 6);
      rect(0x7a3a1d, x + 4, y + 9, 8, 1);
      rect(0x2e7d32, x + 2, y + 2, 12, 7);
      rect(0x4caf50, x + 4, y, 8, 6);
      rect(0x81c784, x + 6, y + 1, 3, 2);
      break;
    }
    case 'coffee': {
      rect(0x000000, x + 2, y + 13, 12, 3, 0.25);
      rect(0x3a3a44, x + 2, y + 1, 12, 13);
      rect(0x55555f, x + 3, y + 2, 10, 4);
      rect(0xff5a5a, x + 11, y + 3, 1, 1);
      rect(0x1a1a1a, x + 5, y + 8, 6, 4);
      rect(0xf5f5f5, x + 6, y + 10, 4, 3);
      break;
    }
    case 'bench': {
      rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
      rect(0x7c8a96, x, y + 2, w, 12);
      rect(0xdde4ea, x, y + 2, w, 8);
      for (let i = 0; i < f.w; i++) {
        const c = [0x7ef0a0, 0x50e3c2, 0xffa94a, 0xb48cff][i % 4]!;
        rect(0xd9eef7, x + i * T + 5, y - 1, 4, 6);
        rect(c, x + i * T + 5, y + 2, 4, 3);
        if (i % 2 === 0) rect(0x5a6470, x + i * T + 11, y + 3, 3, 5);
      }
      break;
    }
    case 'booth': {
      rect(0x3a2e52, x - 2, y - 2, 2, h + 4);
      rect(0x3a2e52, x + w, y - 2, 2, h + 4);
      rect(0x6b5a8a, x, y + 3, w, 10);
      rect(0x22252e, x + 3, y - 2, 10, 7);
      rect(0xc08aff, x + 4, y - 1, 8, 4);
      break;
    }
    case 'mat':
      rect(0x7a2a2a, x, y + 2, w, h - 4);
      rect(0x9a3a3a, x + 2, y + 4, w - 4, h - 8);
      break;
    case 'rug':
      rect(0x9a6a3a, x + 2, y + 2, w - 4, h - 4, 0.8);
      rect(0xb88a5a, x + 4, y + 4, w - 8, h - 8, 0.8);
      rect(0x9a6a3a, x + 8, y + 8, w - 16, Math.max(1, h - 16), 0.8);
      break;
  }
}
