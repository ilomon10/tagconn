import { describe, expect, it } from 'vitest';
import type { PlacedFurniture, Rect } from '../../procgen/types';
import { buildSeeThroughIndex, headRectOf, occludersOf } from '../seeThrough';
import { DEPTH_EPSILON, SPRITE_MARGIN } from '../tables';
import type { FurnitureSprite } from '../types';

const T = 16;
const COLS = 30;
const ROWS = 24;

export function sprite(x: number, y: number, w: number, h: number, height: number, strip: Rect | null = null): FurnitureSprite {
  const item = { kind: 'bookcase', x, y, w, h, variant: 0 } as unknown as PlacedFurniture;
  return { item, frame: 'f', themeId: 't', x: x * T - SPRITE_MARGIN.side, y: y * T - SPRITE_MARGIN.top, baseY: (y + h) * T, strip, height };
}

function brute(sprites: FurnitureSprite[], head: Rect, feetY: number, min = 10): number[] {
  const out: number[] = [];
  sprites.forEach((s, i) => {
    if (s.strip !== null || s.height < min) return;
    const w = s.item.w * T + 2 * SPRITE_MARGIN.side;
    const h = SPRITE_MARGIN.top + s.item.h * T + SPRITE_MARGIN.bottom;
    const hit = head.x < s.x + w && head.x + head.w > s.x && head.y < s.y + h && head.y + head.h > s.y;
    if (hit && s.baseY - DEPTH_EPSILON > feetY) out.push(i);
  });
  return out;
}

describe('headRectOf', () => {
  it('is (x - 4, y - 18, 8, 12) and reuses the out object', () => {
    const o = { x: 0, y: 0, w: 0, h: 0 };
    expect(headRectOf(100, 50, o)).toBe(o);
    expect(o).toEqual({ x: 96, y: 32, w: 8, h: 12 });
  });
});

describe('occludersOf', () => {
  it('equals brute force on 300 random cases (several sprites per tile, clamped edges)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const sprites: FurnitureSprite[] = [];
    for (let i = 0; i < 120; i++) {
      const w = 1 + Math.floor(rnd() * 3);
      const h = 1 + Math.floor(rnd() * 2);
      sprites.push(sprite(Math.floor(rnd() * (COLS - w)), 1 + Math.floor(rnd() * (ROWS - h - 1)), w, h, [0, 6, 10, 14][Math.floor(rnd() * 4)]!));
    }
    const index = buildSeeThroughIndex(sprites, COLS, ROWS, T);
    const out = new Int32Array(64);
    const head: Rect = { x: 0, y: 0, w: 0, h: 0 };
    for (let n = 0; n < 300; n++) {
      const x = rnd() * COLS * T;
      const y = rnd() * ROWS * T;
      const c = occludersOf(index, headRectOf(x, y, head), y, out);
      expect([...out.subarray(0, c)].sort((a, b) => a - b)).toEqual(brute(sprites, head, y));
    }
  });

  it('the height threshold keeps desks out, a custom minimum lets them in; strips never occlude', () => {
    const sprites = [sprite(5, 5, 2, 1, 6), sprite(8, 5, 1, 1, 14), sprite(11, 5, 1, 1, 14, { x: 0, y: 0, w: 16, h: 4 })];
    const out = new Int32Array(8);
    const head = headRectOf(6 * T, 5 * T + 4, { x: 0, y: 0, w: 0, h: 0 });
    expect(occludersOf(buildSeeThroughIndex(sprites, COLS, ROWS, T), head, 5 * T + 4, out)).toBe(0);
    expect(occludersOf(buildSeeThroughIndex(sprites, COLS, ROWS, T, 5), head, 5 * T + 4, out)).toBe(1);
    const bk = headRectOf(8.5 * T, 5 * T + 4, head);
    expect(occludersOf(buildSeeThroughIndex(sprites, COLS, ROWS, T), bk, 5 * T + 4, out)).toBe(1);
    const strip = headRectOf(11.5 * T, 5 * T + 4, head);
    expect(occludersOf(buildSeeThroughIndex(sprites, COLS, ROWS, T), strip, 5 * T + 4, out)).toBe(0);
  });

  it('only a character behind the sprite (feet north of the depth line) is occluded', () => {
    const sprites = [sprite(8, 5, 1, 1, 14)]; // baseY = 96
    const index = buildSeeThroughIndex(sprites, COLS, ROWS, T);
    const out = new Int32Array(4);
    const head = { x: 0, y: 0, w: 0, h: 0 };
    expect(occludersOf(index, headRectOf(8.5 * T, 90, head), 90, out)).toBe(1);
    expect(occludersOf(index, headRectOf(8.5 * T, 96 - DEPTH_EPSILON, head), 96 - DEPTH_EPSILON, out)).toBe(0);
    expect(occludersOf(index, headRectOf(8.5 * T, 110, head), 110, out)).toBe(0);
  });

  it('writes into out without exceeding its length, reports no duplicates across tiles', () => {
    const sprites = [sprite(4, 5, 4, 2, 14), sprite(5, 5, 2, 2, 14), sprite(6, 5, 2, 2, 12)];
    const index = buildSeeThroughIndex(sprites, COLS, ROWS, T);
    const head = headRectOf(6 * T, 5.5 * T, { x: 0, y: 0, w: 0, h: 0 });
    const big = new Int32Array(8);
    const n = occludersOf(index, head, 5.5 * T, big);
    expect(new Set(big.subarray(0, n)).size).toBe(n);
    expect(n).toBe(3);
    expect(occludersOf(index, head, 5.5 * T, new Int32Array(2))).toBe(2);
  });

  it('an empty or out-of-map query is safe', () => {
    const index = buildSeeThroughIndex([], COLS, ROWS, T);
    const out = new Int32Array(2);
    expect(occludersOf(index, headRectOf(-50, -50, { x: 0, y: 0, w: 0, h: 0 }), -50, out)).toBe(0);
    expect(occludersOf(index, headRectOf(1e6, 1e6, { x: 0, y: 0, w: 0, h: 0 }), 1e6, out)).toBe(0);
  });
});
