import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import type { PlacedFurniture } from '../../procgen/types';
import { guildTheme } from '../../themes/guild';
import { modernTheme } from '../../themes/modern';
import { renderGeneratedMap, THEME_BASE_TEXTURE, type ThemeRegion } from '../../themes/renderTheme';
import type { ThemeDefinition } from '../../themes/types';
import { makeFakeScene } from '../../themes/__tests__/testUtils';
import { maxRoomsLayout, toLayout } from '../../nav/__tests__/perfLayout';
import { renderFloor } from '../renderFloor';
import { planFrameKey } from '../spritePlan';
import { ATLAS_MAX_OWN_TEXTURES, ATLAS_MAX_PAGES, DEPTH_EPSILON, spriteClassOf } from '../tables';

const OPTS = { dualGrid: true, sprites: true, maxSprites: 1500 };
const map = generateMap(DEFAULT_LAYOUT);

describe('renderFloor', () => {
  it('creates the base image plus one image per planned sprite, depth = baseY - 0.5, in lockstep with sprites', () => {
    const fake = makeFakeScene();
    const r = renderFloor(fake.scene, map, modernTheme, [], OPTS);
    expect(fake.imageCount()).toBe(1 + r.plan.sprites.length);
    expect(r.sprites).toHaveLength(r.images.length);
    expect(r.base).toBe(fake.images[0]);
    expect(r.base).toMatchObject({ depth: -10 });
    r.sprites.forEach((s, i) => {
      expect(r.images[i]).toBe(fake.images[i + 1]);
      expect((r.images[i] as unknown as { depth: number }).depth).toBe(s.baseY - DEPTH_EPSILON);
      const args = fake.imageArgs[i + 1]!;
      expect(args.slice(0, 2)).toEqual([s.x, s.y]);
      expect(args[2]).toBe(r.atlases[0]!.textureOf(s.frame));
      expect(args[3]).toBe(s.frame);
    });
    expect(r).toMatchObject({ cols: map.cols, rows: map.rows, tileSize: map.tileSize });
    expect(r.index.sprites).toBe(r.sprites);
    expect(r.atlases).toHaveLength(1);
  });

  it('bakes exactly the planned baked set into the base texture', () => {
    const painted: PlacedFurniture[] = [];
    const spy: ThemeDefinition = { ...modernTheme, paintFurniture: (g, f, T) => (painted.push(f), modernTheme.paintFurniture(g, f, T)) };
    const fake = makeFakeScene();
    const r = renderFloor(fake.scene, map, spy, [], OPTS);
    // the atlas paints one representative per frame after the base bake
    const bakedPass = painted.slice(0, r.plan.baked.length);
    expect(bakedPass).toEqual(r.plan.baked);
    expect(bakedPass.some((f) => spriteClassOf(f.kind) === 'sprite')).toBe(false);
    expect(painted.slice(r.plan.baked.length)).toEqual([...r.plan.frames.values()].map((s) => s.item));
  });

  it('sprites=false with no strips: the base bake equals the v0.10 stream', () => {
    // a map without sit-in items: strips only matter for them
    const bare = { ...map, furniture: map.furniture.filter((f) => spriteClassOf(f.kind) !== 'sit-in') };
    const a = makeFakeScene({ recordRects: true });
    renderGeneratedMap(a.scene, bare, modernTheme, [], { dualGrid: true });
    const b = makeFakeScene({ recordRects: true });
    const r = renderFloor(b.scene, bare, modernTheme, [], { ...OPTS, sprites: false });
    expect(r.images).toHaveLength(0);
    expect(r.atlases).toHaveLength(0);
    expect(b.commands).toEqual(a.commands);
  });

  it('uses one atlas per theme id on a Multiverse and the realm theme paints its items', () => {
    const rect = { x: 0, y: 0, w: Math.floor(map.cols / 2), h: map.rows };
    const regions: ThemeRegion[] = [{ rect, theme: guildTheme }];
    const fake = makeFakeScene();
    const r = renderFloor(fake.scene, map, modernTheme, regions, OPTS);
    expect(r.atlases.map((a) => a.themeId).sort()).toEqual(['guild', 'modern']);
    for (const [i, s] of r.sprites.entries()) {
      const atlas = r.atlases.find((a) => a.themeId === s.themeId)!;
      expect(fake.imageArgs[i + 1]![2]).toBe(atlas.textureOf(s.frame));
      expect(s.themeId).toBe(s.item.x < rect.w ? 'guild' : 'modern');
    }
  });

  it('a rebuild hands out new array identities and destroy removes atlases and images', () => {
    const fake = makeFakeScene();
    const a = renderFloor(fake.scene, map, modernTheme, [], OPTS);
    const b = renderFloor(fake.scene, map, modernTheme, [], OPTS);
    expect(b.sprites).not.toBe(a.sprites);
    expect(b.images).not.toBe(a.images);
    expect(a.atlases[0]!.pageKeys.some((k) => b.atlases[0]!.pageKeys.includes(k))).toBe(false);
    a.destroy();
    for (const k of a.atlases[0]!.pageKeys) expect(fake.scene.textures.exists(k)).toBe(false);
    for (const k of b.atlases[0]!.pageKeys) expect(fake.scene.textures.exists(k)).toBe(true);
    expect(a.images.every((img) => (img as unknown as { active: boolean }).active === false)).toBe(true);
    expect(b.images.every((img) => (img as unknown as { active: boolean }).active === true)).toBe(true);
    // the stale render must not take the newer base texture with it
    expect(fake.scene.textures.exists(THEME_BASE_TEXTURE)).toBe(true);
    a.destroy();
    b.destroy();
    for (const k of b.atlases[0]!.pageKeys) expect(fake.scene.textures.exists(k)).toBe(false);
    expect(fake.scene.textures.exists(THEME_BASE_TEXTURE)).toBe(false);
  });

  it('the base-texture owner is per texture manager: another game rendering never decides whose base is removed', () => {
    const f1 = makeFakeScene();
    const f2 = makeFakeScene();
    const a = renderFloor(f1.scene, map, modernTheme, [], OPTS);
    const b = renderFloor(f2.scene, map, modernTheme, [], OPTS); // a newer generation, but in the other game
    a.destroy();
    expect(f1.scene.textures.exists(THEME_BASE_TEXTURE)).toBe(false);
    expect(f2.scene.textures.exists(THEME_BASE_TEXTURE)).toBe(true);
    b.destroy();
    expect(f2.scene.textures.exists(THEME_BASE_TEXTURE)).toBe(false);
  });

  it('the maxSprites cap demotes to baked and the base bake paints them', () => {
    const fake = makeFakeScene();
    const r = renderFloor(fake.scene, map, modernTheme, [], { ...OPTS, maxSprites: 3 });
    expect(r.sprites.filter((s) => s.strip === null)).toHaveLength(3);
    expect(r.plan.demoted).toBeGreaterThan(0);
  });

  it('caps atlas pages per style on a worst-case layout: demoted items are baked, in the base bake set, and have no image', () => {
    const big = generateMap(toLayout(maxRoomsLayout(), 'cap'));
    const T = big.tileSize;
    const furniture: PlacedFurniture[] = [];
    for (const room of big.rooms) {
      for (let i = 0; i < 48; i++) {
        const size = i % 4 === 0 ? 1 : 2;
        furniture.push({ x: room.footprint.x + (i % 6) * 2, y: room.footprint.y + Math.floor(i / 6) * 2, w: size, h: size, kind: 'bookcase', blocking: true, roomId: room.id, roomType: room.type, variant: furniture.length });
      }
    }
    const painted: PlacedFurniture[] = [];
    const spy: ThemeDefinition = { ...modernTheme, paintFurniture: (g, f, t) => (painted.push(f), modernTheme.paintFurniture(g, f, t)) };
    const fake = makeFakeScene();
    const r = renderFloor(fake.scene, { ...big, furniture }, spy, [], { ...OPTS, maxSprites: 100000 });
    expect(T).toBeGreaterThan(0);
    expect(r.atlases[0]!.pageKeys.length).toBeLessThanOrEqual(ATLAS_MAX_PAGES);
    const demoted = r.atlases[0]!.demoted;
    expect(demoted.size).toBeGreaterThan(0);
    const bakedSet = new Set(r.plan.baked);
    const spriteItems = new Set(r.sprites.map((s) => s.item));
    for (const f of furniture) {
      const d = demoted.has(planFrameKey('modern', f));
      expect(bakedSet.has(f)).toBe(d);
      expect(spriteItems.has(f)).toBe(!d);
    }
    expect(r.images).toHaveLength(r.sprites.length);
    expect(fake.imageCount()).toBe(1 + r.sprites.length);
  });

  it('a painter that always overshoots makes at most ATLAS_MAX_OWN_TEXTURES own textures; the rest are baked', () => {
    const fake = makeFakeScene();
    const over: ThemeDefinition = { ...modernTheme, paintFurniture: (g, f, t) => (modernTheme.paintFurniture(g, f, t), g.fillRect(f.x * t - 40, f.y * t - 40, 4, 4)) };
    const r = renderFloor(fake.scene, map, over, [], OPTS);
    const a = r.atlases[0]!;
    const frames = [...r.plan.frames.values()];
    expect(a.demoted.size).toBeGreaterThan(0);
    const own = new Set(frames.map((f) => a.textureOf(f.key)).filter((k): k is string => !!k && !a.pageKeys.includes(k)));
    expect(own.size).toBeLessThanOrEqual(ATLAS_MAX_OWN_TEXTURES);
    for (const s of r.sprites) expect(a.demoted.has(s.strip ? s.frame.slice(0, -6) : s.frame)).toBe(false);
    for (const spec of a.demoted) expect(a.textureOf(spec)).toBeUndefined();
    expect(r.images).toHaveLength(r.sprites.length);
  });

  it('DEFAULT_LAYOUT: one page, zero own textures, nothing demoted', () => {
    const r = renderFloor(makeFakeScene().scene, map, modernTheme, [], OPTS);
    expect(r.atlases[0]!.pageKeys).toHaveLength(1);
    expect(r.atlases[0]!.demoted.size).toBe(0);
    expect(r.plan.demoted).toBe(0);
  });
});
