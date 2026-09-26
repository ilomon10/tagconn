import type * as Phaser from 'phaser';
import type { FurnitureKind, PlacedFurniture } from '../../procgen/types';
import { darken, lighten, rectFn, type RectFn } from './util';

type Painter = (g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn) => void;

const BOOK_COLORS = [0xb5433a, 0x3a7ab5, 0x5aa04a, 0xd6a852, 0x8a4ab5, 0xe07a3a, 0x3ab5a0];
// Decor seed palettes (M8 8n): 2-3 seeded variants per decor kind, picked by `f.variant`.
const CRATE_COLORS = [0x8a6a3a, 0x5a6a7a, 0x6a7a4a];
const WALL_ART_COLORS = [0x5fb8ff, 0x6cf08a, 0xffa94a];
const BANNER_COLORS_MODERN = [0xff5a5a, 0x5fb8ff, 0x6cf08a];

/** Deterministic per-item variety without a shared RNG stream (furniture has no `rand` argument). */
function pick<T>(arr: readonly T[], seed: number): T {
  return arr[((seed % arr.length) + arr.length) % arr.length]!;
}

// ==================================================================== modern (port of renderMap.ts)

const MODERN: Record<FurnitureKind, Painter> = {
  'work-desk': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
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
  },
  'lead-desk': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
    rect(0x5a3418, x, y + 2, w, 12);
    rect(0x7a4a2a, x, y + 2, w, 9);
    rect(0x22252e, x + 18, y - 2, 12, 8);
    rect(0x5fb8ff, x + 19, y - 1, 10, 5);
    rect(0xf5f0e0, x + 5, y + 4, 7, 5);
    rect(0xe8c070, x + 36, y - 1, 4, 3);
    rect(0x444444, x + 37, y + 2, 2, 5);
  },
  table: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x000000, x + 2, y + h - 2, w - 2, 3, 0.25);
    rect(0x6a4a30, x, y, w, h);
    rect(0x9a7450, x + 1, y + 1, w - 2, h - 3);
    for (let i = 0; i < Math.max(1, f.w / 2); i++) rect(0xf5f0e0, x + 4 + i * 2 * T, y + 4 + (i % 2) * 6, 6, 4);
    rect(0xe8e8e8, x + w - 10, y + 5, 3, 3);
  },
  board: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x8a8a9a, x, y + 1, w, 12);
    rect(0xf4f4f0, x + 1, y + 2, w - 2, 9);
    for (let i = 0; i < f.w * 2; i++) {
      const c = [0x3a7ab5, 0xb5433a, 0x5aa04a][i % 3]!;
      rect(c, x + 3 + i * 7, y + 4 + (i % 3) * 2, 4 + (i % 2) * 2, 1);
    }
    rect(0x9013fe, x + 6, y + 8, 10, 1);
    rect(0x6a6a7a, x, y + 13, w, 2);
  },
  workbench: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
    rect(0x7c8a96, x, y + 2, w, 12);
    rect(0xdde4ea, x, y + 2, w, 8);
    for (let i = 0; i < f.w; i++) {
      const c = [0x7ef0a0, 0x50e3c2, 0xffa94a, 0xb48cff][i % 4]!;
      rect(0xd9eef7, x + i * T + 5, y - 1, 4, 6);
      rect(c, x + i * T + 5, y + 2, 4, 3);
      if (i % 2 === 0) rect(0x5a6470, x + i * T + 11, y + 3, 3, 5);
    }
  },
  booth: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x3a2e52, x - 2, y - 2, 2, h + 4);
    rect(0x3a2e52, x + w, y - 2, 2, h + 4);
    rect(0x6b5a8a, x, y + 3, w, 10);
    rect(0x22252e, x + 3, y - 2, 10, 7);
    rect(0xc08aff, x + 4, y - 1, 8, 4);
  },
  rack: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x000000, x + 1, y + h - 1, w, 3, 0.3);
    rect(0x1b1e26, x + 1, y, w - 2, h);
    for (let yy = y + 2; yy < y + h - 2; yy += 4) rect(0x2e3440, x + 2, yy, w - 4, 3);
  },
  shelf: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x4a2c14, x, y, w, h);
    for (let row = 0; row < 2; row++) {
      const sy = y + 2 + row * 7;
      rect(0x6b4424, x + 1, sy + 5, w - 2, 1);
      let bx = x + 2;
      let i = 0;
      while (bx < x + w - 2) {
        const bw = 1 + (i % 3);
        const bh = 3 + ((i + row) % 3);
        rect(pick(BOOK_COLORS, f.variant + i), bx, sy + 5 - bh, bw, bh);
        bx += bw + (i % 5 === 0 ? 2 : 0);
        i++;
      }
    }
  },
  sofa: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
    rect(0x6a2a3a, x, y, w, 14);
    rect(0x8a3b4a, x + 2, y + 5, w - 4, 7);
    for (let i = 1; i < f.w; i++) rect(0x6a2a3a, x + i * T, y + 5, 1, 7);
  },
  armchair: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x2a5a6a, x + 1, y + 1, w - 2, 13);
    rect(0x3b7a8a, x + 3, y + 5, w - 6, 7);
  },
  plant: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    rect(0x000000, x + 3, y + 13, 10, 3, 0.25);
    rect(0xa0522d, x + 4, y + 9, 8, 6);
    rect(0x7a3a1d, x + 4, y + 9, 8, 1);
    rect(0x2e7d32, x + 2, y + 2, 12, 7);
    rect(0x4caf50, x + 4, y, 8, 6);
    rect(0x81c784, x + 6, y + 1, 3, 2);
  },
  counter: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    rect(0x000000, x + 2, y + 13, 12, 3, 0.25);
    rect(0x3a3a44, x + 2, y + 1, 12, 13);
    rect(0x55555f, x + 3, y + 2, 10, 4);
    rect(0xff5a5a, x + 11, y + 3, 1, 1);
    rect(0x1a1a1a, x + 5, y + 8, 6, 4);
    rect(0xf5f5f5, x + 6, y + 10, 4, 3);
  },
  mat: (g, f, T, rect) => {
    // A patterned entrance doormat (style pass: navy with a white motif).
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x1c2a4a, x, y + 2, w, h - 4);
    rect(0x24325a, x + 2, y + 4, w - 4, h - 8);
    rect(0xe8e4da, x + 2, y + Math.floor(h / 2), w - 4, 1, 0.8);
    rect(0xe8e4da, x + Math.floor(w / 2), y + 4, 1, h - 8, 0.8);
  },
  rug: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x9a6a3a, x + 2, y + 2, w - 4, h - 4, 0.8);
    rect(0xb88a5a, x + 4, y + 4, w - 8, h - 8, 0.8);
    rect(0x9a6a3a, x + 8, y + 8, w - 16, Math.max(1, h - 16), 0.8);
  },
  // New procgen kinds without a pre-M7 equivalent: kept plain and functional.
  centerpiece: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x000000, x + 1, y + h - 2, w - 2, 3, 0.2);
    rect(0x3a3a44, x, y, w, h);
    rect(0x22252e, x + 2, y - 2, w - 4, 6);
    rect(0x5fb8ff, x + 3, y - 1, w - 6, 3);
  },
  pedestal: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    rect(0x000000, x + 2, y + 13, 12, 3, 0.2);
    rect(0x3a3a44, x + 3, y + 4, 10, 10);
    rect(0x5fb8ff, x + 4, y - 1, 8, 6, 0.7);
  },
  sigil: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x2a3a4a, x + 1, y + 1, w - 2, h - 2, 0.5);
    rect(0x4ab5ff, x + 1, y + 1, w - 2, 1, 0.5);
    rect(0x4ab5ff, x + 1, y + h - 2, w - 2, 1, 0.5);
  },
  'stairs-up': (g, f, T, rect) => paintModernStairs(g, f, T, rect, true),
  'stairs-down': (g, f, T, rect) => paintModernStairs(g, f, T, rect, false),
  // M8 8n (furnishing engine): server racks, consoles, benches and decor so rooms fill by density
  // instead of leaving floor empty. `rack-row`/`shelf-stack`/`lab-bench` tile per-tile across
  // whatever `f.w`/`f.h` the recipe (or a test fixture) hands them.
  'rack-row': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x000000, x + 1, y + h - 1, w, 3, 0.3);
    rect(0x1b1e26, x + 1, y, w - 2, h);
    const LED = [0x4bffa0, 0xffd84a, 0xff5a5a];
    for (let row = 0; row < f.h; row++) {
      const ry = y + row * T;
      rect(0x2e3440, x + 2, ry + 2, w - 4, T - 6);
      rect(pick(LED, f.variant + row), x + w - 5, ry + 3, 2, 2);
    }
    rect(lighten(0x1b1e26, 0.12), x + 1, y, w - 2, 1);
  },
  console: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x000000, x + 1, y + h - 2, w - 2, 3, 0.25);
    rect(0x3a3a44, x, y + h - 6, w, 6);
    rect(0x22252e, x + 2, y - 2, w - 4, h - 6);
    rect(0x5fb8ff, x + 3, y - 1, w - 8, h - 9);
    rect(0xa8dcff, x + 4, y, 3, 1);
  },
  'lab-bench': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
    rect(0x7c8a96, x, y + 2, w, 12);
    rect(0xdde4ea, x, y + 2, w, 8);
    for (let i = 0; i < f.w; i++) {
      const c = pick([0x7ef0a0, 0x50e3c2, 0xffa94a, 0xb48cff, 0xff6f91], f.variant + i);
      rect(0xd9eef7, x + i * T + 3, y - 3, 3, 7);
      rect(c, x + i * T + 3, y + 1, 3, 3);
      rect(0x22252e, x + i * T + 9, y - 1, 2, 5);
      rect(0xff8a3a, x + i * T + 9, y + 2, 2, 2, 0.8);
    }
  },
  equipment: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x000000, x + 1, y + h - 2, w - 2, 3, 0.25);
    rect(0x2a2e38, x, y, w, h);
    rect(0x3a4048, x + 2, y + 2, w - 4, h - 6);
    rect(0x5fb8ff, x + 3, y + 3, w - 6, 4, 0.85);
    const LED = [0x4bffa0, 0xffd84a, 0xff5a5a];
    for (let i = 0; i < 3; i++) rect(pick(LED, f.variant + i), x + 3 + i * 3, y + h - 5, 2, 2);
  },
  'shelf-stack': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x33363f, x, y, w, h);
    rect(0x22252e, x + 1, y + Math.max(1, h - 3), w - 2, 1);
    let bx = x + 2;
    let i = 0;
    while (bx < x + w - 2) {
      const bw = 1 + (i % 3);
      const bh = Math.min(Math.max(1, h - 4), 3 + (i % 3));
      rect(pick(BOOK_COLORS, f.variant + i), bx, y + Math.max(1, h - 3) - bh, bw, bh);
      bx += bw + (i % 4 === 0 ? 2 : 0);
      i++;
    }
  },
  'reading-table': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 2, y + 13, Math.max(1, w - 4), 3, 0.25);
    rect(0x6a4a30, x, y + 2, w, 11);
    rect(0x9a7450, x + 1, y + 2, w - 2, 7);
    rect(0xf5f0e0, x + 3, y + 3, 6, 4);
    rect(0xffd84a, x + w - 6, y - 1, 2, 2, 0.85);
  },
  'standing-table': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 2, y + 13, Math.max(1, w - 4), 3, 0.2);
    rect(0x2e323a, x, y + 4, w, 3);
    rect(0x1c1f24, x + 3, y + 7, 2, 6);
    rect(0x1c1f24, x + w - 5, y + 7, 2, 6);
    rect(0x22252e, x + 3, y - 2, Math.max(1, w - 6), 5);
    rect(0x5fb8ff, x + 4, y - 1, Math.max(1, w - 8), 3);
  },
  'reception-desk': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
    rect(0x3a4a5a, x, y + 3, w, 11);
    rect(0x51697c, x, y + 3, w, 4);
    rect(0x22252e, x + 3, y - 2, 8, 6);
    rect(0x5fb8ff, x + 4, y - 1, 6, 4);
    rect(0xf5f5f5, x + w - 8, y + 5, 6, 3);
  },
  bench: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.2);
    rect(0x4a4f58, x, y + 3, w, 2);
    rect(0x3a3f47, x, y + 6, w, 3);
    rect(0x2a2e35, x + 1, y + 9, 2, 5);
    rect(0x2a2e35, x + w - 3, y + 9, 2, 5);
  },
  lamp: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    rect(0x000000, x + 5, y + 14, 6, 2, 0.2);
    rect(0x2a2e35, x + 7, y + 6, 2, 8);
    rect(0x3a3f47, x + 5, y + 14, 6, 1);
    rect(0xffe6a0, x + 4, y, 8, 6, 0.85);
    rect(0xfff6d8, x + 6, y + 2, 4, 2, 0.5);
  },
  crate: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const c = pick(CRATE_COLORS, f.variant);
    rect(0x000000, x + 2, y + 13, 12, 3, 0.2);
    rect(c, x + 2, y + 3, 12, 11);
    rect(darken(c, 0.25), x + 2, y + 3, 12, 2);
    rect(darken(c, 0.35), x + 3, y + 7, 10, 1);
  },
  'wall-art': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const c = pick(WALL_ART_COLORS, f.variant);
    rect(0x1b1e26, x + 2, y + 1, 12, 10);
    rect(c, x + 3, y + 2, 10, 8, 0.9);
    rect(lighten(c, 0.3), x + 4, y + 3, 4, 3, 0.6);
  },
  bin: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    rect(0x000000, x + 4, y + 14, 8, 2, 0.2);
    rect(0x3a3f47, x + 4, y + 5, 8, 9);
    rect(0x2a2e35, x + 4, y + 5, 8, 2);
    rect(0x51565f, x + 5, y + 8, 6, 5, 0.6);
  },
  cabinet: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    rect(0x000000, x + 2, y + 14, 12, 2, 0.2);
    rect(0x4a4f58, x + 2, y + 1, 12, 13);
    rect(0x353a42, x + 2, y + 6, 12, 1);
    rect(0x5fb8ff, x + 3, y + 2, 2, 1);
    rect(0x5fb8ff, x + 3, y + 8, 2, 1);
  },
  chair: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    rect(0x000000, x + 4, y + 14, 8, 2, 0.2);
    rect(0x2a2e35, x + 7, y + 9, 2, 5);
    rect(0x3a4a5a, x + 4, y + 3, 8, 7);
    rect(0x51697c, x + 4, y + 3, 8, 2);
  },
  banner: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const c = pick(BANNER_COLORS_MODERN, f.variant);
    rect(0x2a2e35, x + 7, y, 1, 15);
    rect(c, x + 8, y + 1, 6, 5, 0.9);
    rect(lighten(c, 0.3), x + 8, y + 1, 6, 1);
  },
};

