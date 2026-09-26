import type * as Phaser from 'phaser';
import type { WallDecorKind, WallDecorSlot } from '../../procgen/types';
import { darken, lighten, rectFn, type RectFn } from './util';

/**
 * Static wall decor baked into the base texture (M8 8p, `docs/design/back-wall.md` section 3):
 * windows, clocks, pictures, boards, charts, shelves and banners mounted on a room's back-wall
 * face. Called by `renderTheme.ts` once per `map.northWall` slot, AFTER the face itself, so this
 * art always draws on top of `paintBackWall`'s cream/ashlar face. `face` is that face's absolute
 * top/bottom px (`{ top: y*T + capPx, bottom: (y+1)*T + bandPx }`); every painter stays inside it.
 */
type Face = { top: number; bottom: number };
type Painter = (g: Phaser.GameObjects.Graphics, slot: WallDecorSlot, x: number, w: number, face: Face, rect: RectFn) => void;

/** Deterministic per-slot variety without a shared RNG stream, mirroring `furniture.ts`'s `pick`. */
function pick<V>(arr: readonly V[], seed: number): V {
  return arr[((seed % arr.length) + arr.length) % arr.length]!;
}

function dispatch(record: Record<WallDecorKind, Painter>, g: Phaser.GameObjects.Graphics, slot: WallDecorSlot, T: number, face: Face): void {
  const x = slot.x * T;
  const w = slot.span * T;
  record[slot.kind](g, slot, x, w, face, rectFn(g));
}

// ==================================================================== modern

const MODERN_FRAME = 0x8a5a2b;
const MODERN_SKY = 0x8fd0ff;
const MODERN_GROUND = 0x6cf08a;
const MODERN_PICTURE_COLORS = [0x5fb8ff, 0x6cf08a, 0xffa94a] as const;
const MODERN_CHART_COLORS = [0x3a7ab5, 0xb5433a, 0x5aa04a, 0xd6a852] as const;
const MODERN_BANNER_COLORS = [0xff5a5a, 0x5fb8ff, 0x6cf08a] as const;

/** A wood-framed window with a sky/ground view and a cross mullion. */
function paintModernWindowPane(rect: RectFn, x: number, top: number, w: number, h: number): void {
  rect(MODERN_FRAME, x, top, w, h);
  const skyH = Math.max(1, Math.round((h - 2) * 0.6));
  rect(MODERN_SKY, x + 1, top + 1, w - 2, skyH);
  rect(MODERN_GROUND, x + 1, top + 1 + skyH, w - 2, Math.max(1, h - 2 - skyH));
  rect(lighten(MODERN_FRAME, 0.3), x + Math.floor(w / 2), top, 1, h);
  rect(lighten(MODERN_FRAME, 0.3), x, top + Math.floor(h / 2), w, 1);
}

