// L2 test helpers: ASCII maps as `GeneratedMap`s and `SunState` literals (sun.ts is L1's; these pin the values the tests need).
import type { FurnitureKind, GeneratedMap, PlacedFurniture, Rect } from '../../procgen/types';
import { tilesFrom } from '../../themes/dual/__tests__/fixtures';
import type { LightmapLight, SunState } from '../types';

export const T = 16;

/** `#` wall, `.` floor, `D` door, space void. One room `r1` over `room` (default: the whole map's floor bounding box). */
export function mapFrom(
  rows: string[],
  opts: { furniture?: PlacedFurniture[]; room?: Rect; northWall?: GeneratedMap['northWall']; lights?: GeneratedMap['lights'] } = {},
): GeneratedMap {
  const room = opts.room ?? { x: 1, y: 1, w: Math.max(1, (rows[0]?.length ?? 3) - 2), h: Math.max(1, rows.length - 2) };
  const base = tilesFrom(rows, [{ id: 'r1', type: 'desks', rect: room }]);
  return {
    ...base,
    layoutId: 'test',
    seed: 1,
    tileSize: T,
    furniture: opts.furniture ?? [],
    northWall: opts.northWall ?? [],
    decor: [],
    lights: opts.lights,
  } as unknown as GeneratedMap;
}

export function furn(kind: FurnitureKind | string, x: number, y: number, w = 1, h = 1): PlacedFurniture {
  return { kind, x, y, w, h, blocking: true, roomId: 'r1', roomType: 'desks', variant: 0 } as PlacedFurniture;
}

/** A walled room of `w x h` floor tiles with a wall ring (so `(w + 2) x (h + 2)` tiles). */
export function walledRows(w: number, h: number, door?: { x: number; y: number }): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h + 2; y++) {
    let row = '';
    for (let x = 0; x < w + 2; x++) row += x === 0 || y === 0 || x === w + 1 || y === h + 1 ? '#' : '.';
    rows.push(row);
  }
  if (door) rows[door.y] = rows[door.y]!.slice(0, door.x) + 'D' + rows[door.y]!.slice(door.x + 1);
  return rows;
}

const base: SunState = { hour: 12, phase: 'day', daylight: 1, elevation: 1, skew: 0, moon: 0, ambient: 1, tint: 0xffffff };
export const NOON: SunState = base;
export const MORNING: SunState = { ...base, hour: 8, daylight: 1, elevation: 0.5, skew: -0.5 };
export const EVENING: SunState = { ...base, hour: 17, daylight: 1, elevation: 0.5, skew: 0.5 };
export const NIGHT: SunState = { hour: 1, phase: 'night', daylight: 0, elevation: 0, skew: 0, moon: 1, ambient: 0.35, tint: 0x3a4a80 };

export function light(over: Partial<LightmapLight> = {}): LightmapLight {
  return { x: 3.5 * T, y: 3.5 * T, kind: 'ambient-fill', color: 0xffffff, reach: 5 * T, strength: 1, flicker: false, roomId: 'r1', ...over };
}

/** The regionThemeAt stub: the colours only need `id` and `lighting`. */
export const theme = { id: 'modern' as const, lighting: { dayTint: 0xffffff, nightTint: 0x1a2040, nightAlpha: 0.5, glowAtNight: true } };