function paintModernStairs(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn, up: boolean): void {
  const x = f.x * T;
  const y = f.y * T;
  for (let i = 0; i < 3; i++) rect(lighten(0x3a4252, i * 0.12), x, y + i * 3, T, 3);
  const c = up ? 0x6cf08a : 0xffa94a;
  rect(c, x + 6, y + 5, 4, 1);
  rect(c, x + 7, y + 3, 2, 1);
  if (!up) {
    rect(c, x + 6, y + 3, 4, 1);
    rect(c, x + 7, y + 5, 2, 1);
  }
}

export function paintModernFurniture(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number): void {
  MODERN[f.kind](g, f, T, rectFn(g));
}

// ==================================================================== guild

const GOLD = 0xe8c070;
const WOOD = 0x8a5a2b;
const WOOD_DARK = 0x5a3a1e;

function candleAndScroll(rect: RectFn, x: number, y: number): void {
  rect(0xf2ecd8, x, y, 1, 2);
  rect(0xffd84a, x, y - 1, 1, 1);
  rect(0xdcc9a0, x + 3, y + 1, 3, 2);
  rect(0x2a2a33, x + 7, y + 1, 1, 2);
}

const GUILD: Record<FurnitureKind, Painter> = {
  'work-desk': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.22);
    rect(WOOD_DARK, x, y + 3, w, 11);
    rect(WOOD, x, y + 3, w, 8);
    for (let gx = x + 2; gx < x + w - 2; gx += 4) rect(darken(WOOD, 0.2), gx, y + 3, 1, 8, 0.5);
    for (let i = 0; i < f.w; i++) candleAndScroll(rect, x + i * T + 3, y);
  },
  'lead-desk': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.25);
    rect(0x4a2c14, x, y + 2, w, 12);
    rect(0x6b3f1e, x, y + 2, w, 9);
    for (let gx = x + 2; gx < x + w - 2; gx += 5) rect(darken(0x6b3f1e, 0.2), gx, y + 2, 1, 9, 0.5);
    // A small throne behind the desk.
    rect(0x3a1f10, x + w - 8, y - 6, 7, 8);
    rect(GOLD, x + w - 7, y - 6, 5, 1);
    rect(0x6b1b26, x + w - 6, y - 4, 3, 4);
    candleAndScroll(rect, x + 4, y);
  },
  table: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    rect(0x000000, x + 2, y + h - 2, w - 2, 3, 0.25);
    if (f.roomType === 'lounge') {
      rect(0x5a3a1e, x, y, w, h);
      rect(0x8a5a2b, x + 1, y + 1, w - 2, h - 3);
      for (let i = 0; i < Math.max(1, f.w); i++) rect(0xd9c9a0, x + 3 + i * T, y + 3, 3, 3);
    } else {
      // War Council: long oak table with a map and candles.
      rect(0x4a2c14, x, y, w, h);
      rect(0x6b4424, x + 1, y + 1, w - 2, h - 3);
      rect(0xdcc9a0, x + 2, y + 2, w - 4, Math.max(1, h - 5), 0.85);
      rect(0xb5433a, x + 3, y + 3, w - 6, 1, 0.6);
      candleAndScroll(rect, x + w - 6, y);
    }
  },
  board: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    // A wall-wide parchment map with pins.
    rect(0x4a2c14, x, y + 1, w, 12);
    rect(0xe8d9b0, x + 1, y + 2, w - 2, 9);
    rect(0x9a8a6a, x + 3, y + 4, w - 6, 1, 0.6);
    rect(0x9a8a6a, x + 6, y + 8, w - 12, 1, 0.6);
    for (let i = 0; i < f.w; i++) rect([0xb5433a, 0x3a7ab5, 0x5aa04a][i % 3]!, x + 3 + i * 6, y + 5 + (i % 3) * 2, 1, 1);
    rect(0x2a1c0e, x, y + 13, w, 2);
  },
  workbench: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    // A bench with coloured potion flasks.
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.22);
    rect(0x4a3826, x, y + 2, w, 12);
    rect(0x6b4f38, x, y + 2, w, 8);
    for (let i = 0; i < f.w; i++) {
      const c = [0x7ef0a0, 0xff8a3a, 0xb48cff, 0x6ff5ff][(i + f.variant) % 4]!;
      rect(0xd9eef7, x + i * T + 5, y - 2, 3, 5);
      rect(c, x + i * T + 5, y + 1, 3, 3);
    }
  },
  booth: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    // A lectern with an open tome and a candle.
    rect(0x4a2c14, x + 2, y + 6, w - 4, 8);
    rect(0x6b4424, x + 3, y + 2, w - 6, 6);
    rect(0xe8d9b0, x + 4, y + 3, w - 8, 4);
    rect(0xb5433a, x + Math.floor(w / 2) - 1, y + 3, 1, 4, 0.6);
    rect(0xffd84a, x + w - 4, y, 1, 1);
    rect(0xf2ecd8, x + w - 4, y + 1, 1, 2);
  },
  rack: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    // A crystal pylon veined with glowing orbs.
    rect(0x1c2230, x + 1, y, w - 2, h);
    for (let yy = y + 2; yy < y + h - 2; yy += 4) rect(0x2c7a7a, x + Math.floor(w / 2) - 1, yy, 2, 2, 0.85);
    rect(lighten(0x1c2230, 0.15), x + 1, y, w - 2, 1);
  },
  shelf: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    if (f.roomType === 'pm-office') {
      // A trophy shelf.
      rect(WOOD_DARK, x, y, w, h);
      rect(0x6b4424, x + 1, y + 8, w - 2, 1);
      for (let i = 0; i < f.w * 2 && i < 6; i++) rect(GOLD, x + 2 + i * 3, y + 8 - (2 + (i % 3)), 2, 2 + (i % 3));
      return;
    }
    // Grand Library: a tall bookcase, colours seeded by `variant`.
    rect(0x4a2c14, x, y, w, h);
    for (let row = 0; row < 2; row++) {
      const sy = y + 2 + row * 7;
      rect(0x6b4424, x + 1, sy + 5, w - 2, 1);
      let bx = x + 2;
      let i = 0;
      while (bx < x + w - 2) {
        const bw = 1 + (i % 3);
        const bh = 3 + ((i + row) % 3);
        rect(pick(BOOK_COLORS, f.variant + i), bx, sy + 5 - bh, bw, bh);
        bx += bw + (i % 5 === 0 ? 2 : 0);
        i++;
      }
    }
  },
  sofa: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    // A long tavern bench.
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.22);
    rect(WOOD_DARK, x, y + 5, w, 9);
    rect(WOOD, x, y + 5, w, 3);
    for (let i = 1; i < f.w; i++) rect(WOOD_DARK, x + i * T, y + 5, 1, 9);
  },
  armchair: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    if (f.roomType === 'lounge') {
      // A tavern stool.
      rect(WOOD_DARK, x + 4, y + 4, 8, 3);
      rect(WOOD, x + 4, y + 4, 8, 1);
      rect(WOOD_DARK, x + 5, y + 7, 1, 6);
      rect(WOOD_DARK, x + 10, y + 7, 1, 6);
      return;
    }
    // A velvet reading chair.
    rect(0x3a2050, x + 1, y + 1, w - 2, 13);
    rect(0x6b3f8a, x + 3, y + 5, w - 6, 7);
  },
  plant: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    if (f.roomType === 'lounge') {
      // A barrel stack.
      rect(0x6b4424, x + 3, y + 8, 10, 6);
      rect(0x8a5a2b, x + 3, y + 8, 10, 1);
      rect(0x4a2c14, x + 3, y + 10, 10, 1);
      rect(0x6b4424, x + 5, y + 2, 6, 6);
      rect(0x4a2c14, x + 5, y + 4, 6, 1);
      return;
    }
    // Entrance: an iron brazier (the flame itself is animated separately).
    rect(0x2a2a33, x + 5, y + 10, 6, 4);
    rect(0x1c1c22, x + 6, y + 12, 4, 2);
    rect(0xff8a3a, x + 5, y + 6, 6, 4, 0.7);
  },
  counter: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    // A barrel with a brass tap.
    rect(0x6b4424, x + 2, y + 1, 12, 13);
    rect(0x8a5a2b, x + 2, y + 1, 12, 4);
    rect(0x8a5a2b, x + 2, y + 9, 12, 1);
    rect(0x4a2c14, x + 2, y + 5, 12, 1);
    rect(GOLD, x + 12, y + 6, 3, 2);
  },
  mat: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    // A rune threshold stone.
    rect(0x3a3446, x, y + 2, w, h - 4, 0.9);
    rect(0x6ff5ff, x + 2, y + 3, w - 4, 1, 0.5);
    rect(0x6ff5ff, x + 2, y + h - 4, w - 4, 1, 0.5);
  },
  rug: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    // A crimson rug with a gold trim (Guild Master's Hall).
    rect(0x8a1f2b, x + 1, y + 1, w - 2, h - 2, 0.85);
    rect(GOLD, x + 1, y + 1, w - 2, 1, 0.85);
    rect(GOLD, x + 1, y + h - 2, w - 2, 1, 0.85);
    rect(GOLD, x + 1, y + 1, 1, h - 2, 0.85);
    rect(GOLD, x + w - 2, y + 1, 1, h - 2, 0.85);
    rect(0xa8324a, x + 3, y + 3, Math.max(1, w - 6), Math.max(1, h - 6), 0.6);
  },
  centerpiece: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    if (f.roomType === 'qa-lab') {
      // A bubbling cauldron (the bubbles themselves animate separately).
      rect(0x000000, x + 2, y + h - 2, w - 4, 3, 0.25);
      g.fillStyle(0x1c1c22, 1);
      g.fillEllipse(x + w / 2, y + h / 2 + 2, w - 3, h - 5);
      rect(0x0f0f14, x + 3, y + 2, w - 6, 3);
      g.fillStyle(0x3fae5a, 0.9);
      g.fillEllipse(x + w / 2, y + h / 2 - 1, w - 7, 4);
      rect(0xff8a3a, x + w / 2 - 3, y + h - 1, 6, 2, 0.7);
      return;
    }
    // Map Room: a brass orrery on a small table.
    rect(0x4a2c14, x + 2, y + h - 4, w - 4, 4);
    rect(GOLD, x + w / 2 - 1, y + 2, 2, h - 6);
    g.fillStyle(0xdcb35a, 0.9);
    g.fillCircle(x + w / 2, y + 4, 3);
  },
  pedestal: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    // A crystal ball on a stone pedestal (the shimmer animates separately).
    rect(0x3a3446, x + 3, y + 8, 10, 8);
    rect(0x2e283c, x + 4, y + 14, 8, 2);
    g.fillStyle(0x6ff5ff, 0.85);
    g.fillCircle(x + 8, y + 4, 4);
    g.fillStyle(0xffffff, 0.8);
    g.fillCircle(x + 6, y + 2, 1);
  },
  sigil: (g, f, T) => {
    const x = f.x * T + (f.w * T) / 2;
    const y = f.y * T + (f.h * T) / 2;
    const r = Math.min(f.w, f.h) * T * 0.42;
    // The static outer/inner ring; the rotating glyphs animate separately.
    g.lineStyle(1, 0x6ff5ff, 0.55);
    g.strokeCircle(x, y, r);
    g.strokeCircle(x, y, r * 0.6);
  },
  'stairs-up': (g, f, T, rect) => paintGuildStairs(g, f, T, rect, true),
  'stairs-down': (g, f, T, rect) => paintGuildStairs(g, f, T, rect, false),
  // M8 8n (furnishing engine): arcane counterparts of the same new kinds.
  'rack-row': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    // A tall rune-etched pylon, one crystal cabinet segment per row.
    rect(0x1c2230, x + 1, y, w - 2, h);
    const ORB = [0x2c7a7a, 0x6ff5ff, 0x9a6bff];
    for (let row = 0; row < f.h; row++) {
      const ry = y + row * T;
      rect(darken(0x1c2230, 0.15), x + 2, ry + 1, w - 4, T - 2, 0.5);
      rect(pick(ORB, f.variant + row), x + Math.floor(w / 2) - 1, ry + 5, 2, 2, 0.85);
    }
    rect(lighten(0x1c2230, 0.15), x + 1, y, w - 2, 1);
  },
  console: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    // A scrying console: a stone stand topped by a glowing mirror.
    rect(0x000000, x + 1, y + h - 2, w - 2, 3, 0.2);
    rect(0x3a3446, x, y + h - 6, w, 6);
    rect(0x2c1c30, x + 2, y - 2, w - 4, h - 6);
    g.fillStyle(0x6ff5ff, 0.85);
    g.fillCircle(x + w / 2, y + h / 2 - 3, Math.max(2, w / 4));
    g.fillStyle(0xffffff, 0.6);
    g.fillCircle(x + w / 2 - 1, y + h / 2 - 4, 1);
  },
  'lab-bench': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    // An alchemy bench lined with coloured flasks.
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.22);
    rect(0x4a3826, x, y + 2, w, 12);
    rect(0x6b4f38, x, y + 2, w, 8);
    for (let i = 0; i < f.w; i++) {
      const c = pick([0x7ef0a0, 0xff8a3a, 0xb48cff, 0x6ff5ff], f.variant + i);
      rect(0xd9eef7, x + i * T + 4, y - 3, 3, 6);
      rect(c, x + i * T + 4, y, 3, 3);
      rect(WOOD_DARK, x + i * T + 9, y - 1, 2, 5);
    }
  },
  equipment: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    // A brass-and-glass alchemical apparatus.
    rect(0x000000, x + 1, y + h - 2, w - 2, 3, 0.2);
    rect(0x3a2e1c, x, y, w, h);
    rect(GOLD, x + 2, y + 2, w - 4, 2, 0.8);
    g.fillStyle(0x6ff5ff, 0.8);
    g.fillCircle(x + w / 2, y + h / 2 + 1, Math.max(2, Math.min(w, h) / 3));
    rect(darken(GOLD, 0.3), x + 2, y + h - 4, w - 4, 2);
  },
  'shelf-stack': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    // A low tome stack / lectern shelf, one row tall.
    rect(WOOD_DARK, x, y, w, h);
    let bx = x + 2;
    let i = 0;
    while (bx < x + w - 2) {
      const bw = 1 + (i % 3);
      const bh = Math.min(Math.max(1, h - 3), 3 + (i % 3));
      rect(pick(BOOK_COLORS, f.variant + i), bx, y + Math.max(1, h - 3) - bh, bw, bh);
      bx += bw + (i % 4 === 0 ? 2 : 0);
      i++;
    }
  },
  'reading-table': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 2, y + 13, Math.max(1, w - 4), 3, 0.22);
    rect(WOOD_DARK, x, y + 2, w, 11);
    rect(WOOD, x + 1, y + 2, w - 2, 7);
    rect(0xe8d9b0, x + 3, y + 3, 6, 4);
    candleAndScroll(rect, x + w - 6, y);
  },
  'standing-table': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    rect(0x000000, x + 2, y + 13, Math.max(1, w - 4), 3, 0.2);
    rect(WOOD_DARK, x, y + 4, w, 3);
    rect(WOOD_DARK, x + 3, y + 7, 2, 6);
    rect(WOOD_DARK, x + w - 5, y + 7, 2, 6);
    rect(0xe8d9b0, x + 3, y - 1, Math.max(1, w - 6), 4);
  },
  'reception-desk': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    // The Guild Gate's welcome desk.
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.22);
    rect(WOOD_DARK, x, y + 3, w, 11);
    rect(WOOD, x, y + 3, w, 4);
    rect(GOLD, x + w - 8, y - 2, 6, 6);
    candleAndScroll(rect, x + 3, y);
  },
  bench: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    // A tavern-style bench for the Guild Gate.
    rect(0x000000, x + 1, y + 13, w - 2, 3, 0.2);
    rect(WOOD_DARK, x, y + 5, w, 9);
    rect(WOOD, x, y + 5, w, 3);
    for (let i = 1; i < f.w; i++) rect(WOOD_DARK, x + i * T, y + 5, 1, 9);
  },
  lamp: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    // A wrought-iron candelabra.
    rect(0x000000, x + 5, y + 14, 6, 2, 0.2);
    rect(0x2a2a33, x + 7, y + 6, 2, 8);
    rect(0x2a2a33, x + 4, y + 5, 8, 1);
    rect(0xffd84a, x + 4, y + 2, 2, 3, 0.85);
    rect(0xffd84a, x + 7, y, 2, 3, 0.85);
    rect(0xffd84a, x + 10, y + 2, 2, 3, 0.85);
  },
  crate: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    const c = pick([0x8a5a2b, 0x6b4424, 0x5a3a1e], f.variant);
    rect(0x000000, x + 3, y + 13, 10, 3, 0.2);
    rect(c, x + 3, y + 3, 10, 11);
    rect(darken(c, 0.3), x + 3, y + 6, 10, 1);
    rect(darken(c, 0.3), x + 3, y + 10, 10, 1);
  },
  'wall-art': (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    // A hanging tapestry.
    const c = pick([0x8a1f2b, 0x1f3a8a, 0x3a5a2b], f.variant);
    rect(WOOD_DARK, x + 2, y, 12, 1);
    rect(c, x + 2, y + 1, 12, 11, 0.9);
    rect(GOLD, x + 3, y + 2, 10, 1, 0.7);
    rect(GOLD, x + 3, y + 10, 10, 1, 0.7);
  },
  bin: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    // An ash barrel.
    rect(0x000000, x + 4, y + 14, 8, 2, 0.2);
    rect(0x4a2c14, x + 4, y + 5, 8, 9);
    rect(0x6b4424, x + 4, y + 5, 8, 2);
    rect(0x3a1f0e, x + 5, y + 9, 6, 1);
  },
  cabinet: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    // A rune-etched wardrobe.
    rect(0x000000, x + 2, y + 14, 12, 2, 0.2);
    rect(WOOD_DARK, x + 2, y + 1, 12, 13);
    rect(WOOD, x + 2, y + 1, 12, 3);
    rect(0x6ff5ff, x + 3, y + 7, 2, 1, 0.6);
    rect(0x6ff5ff, x + 7, y + 9, 2, 1, 0.6);
  },
  chair: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    // A tavern stool with a low backrest.
    rect(WOOD_DARK, x + 4, y, 1, 5);
    rect(WOOD_DARK, x + 4, y, 8, 1);
    rect(WOOD_DARK, x + 4, y + 4, 8, 3);
    rect(WOOD, x + 4, y + 4, 8, 1);
    rect(WOOD_DARK, x + 5, y + 7, 1, 6);
    rect(WOOD_DARK, x + 10, y + 7, 1, 6);
  },
  banner: (g, f, T, rect) => {
    const x = f.x * T;
    const y = f.y * T;
    // A heraldic banner (star/key/tower emblem, seeded by variant).
    const c = pick([0x8a1f2b, 0x1f3a8a, 0x3a5a2b], f.variant);
    rect(WOOD_DARK, x + 7, y, 1, 15);
    rect(c, x + 8, y + 1, 6, 9, 0.92);
    rect(GOLD, x + 9, y + 3, 4, 1, 0.8);
    rect(GOLD, x + 10, y + 5, 2, 1, 0.8);
  },
};

function paintGuildStairs(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number, rect: RectFn, up: boolean): void {
  const x = f.x * T;
  const y = f.y * T;
  const w = f.w * T;
  for (let i = 0; i < 3; i++) rect(lighten(0x3a3446, i * 0.1), x, y + i * 3, w, 3);
  const ring = up ? 0x4ff0d0 : 0xb07aff;
  g.lineStyle(1, ring, 0.7);
  g.strokeEllipse(x + w / 2, y + 9, w - 2, 10);
}

export function paintGuildFurniture(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number): void {
  GUILD[f.kind](g, f, T, rectFn(g));
}
