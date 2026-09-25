import type * as Phaser from 'phaser';
import type { RoomType } from '@tagconn/shared';
import type { GeneratedMap } from '../procgen/types';
import type { ThemeDefinition } from './types';

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
 */
export function renderGeneratedMap(scene: Phaser.Scene, map: GeneratedMap, theme: ThemeDefinition): string {
  const T = map.tileSize;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  const rand = mulberry32(map.seed ^ 0x9e3779b9);

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
      if (tile === 'floor') theme.paintFloor(g, kindAt(x, y), px, py, rand);
      else if (tile === 'void') theme.paintVoid(g, px, py, rand);
      else if (tile === 'wall') {
        const below = map.tiles[y + 1]?.[x];
        theme.paintWall(g, px, py, below === 'floor' || below === 'door', rand);
      }
    }
  }

  // Doors: paint the floor under them plus a themed threshold. Interior doors are drawn one tile
  // at a time (a 2-wide door is simply two adjacent thresholds); the front gate gets the special
  // 2-tile-wide portcullis treatment.
  for (const d of map.doors) {
    theme.paintDoor(g, roomTypeById.get(d.roomId) ?? 'hall', d.x * T, d.y * T, false, rand);
  }
  if (map.frontDoor) {
    theme.paintDoor(g, 'entrance', map.frontDoor.x * T - T / 2, map.frontDoor.y * T, true, rand);
  }

  for (const f of map.furniture) theme.paintFurniture(g, f, T);

  if (scene.textures.exists(THEME_BASE_TEXTURE)) scene.textures.remove(THEME_BASE_TEXTURE);
  g.generateTexture(THEME_BASE_TEXTURE, map.cols * T, map.rows * T);
  g.destroy();
  return THEME_BASE_TEXTURE;
}
