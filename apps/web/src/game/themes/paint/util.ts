import type * as Phaser from 'phaser';

/** Shared by every `paint/*.ts` recipe: one flat tile size and a terse fill helper. */
export const T = 16;

export type RectFn = (c: number, x: number, y: number, w: number, h: number, a?: number) => void;

export function rectFn(g: Phaser.GameObjects.Graphics): RectFn {
  return (c, x, y, w, h, a = 1) => {
    g.fillStyle(c, a);
    g.fillRect(x, y, w, h);
  };
}

export function lighten(c: number, t: number): number {
  const r = (c >> 16) & 0xff;
  const gg = (c >> 8) & 0xff;
  const b = c & 0xff;
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(v + (255 - v) * t)));
  return (m(r) << 16) | (m(gg) << 8) | m(b);
}

export function darken(c: number, t: number): number {
  const r = (c >> 16) & 0xff;
  const gg = (c >> 8) & 0xff;
  const b = c & 0xff;
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 - t))));
  return (m(r) << 16) | (m(gg) << 8) | m(b);
}

/** Tile coordinates from a top-left pixel position (paintFloor/paintWall only receive pixels). */
export const tileOf = (px: number, py: number) => ({ x: Math.round(px / T), y: Math.round(py / T) });
