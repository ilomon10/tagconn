import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, type OfficeLayout } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import { generateRandomLayout } from '../../procgen/bsp';
import type { GeneratedMap, PlacedFurniture } from '../../procgen/types';
import { kindHeight } from '../../lighting/heights';
import { modernTheme } from '../../themes/modern';
import { guildTheme } from '../../themes/guild';
import { makeCommandGraphics } from '../../themes/__tests__/testUtils';
import { planFrameKey, planSprites } from '../spritePlan';
import { DEPTH_EPSILON, FRONT_STRIP_PX, SPRITE_MARGIN, frameKey, isSitInKind, spriteClassOf } from '../tables';

const T = 16;
const plan = (map: GeneratedMap, o: { sprites?: boolean; maxSprites?: number } = {}) =>
  planSprites({ map, sprites: o.sprites ?? true, maxSprites: o.maxSprites ?? 1500, themeIdAt: () => 'modern' });

function layoutOf(seed: number): OfficeLayout {
  const input = generateRandomLayout({ width: 48, height: 30, seed, background: 'hall' });
  return { ...input, background: input.background ?? 'hall', corridorWidth: input.corridorWidth ?? 2, id: `s${seed}`, builtin: false, createdAt: 0, updatedAt: 0 };
}
let cached: GeneratedMap[] | null = null;
const maps = (): GeneratedMap[] => (cached ??= [generateMap(DEFAULT_LAYOUT), ...Array.from({ length: 300 }, (_v, i) => generateMap(layoutOf(i + 1)))]);

