// M17 D1: the one entry point both scenes use to draw a floor (docs/design/depth-25d.md section 3.4).
import type * as Phaser from 'phaser';
import type { GeneratedMap, Rect } from '../procgen/types';
import { renderGeneratedMap, THEME_BASE_TEXTURE, type ThemeRegion } from '../themes/renderTheme';
import type { ThemeDefinition } from '../themes/types';
import { buildFurnitureAtlas, type FurnitureAtlas } from './furnitureAtlas';
import { planSprites } from './spritePlan';
import { buildSeeThroughIndex } from './seeThrough';
import { DEPTH_EPSILON } from './tables';
import type { FrameSpec, FurnitureSprite, SeeThroughIndex, SpritePlan } from './types';

export interface RenderFloorOptions { dualGrid: boolean; sprites: boolean; maxSprites: number }
export interface FloorRender {
  /** `THEME_BASE_TEXTURE` at depth -10 (as today). */
  base: Phaser.GameObjects.Image;
  /** One per `plan.sprites` (`images[i]` shows `sprites[i]`), `setOrigin(0).setDepth(baseY - DEPTH_EPSILON)`. */
  sprites: FurnitureSprite[];
  images: Phaser.GameObjects.Image[];
  plan: SpritePlan;
  atlases: FurnitureAtlas[];
  index: SeeThroughIndex;
  /** The map geometry `SeeThroughController` reads. */
  cols: number;
  rows: number;
  tileSize: number;
  /** Destroys the images, the atlases and (when no newer render replaced it) the base texture. */
  destroy(): void;
}

let generation = 0;
/** Generation that last wrote `THEME_BASE_TEXTURE` (a stale render must not remove its successor's base). */
let baseOwner = 0;

const inRect = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/** `planSprites` -> `renderGeneratedMap(scene, map, theme, regions, { dualGrid, bakeItem })` -> one atlas per theme id -> images.
 *  Regions: an item inside a realm rect is painted by the realm's theme (same `themeAt` rule as `renderTheme.ts`). */
export function renderFloor(scene: Phaser.Scene, map: GeneratedMap, theme: ThemeDefinition, regions: ThemeRegion[], opts: RenderFloorOptions): FloorRender {
  const gen = ++generation;
  const themeAt = (x: number, y: number): ThemeDefinition => regions.find((r) => inRect(r.rect, x, y))?.theme ?? theme;
  const plan = planSprites({ map, sprites: opts.sprites, maxSprites: opts.maxSprites, themeIdAt: (x, y) => themeAt(x, y).id });
  const bakedSet = new Set(plan.baked);
  renderGeneratedMap(scene, map, theme, regions, { dualGrid: opts.dualGrid, bakeItem: (f) => bakedSet.has(f) });
  baseOwner = gen;
  const base = scene.add.image(0, 0, THEME_BASE_TEXTURE).setOrigin(0).setDepth(-10);

  const T = map.tileSize;
  const byTheme = new Map<string, FrameSpec[]>();
  for (const spec of plan.frames.values()) {
    const list = byTheme.get(spec.themeId) ?? [];
    list.push(spec);
    byTheme.set(spec.themeId, list);
  }
  const themes = new Map<string, ThemeDefinition>([[theme.id, theme], ...regions.map((r) => [r.theme.id, r.theme] as const)]);
  const atlases: FurnitureAtlas[] = [];
  const atlasOf = new Map<string, FurnitureAtlas>();
  for (const [themeId, specs] of byTheme) {
    const atlas = buildFurnitureAtlas(scene, themes.get(themeId) ?? theme, specs, T, gen);
    atlases.push(atlas);
    atlasOf.set(themeId, atlas);
  }

  const images: Phaser.GameObjects.Image[] = [];
  for (const s of plan.sprites) {
    const atlas = atlasOf.get(s.themeId);
    const tex = atlas?.textureOf(s.frame);
    if (!tex) continue; // cannot happen: every sprite's frame was planned; defensive against a partial atlas
    images.push(scene.add.image(s.x, s.y, tex, s.frame).setOrigin(0).setDepth(s.baseY - DEPTH_EPSILON));
  }
  const sprites = images.length === plan.sprites.length ? plan.sprites.slice() : plan.sprites.filter((s) => atlasOf.get(s.themeId)?.textureOf(s.frame));
  const index = buildSeeThroughIndex(sprites, map.cols, map.rows, T);
  let destroyed = false;
  return {
    base,
    sprites,
    images,
    plan,
    atlases,
    index,
    cols: map.cols,
    rows: map.rows,
    tileSize: T,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const img of images) img.destroy();
      base.destroy();
      for (const a of atlases) a.destroy();
      if (baseOwner === gen && scene.textures.exists(THEME_BASE_TEXTURE)) scene.textures.remove(THEME_BASE_TEXTURE);
    },
  };
}
