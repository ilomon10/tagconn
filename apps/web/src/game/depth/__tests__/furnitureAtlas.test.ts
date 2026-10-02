import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import { modernTheme } from '../../themes/modern';
import type { ThemeDefinition } from '../../themes/types';
import { makeFakeScene } from '../../themes/__tests__/testUtils';
import { atlasKey, buildFurnitureAtlas } from '../furnitureAtlas';
import { packFrames } from '../pack';
import { planSprites } from '../spritePlan';
import { ATLAS_MAX_OWN_TEXTURES, FRONT_STRIP_PX, SPRITE_MARGIN, isSitInKind } from '../tables';

const T = 16;
const frames = () => {
  const map = generateMap(DEFAULT_LAYOUT);
  const plan = planSprites({ map, sprites: true, maxSprites: 1500, themeIdAt: () => 'modern' });
  return { map, plan, specs: [...plan.frames.values()] };
};

describe('buildFurnitureAtlas', () => {
  it('makes one texture per page, with frame rects from the layout and a strip frame per sit-in frame', () => {
    const { specs } = frames();
    const fake = makeFakeScene({ recordRects: true });
    const atlas = buildFurnitureAtlas(fake.scene, modernTheme, specs, T, 7);
    const layout = packFrames(specs);
    expect(atlas.pageKeys).toEqual(layout.pages.map((_p, i) => atlasKey('modern', i, 7)));
    expect(fake.generated).toEqual(layout.pages.map((p, i) => ({ key: atlas.pageKeys[i], w: p.w, h: p.h })));
    for (const spec of specs) {
      const slot = layout.frames.get(spec.key)!;
      const tex = atlas.textureOf(spec.key)!;
      expect(tex).toBe(atlas.pageKeys[slot.page]);
      expect(fake.frames.get(tex)!.get(spec.key)).toEqual({ x: slot.x, y: slot.y, w: spec.w, h: spec.h });
      const px = isSitInKind(spec.item.kind) ? FRONT_STRIP_PX[spec.item.kind][spec.item.facing ?? 's'] : 0;
      const strip = fake.frames.get(tex)!.get(`${spec.key}#strip`);
      if (px > 0) expect(strip).toEqual({ x: slot.x + SPRITE_MARGIN.side, y: slot.y + SPRITE_MARGIN.top + spec.item.h * T - px, w: spec.item.w * T, h: px });
      else expect(strip).toBeUndefined();
    }
    expect(specs.some((s) => isSitInKind(s.item.kind))).toBe(true);
  });

  it('wraps every frame in save / translateCanvas / restore and leaves the stack balanced', () => {
    const { specs } = frames();
    const fake = makeFakeScene({ recordRects: true });
    const atlas = buildFurnitureAtlas(fake.scene, modernTheme, specs, T, 1);
    const layout = packFrames(specs);
    const top: [number, number][] = [];
    let depth = 0;
    let prev: string | undefined;
    for (const [name, ...args] of fake.commands) {
      if (name === 'save') depth++;
      if (name === 'restore') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
      if (name === 'translateCanvas' && depth === 1 && prev === 'save') top.push([args[0] as number, args[1] as number]);
      prev = name;
    }
    expect(depth).toBe(0);
    const want = specs.map((s) => {
      const p = layout.frames.get(s.key)!;
      return [p.x - (s.item.x * T - SPRITE_MARGIN.side), p.y - (s.item.y * T - SPRITE_MARGIN.top)];
    });
    expect(top.sort()).toEqual(want.sort());
    atlas.destroy();
  });

  it('destroy removes the pages; a second build under a new generation never reuses a key', () => {
    const { specs } = frames();
    const fake = makeFakeScene({ recordRects: true });
    const a = buildFurnitureAtlas(fake.scene, modernTheme, specs, T, 1);
    const b = buildFurnitureAtlas(fake.scene, modernTheme, specs, T, 2);
    expect(a.pageKeys.some((k) => b.pageKeys.includes(k))).toBe(false);
    a.destroy();
    for (const k of a.pageKeys) expect(fake.scene.textures.exists(k)).toBe(false);
    for (const k of b.pageKeys) expect(fake.scene.textures.exists(k)).toBe(true);
    b.destroy();
    for (const k of b.pageKeys) expect(fake.scene.textures.exists(k)).toBe(false);
  });

  it('gives a painter that overshoots its slot a texture of its own, so it cannot bleed into a neighbour', () => {
    const { specs } = frames();
    const bad = specs.find((s) => s.item.kind === 'bookcase') ?? specs[0]!;
    const theme: ThemeDefinition = {
      ...modernTheme,
      paintFurniture: (g, f, tile) => {
        if (f === bad.item) g.fillRect(f.x * tile - 10, f.y * tile - 10, 6, 6);
        else modernTheme.paintFurniture(g, f, tile);
      },
    };
    const fake = makeFakeScene({ recordRects: true });
    const atlas = buildFurnitureAtlas(fake.scene, theme, specs, T, 3);
    const tex = atlas.textureOf(bad.key)!;
    expect(atlas.pageKeys).not.toContain(tex);
    expect(fake.generated.find((g) => g.key === tex)).toEqual({ key: tex, w: bad.w, h: bad.h });
    expect(fake.frames.get(tex)!.get(bad.key)).toEqual({ x: 0, y: 0, w: bad.w, h: bad.h });
    // the overshooting rect is not on any page
    const onPages = fake.commands.filter((c) => c[0] === 'fillRect' && c[3] === 6 && c[4] === 6);
    expect(onPages).toHaveLength(1);
    expect(atlas.textureOf(specs.find((s) => s !== bad)!.key)).not.toBe(tex);
    atlas.destroy();
    expect(fake.scene.textures.exists(tex)).toBe(false);
  });

  it('every shipped painter fits its slot for the placed DEFAULT_LAYOUT items (modern)', () => {
    const { specs } = frames();
    const fake = makeFakeScene({ recordRects: true });
    const atlas = buildFurnitureAtlas(fake.scene, modernTheme, specs, T, 4);
    expect(specs.filter((s) => !atlas.pageKeys.includes(atlas.textureOf(s.key)!))).toEqual([]);
  });

  /** Wraps `make.graphics` so a test can see which graphics were destroyed. */
  const track = (fake: ReturnType<typeof makeFakeScene>) => {
    const made: { destroyed: boolean }[] = [];
    const orig = fake.scene.make.graphics.bind(fake.scene.make);
    (fake.scene.make as unknown as { graphics: unknown }).graphics = (...a: Parameters<typeof orig>) => {
      const g = orig(...a);
      const rec = { destroyed: false };
      made.push(rec);
      const d = g.destroy.bind(g);
      g.destroy = () => ((rec.destroyed = true), d());
      return g;
    };
    return made;
  };

  it('a painter that throws leaves no Graphics and no texture behind', () => {
    const { specs } = frames();
    const fake = makeFakeScene({ recordRects: true });
    const made = track(fake);
    let n = 0;
    const theme: ThemeDefinition = {
      ...modernTheme,
      paintFurniture: (g, f, tile) => {
        if (++n === 3) throw new Error('boom');
        modernTheme.paintFurniture(g, f, tile);
      },
    };
    expect(() => buildFurnitureAtlas(fake.scene, theme, specs, T, 5)).toThrow('boom');
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((m) => m.destroyed)).toBe(true);
    expect(fake.generated).toEqual([]);
  });

  it('does not generate a page whose frames all fell back to textures of their own', () => {
    const { specs } = frames();
    const theme: ThemeDefinition = { ...modernTheme, paintFurniture: (g, f) => void g.fillRect(f.x * T - 10, f.y * T - 10, 4, 4) };
    const fake = makeFakeScene({ recordRects: true });
    const made = track(fake);
    const atlas = buildFurnitureAtlas(fake.scene, theme, specs, T, 6);
    expect(atlas.pageKeys).toEqual([]);
    expect(fake.generated.length).toBe(Math.min(specs.length, ATLAS_MAX_OWN_TEXTURES));
    expect(atlas.demoted.size).toBe(specs.length - fake.generated.length);
    expect(fake.generated.every((g) => !g.key.startsWith(atlasKey('modern', 0, 6)) || g.key.includes('-x'))).toBe(true);
    expect(made.every((m) => m.destroyed)).toBe(true);
    for (const s of specs) {
      if (atlas.demoted.has(s.key)) expect(atlas.textureOf(s.key)).toBeUndefined();
      else expect(atlas.textureOf(s.key)).toContain('-x');
    }
    atlas.destroy();
  });
});