describe('planSprites', () => {
  it('classifies per section 2.1 and places geometry from the south edge (DEFAULT_LAYOUT + 300 BSP seeds)', () => {
    for (const map of maps()) {
      const p = plan(map);
      const wholes = p.sprites.filter((s) => s.strip === null);
      const strips = p.sprites.filter((s) => s.strip !== null);
      expect(wholes.every((s) => spriteClassOf(s.item.kind) === 'sprite' && s.height === kindHeight(s.item.kind) && s.height > 0)).toBe(true);
      expect(p.demoted).toBe(0);
      // every item is baked xor a whole sprite
      expect(p.baked.length + wholes.length).toBe(map.furniture.length);
      expect(p.baked.some((f) => spriteClassOf(f.kind) === 'sprite')).toBe(false);
      for (const s of p.sprites) {
        expect(s.baseY).toBe((s.item.y + s.item.h) * T);
        if (s.strip === null) {
          expect(s.x).toBe(s.item.x * T - SPRITE_MARGIN.side);
          expect(s.y).toBe(s.item.y * T - SPRITE_MARGIN.top);
          expect(s.frame).toBe(planFrameKey('modern', s.item));
        } else {
          expect(isSitInKind(s.item.kind)).toBe(true);
          const px = FRONT_STRIP_PX[s.item.kind as keyof typeof FRONT_STRIP_PX][s.item.facing ?? 's'];
          expect(px).toBeGreaterThan(0);
          expect(s.strip).toEqual({ x: s.item.x * T, y: s.baseY - s.strip.h, w: s.item.w * T, h: Math.min(px, s.item.h * T) });
          expect(s.y).toBe(s.strip.y);
          expect(s.height).toBe(0);
          expect(s.frame).toBe(`${planFrameKey('modern', s.item)}#strip`);
          expect(p.baked).toContain(s.item); // sit-in whole art stays baked
        }
        expect(p.frames.has(s.frame.replace(/#strip$/, ''))).toBe(true);
        expect(s.baseY - DEPTH_EPSILON).toBeLessThan(s.baseY);
      }
      // a sit-in item with a non-zero strip px has exactly one strip; the others none
      const stripItems = new Set(strips.map((s) => s.item));
      for (const f of map.furniture) {
        const expected = isSitInKind(f.kind) && FRONT_STRIP_PX[f.kind][f.facing ?? 's'] > 0;
        expect(stripItems.has(f), f.kind).toBe(expected);
      }
    }
  }, 60_000);

  it('frames dedupe by frameKey + theme and carry the slot size', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const p = plan(map);
    for (const spec of p.frames.values()) {
      expect(spec.w).toBe(spec.item.w * T + 2 * SPRITE_MARGIN.side);
      expect(spec.h).toBe(spec.item.h * T + SPRITE_MARGIN.top + SPRITE_MARGIN.bottom);
      expect(spec.key).toBe(planFrameKey(spec.themeId, spec.item));
    }
    const keys = new Set(p.sprites.map((s) => s.frame.replace(/#strip$/, '')));
    expect([...p.frames.keys()].sort()).toEqual([...keys].sort());
    expect(p.frames.size).toBeLessThan(p.sprites.length);
  });

  it('the cap keeps the tallest first, then the northmost, and is deterministic', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const full = plan(map);
    const wholeCount = full.sprites.filter((s) => s.strip === null).length;
    expect(wholeCount).toBeGreaterThan(6);
    const cap = Math.floor(wholeCount / 2);
    const a = plan(map, { maxSprites: cap });
    const b = plan(map, { maxSprites: cap });
    const wholes = a.sprites.filter((s) => s.strip === null);
    expect(wholes).toHaveLength(cap);
    expect(a.demoted).toBe(wholeCount - cap);
    expect(a.sprites.map((s) => s.frame)).toEqual(b.sprites.map((s) => s.frame));
    expect(a.baked).toEqual(b.baked);
    const keptMin = Math.min(...wholes.map((s) => s.height));
    const demoted = a.baked.filter((f) => spriteClassOf(f.kind) === 'sprite');
    expect(demoted).toHaveLength(a.demoted);
    for (const f of demoted) expect(kindHeight(f.kind)).toBeLessThanOrEqual(keptMin);
    // strips never count against the cap
    expect(a.sprites.filter((s) => s.strip !== null)).toHaveLength(full.sprites.filter((s) => s.strip !== null).length);
    expect(plan(map, { maxSprites: 0 }).sprites.every((s) => s.strip !== null)).toBe(true);
  });

  it('sprites=false bakes every item and still emits the strips', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const p = plan(map, { sprites: false });
    expect(p.baked).toHaveLength(map.furniture.length);
    expect(p.demoted).toBe(0);
    expect(p.sprites.length).toBeGreaterThan(0);
    expect(p.sprites.every((s) => s.strip !== null)).toBe(true);
  });

  it('Multiverse regions assign the realm theme id to frames and sprites', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const half = Math.floor(map.cols / 2);
    const p = planSprites({ map, sprites: true, maxSprites: 1500, themeIdAt: (x) => (x < half ? 'guild' : 'modern') });
    for (const s of p.sprites) {
      expect(s.themeId).toBe(s.item.x < half ? 'guild' : 'modern');
      expect(s.frame.startsWith(`${s.themeId}|`)).toBe(true);
    }
    expect(new Set([...p.frames.values()].map((f) => f.themeId))).toEqual(new Set(['guild', 'modern']));
  });

  it('equal frameKey + theme paint identical command streams (property)', () => {
    const byKey = new Map<string, PlacedFurniture[]>();
    for (const map of maps().slice(0, 80)) for (const f of map.furniture) if (spriteClassOf(f.kind) !== 'baked') byKey.set(frameKey(f), [...(byKey.get(frameKey(f)) ?? []), f]);
    let compared = 0;
    for (const items of byKey.values()) {
      if (items.length < 2) continue;
      // same key, different tile: translate the second item onto the first's tile and the streams must match
      const [a, ...rest] = items;
      for (const theme of [modernTheme, guildTheme]) {
        const ra = makeCommandGraphics();
        theme.paintFurniture(ra.g, a!, T);
        for (const b of rest.slice(0, 3)) {
          const rb = makeCommandGraphics();
          theme.paintFurniture(rb.g, b, T);
          const dx = (b.x - a!.x) * T;
          const dy = (b.y - a!.y) * T;
          expect(rb.rects).toHaveLength(ra.rects.length);
          rb.rects.forEach((r, i) => {
            const e = ra.rects[i]!;
            expect([r.x - dx, r.y - dy, r.w, r.h].map((v) => Math.round(v * 1e6))).toEqual([e.x, e.y, e.w, e.h].map((v) => Math.round(v * 1e6)));
          });
          expect(rb.commands.map((c) => c[0])).toEqual(ra.commands.map((c) => c[0]));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(50);
  }, 60_000);
});

describe('planFrameKey', () => {
  it('is the theme id plus frameKey', () => {
    const f = generateMap(DEFAULT_LAYOUT).furniture[0]!;
    expect(planFrameKey('rift', f)).toBe(`rift|${frameKey(f)}`);
  });
});
