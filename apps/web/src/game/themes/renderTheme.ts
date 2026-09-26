import type * as Phaser from 'phaser';
import type { RoomType } from '@tagconn/shared';
import type { GeneratedMap, Rect } from '../procgen/types';
import type { ThemeDefinition } from './types';

/**
 * A themed sub-area of the map (the Multiverse, M8 8h): a realm's cell painted with its project's
 * own style, everything else (Nexus, void, rift corridors) painted with the base `theme` argument.
 * `rect` is in tiles. Existing single-theme callers pass no `regions` and are unaffected.
 */
export interface ThemeRegion {
  rect: Rect;
  theme: ThemeDefinition;
}

function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

/** Same small seeded PRNG as the pre-M7 `renderMap.ts`, seeded from the layout so it's reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const THEME_BASE_TEXTURE = 'theme-base';

/**
 * Paints one `GeneratedMap` into a single generated texture, per the theme's paint functions.
 * Geometry never depends on style (D2 in the design doc) — this only chooses how each tile and
 * furniture item looks. Returns the base texture key (`THEME_BASE_TEXTURE`, replacing any prior one).
 *
 * `regions` (M8 8h, the Multiverse): a tile, door, or furniture item inside a region's `rect` is
 * painted with that region's theme instead of the base `theme`; regions must not overlap. Every
 * existing single-theme caller passes none and behaves exactly as before.
 */
export function renderGeneratedMap(scene: Phaser.Scene, map: GeneratedMap, theme: ThemeDefinition, regions: ThemeRegion[] = []): string {
  // Perf note (M8 style pass): everything below - every floor/wall/furniture tile for the whole
  // floor - is drawn once into a single shared `Graphics` and baked into one `generateTexture` call
  // (`THEME_BASE_TEXTURE`), i.e. this layer is already one texture / one draw call per floor; there
  // is no per-item sprite atlas to pack here. The only actual sprite images are the handful of decor
  // textures (torches/banners/lanterns/posters, `paint/decor.ts` & `paint/riftDecor.ts`), each
  // generated once and cached by `scene.textures.exists`, then reused across every room that needs
  // it - already bounded (a handful of keys per theme) and never regenerated. Logged in dev only.
  const start = import.meta.env.DEV ? performance.now() : 0;
  const T = map.tileSize;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  const rand = mulberry32(map.seed ^ 0x9e3779b9);

  const themeAt = (x: number, y: number): ThemeDefinition => regions.find((r) => rectContains(r.rect, x, y))?.theme ?? theme;

  // A layout is uniformly `hall` or `void` (never mixed), so one pass over the tiles tells us
  // which palette key to use for uncovered (roomAt === null) floor.
  const hasVoid = map.tiles.some((row) => row.includes('void'));
  const openFloorKind: RoomType | 'corridor' = hasVoid ? 'corridor' : 'hall';
  const roomTypeById = new Map(map.rooms.map((r) => [r.id, r.type] as const));
  const kindAt = (x: number, y: number): RoomType | 'corridor' => {
    const id = map.roomAt[y]?.[x];
    return id ? (roomTypeById.get(id) ?? 'hall') : openFloorKind;
  };

  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      const tile = map.tiles[y]?.[x];
      const px = x * T;
      const py = y * T;
      if (tile === 'floor') themeAt(x, y).paintFloor(g, kindAt(x, y), px, py, rand);
      else if (tile === 'void') themeAt(x, y).paintVoid(g, px, py, rand);
      else if (tile === 'wall') {
        const below = map.tiles[y + 1]?.[x];
        themeAt(x, y).paintWall(g, px, py, below === 'floor' || below === 'door', rand);
      }
    }
  }

  // Floating islands (M8 8h, rift only): a void tile 1 or 2 rows below a region's bottom-most
  // floor/wall row gets a rock underside from the BASE theme (regions never paint their own void
  // margin — that space belongs to the Multiverse's rift, not the realm's project style).
  if (regions.length && theme.paintIslandEdge) {
    for (const region of regions) {
      const bottom = region.rect.y + region.rect.h; // first row below the region
      for (let depth = 1 as 1 | 2; depth <= 2; depth++) {
        const y = bottom + depth - 1;
        if (y < 0 || y >= map.rows) continue;
        for (let x = region.rect.x; x < region.rect.x + region.rect.w; x++) {
          if (x < 0 || x >= map.cols) continue;
          if (map.tiles[y]?.[x] !== 'void') continue;
          if (regions.some((r) => rectContains(r.rect, x, y))) continue; // inside another region: not void margin
          theme.paintIslandEdge(g, x * T, y * T, depth, rand);
        }
      }
    }
  }

  // Doors: paint the floor under them plus a themed threshold. Interior doors are drawn one tile
  // at a time (a 2-wide door is simply two adjacent thresholds); the front gate gets the special
  // 2-tile-wide portcullis treatment.
  for (const d of map.doors) {
    themeAt(d.x, d.y).paintDoor(g, roomTypeById.get(d.roomId) ?? 'hall', d.x * T, d.y * T, false, rand);
  }
  if (map.frontDoor) {
    themeAt(map.frontDoor.x, map.frontDoor.y).paintDoor(g, 'entrance', map.frontDoor.x * T - T / 2, map.frontDoor.y * T, true, rand);
  }

  for (const f of map.furniture) themeAt(f.x, f.y).paintFurniture(g, f, T);

  if (scene.textures.exists(THEME_BASE_TEXTURE)) scene.textures.remove(THEME_BASE_TEXTURE);
  g.generateTexture(THEME_BASE_TEXTURE, map.cols * T, map.rows * T);
  g.destroy();
  if (import.meta.env.DEV) {
    const ms = performance.now() - start;
    // eslint-disable-next-line no-console -- intentional one-line dev perf log, not app logging.
    console.debug(`[theme] base texture generated in ${ms.toFixed(1)}ms (${map.cols}x${map.rows} tiles, ${map.furniture.length} furniture)`);
  }
  return THEME_BASE_TEXTURE;
}