const MODERN_DECOR: Record<WallDecorKind, Painter> = {
  window: (_g, slot, x, w, face, rect) => {
    const top = Math.round(face.top + 1);
    const h = Math.max(6, Math.round(face.bottom - top - 3));
    if (slot.span >= 2) {
      const gap = 2;
      const half = Math.floor((w - gap - 2) / 2);
      paintModernWindowPane(rect, x + 1, top, half, h);
      paintModernWindowPane(rect, x + 1 + half + gap, top, Math.max(4, w - half - gap - 2), h);
    } else {
      paintModernWindowPane(rect, x + 2, top, Math.max(4, w - 4), h);
    }
  },
  clock: (g, _slot, x, w, face, rect) => {
    const cx = x + w / 2;
    const r = Math.max(2, Math.min(w, face.bottom - face.top) * 0.3);
    const cy = face.top + r + 1;
    g.fillStyle(0x2a2e35, 1);
    g.fillCircle(cx, cy, r);
    g.fillStyle(0xf5f0e0, 1);
    g.fillCircle(cx, cy, Math.max(1, r - 1.5));
    rect(0x2a2e35, cx, cy - r * 0.55, 1, r * 0.55);
    rect(0x2a2e35, cx, cy, r * 0.4, 1);
  },
  picture: (_g, slot, x, w, face, rect) => {
    const top = Math.round(face.top + 2);
    const h = Math.max(6, Math.min(Math.round(face.bottom - top - 2), 11));
    const count = slot.span >= 2 ? 2 : 1;
    const each = Math.max(3, Math.floor((w - (count - 1) * 2) / count));
    for (let i = 0; i < count; i++) {
      const px = x + i * (each + 2);
      const c = pick(MODERN_PICTURE_COLORS, slot.variant + i);
      rect(0x1b1e26, px, top, each, h);
      rect(c, px + 1, top + 1, Math.max(1, each - 2), Math.max(1, h - 2), 0.9);
      rect(lighten(c, 0.3), px + 2, top + 2, Math.max(1, each - 4), 2, 0.6);
    }
  },
  board: (_g, slot, x, w, face, rect) => {
    const top = Math.round(face.top + 1);
    const h = Math.max(8, Math.min(Math.round(face.bottom - top - 2), 13));
    rect(0x8a8a9a, x, top, w, h);
    rect(0xf4f4f0, x + 1, top + 1, Math.max(1, w - 2), Math.max(1, h - 3));
    for (let i = 0; i < slot.span * 2; i++) {
      const c = MODERN_CHART_COLORS[i % MODERN_CHART_COLORS.length]!;
      rect(c, x + 2 + i * 6, top + 3 + (i % 3) * 2, 4, 1);
    }
    rect(0x6a6a7a, x, top + h - 2, w, 2);
  },
  chart: (_g, slot, x, w, face, rect) => {
    const top = Math.round(face.top + 2);
    const h = Math.max(6, Math.min(Math.round(face.bottom - top - 2), 10));
    rect(0x1b1e26, x, top, w, h);
    const bars = Math.max(2, slot.span * 3);
    const bw = Math.max(1, Math.floor((w - 2) / bars));
    for (let i = 0; i < bars; i++) {
      const bh = Math.min(h - 1, 2 + ((i * 3 + slot.variant) % Math.max(2, h - 2)));
      rect(pick(MODERN_CHART_COLORS, slot.variant + i), x + 1 + i * bw, top + h - 1 - bh, Math.max(1, bw - 1), bh);
    }
  },
  'wall-shelf': (_g, slot, x, w, face, rect) => {
    const top = Math.round(face.top + 3);
    const h = Math.max(6, Math.min(Math.round(face.bottom - top - 2), 9));
    rect(0x4a2c14, x, top + h - 2, w, 2);
    let bx = x + 1;
    let i = 0;
    while (bx < x + w - 1) {
      const bw = 1 + (i % 2);
      const bh = Math.min(h - 3, 2 + ((i + slot.variant) % 3));
      rect(pick(MODERN_PICTURE_COLORS, slot.variant + i), bx, top + h - 2 - bh, bw, bh);
      bx += bw + 1;
      i++;
    }
  },
  banner: (_g, slot, x, w, face, rect) => {
    const top = Math.round(face.top);
    const h = Math.max(6, Math.min(Math.round(face.bottom - top - 1), 12));
    const c = pick(MODERN_BANNER_COLORS, slot.variant);
    const poleX = x + Math.floor(w / 2) - 1;
    rect(0x2a2e35, poleX, top, 1, h);
    const clothW = Math.max(2, x + w - 1 - (poleX + 1));
    rect(c, poleX + 1, top + 1, clothW, Math.max(1, h - 3), 0.9);
    rect(lighten(c, 0.3), poleX + 1, top + 1, clothW, 1);
  },
};

export function paintModernWallDecor(g: Phaser.GameObjects.Graphics, slot: WallDecorSlot, T: number, face: Face): void {
  dispatch(MODERN_DECOR, g, slot, T, face);
}

// ==================================================================== guild

const GUILD_FRAME = 0x2e283c;
const GUILD_GLASS = 0xffb84a;
const WOOD_DARK = 0x5a3a1e;
const GOLD = 0xe8c070;
const GUILD_TAPESTRY_COLORS = [0x8a1f2b, 0x1f3a8a, 0x3a5a2b] as const;
const GUILD_POTION_COLORS = [0x7ef0a0, 0xff8a3a, 0xb48cff, 0x6ff5ff] as const;
const GUILD_BANNER_CLOTH = [0xb0202a, 0x1f3a8a, 0xb0202a] as const;

/** An arched, pointed window with a warm amber glow and a dark stone surround. */
function paintGuildWindowPane(g: Phaser.GameObjects.Graphics, rect: RectFn, x: number, top: number, w: number, h: number): void {
  const archH = Math.max(2, Math.floor(h * 0.35));
  rect(GUILD_FRAME, x, top, w, h);
  g.fillStyle(GUILD_GLASS, 0.85);
  g.fillTriangle(x + w / 2, top + 1, x + 2, top + archH, x + w - 2, top + archH);
  rect(GUILD_GLASS, x + 2, top + archH, Math.max(1, w - 4), Math.max(1, h - archH - 2), 0.85);
  rect(darken(GUILD_FRAME, 0.2), x + Math.floor(w / 2), top + archH, 1, Math.max(1, h - archH - 2));
}

const GUILD_DECOR: Record<WallDecorKind, Painter> = {
  window: (g, slot, x, w, face, rect) => {
    const top = Math.round(face.top + 1);
    const h = Math.max(7, Math.round(face.bottom - top - 3));
    if (slot.span >= 2) {
      const gap = 2;
      const half = Math.floor((w - gap - 2) / 2);
      paintGuildWindowPane(g, rect, x + 1, top, half, h);
      paintGuildWindowPane(g, rect, x + 1 + half + gap, top, Math.max(5, w - half - gap - 2), h);
    } else {
      paintGuildWindowPane(g, rect, x + 2, top, Math.max(5, w - 4), h);
    }
  },
  clock: (g, _slot, x, w, face, rect) => {
    // A heraldic round shield in place of a clock face.
    const cx = x + w / 2;
    const r = Math.max(2, Math.min(w, face.bottom - face.top) * 0.32);
    const cy = face.top + r + 1;
    g.fillStyle(WOOD_DARK, 1);
    g.fillCircle(cx, cy, r);
    g.fillStyle(GOLD, 1);
    g.fillCircle(cx, cy, Math.max(1, r - 1.5));
    rect(WOOD_DARK, cx - 0.5, cy - Math.max(1, r * 0.5), 1, Math.max(1, r));
  },
  picture: (_g, slot, x, w, face, rect) => {
    // A small hanging tapestry.
    const top = Math.round(face.top + 1);
    const h = Math.max(7, Math.min(Math.round(face.bottom - top - 2), 12));
    const c = pick(GUILD_TAPESTRY_COLORS, slot.variant);
    rect(WOOD_DARK, x + 1, top, Math.max(1, w - 2), 1);
    rect(c, x + 1, top + 1, Math.max(1, w - 2), Math.max(1, h - 2), 0.92);
    rect(GOLD, x + 1, top + 2, Math.max(1, w - 2), 1, 0.7);
    rect(GOLD, x + 1, top + h - 2, Math.max(1, w - 2), 1, 0.7);
  },
  board: (_g, slot, x, w, face, rect) => {
    // A parchment map / notice board with pins.
    const top = Math.round(face.top + 1);
    const h = Math.max(9, Math.min(Math.round(face.bottom - top - 2), 13));
    rect(0x4a2c14, x, top, w, h);
    rect(0xe8d9b0, x + 1, top + 1, Math.max(1, w - 2), Math.max(1, h - 3));
    rect(0x9a8a6a, x + 3, top + 3, Math.max(1, w - 6), 1, 0.6);
    for (let i = 0; i < slot.span * 2; i++) {
      rect(pick([0xb5433a, 0x3a7ab5, 0x5aa04a], slot.variant + i), x + 2 + i * 5, top + 4 + (i % 3), 1, 1);
    }
    rect(0x2a1c0e, x, top + h - 2, w, 2);
  },
  chart: (_g, slot, x, w, face, rect) => {
    // A star chart: a dark parchment field with seeded pinprick stars.
    const top = Math.round(face.top + 2);
    const h = Math.max(6, Math.min(Math.round(face.bottom - top - 2), 10));
    rect(0x1c2230, x, top, w, h);
    rect(GOLD, x, top, w, 1, 0.5);
    const stars = Math.max(3, slot.span * 4);
    for (let i = 0; i < stars; i++) {
      const sx = x + 1 + ((i * 7 + slot.variant * 3) % Math.max(1, w - 2));
      const sy = top + 1 + ((i * 5 + slot.variant) % Math.max(1, h - 2));
      rect(0x6ff5ff, sx, sy, 1, 1, 0.85);
    }
  },
  'wall-shelf': (_g, slot, x, w, face, rect) => {
    // A candle shelf lined with potion flasks.
    const top = Math.round(face.top + 3);
    const h = Math.max(6, Math.min(Math.round(face.bottom - top - 2), 9));
    rect(WOOD_DARK, x, top + h - 2, w, 2);
    let bx = x + 1;
    let i = 0;
    while (bx < x + w - 2) {
      const bh = Math.min(h - 3, 2 + ((i + slot.variant) % 3));
      rect(pick(GUILD_POTION_COLORS, slot.variant + i), bx, top + h - 2 - bh, 1, bh);
      bx += 2;
      i++;
    }
    rect(0xffd84a, x + Math.max(1, w - 3), top + h - 4, 1, 2, 0.85);
  },
  banner: (_g, slot, x, w, face, rect) => {
    // A heraldic banner, echoing `decor.ts`'s cached banner textures but drawn directly.
    const top = Math.round(face.top);
    const h = Math.max(7, Math.min(Math.round(face.bottom - top - 1), 13));
    const cloth = pick(GUILD_BANNER_CLOTH, slot.variant);
    const poleX = x + Math.floor(w / 2) - 1;
    rect(WOOD_DARK, poleX, top, 1, h);
    const clothW = Math.max(2, x + w - 1 - (poleX + 1));
    rect(cloth, poleX + 1, top + 1, clothW, Math.max(1, h - 3), 0.92);
    rect(GOLD, poleX + 1, top + 3, clothW, 1, 0.8);
  },
};

export function paintGuildWallDecor(g: Phaser.GameObjects.Graphics, slot: WallDecorSlot, T: number, face: Face): void {
  dispatch(GUILD_DECOR, g, slot, T, face);
}
