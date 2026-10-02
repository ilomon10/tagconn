import type { GeneratedRoom, RoomLight } from './types';

/** About one ceiling light per this many interior tiles (`hall` rooms: twice as many; `stairs`: always one). */
export const ROOM_LIGHT_TILES = 24;

const REACH_MIN = 2.5;
const REACH_MAX = 5;

function lightCount(room: Pick<GeneratedRoom, 'type' | 'interior'>): number {
  const { w, h } = room.interior;
  const area = w * h;
  if (area <= 0 || room.type === 'stairs') return area > 0 ? 1 : 0;
  return Math.max(1, Math.ceil(area / (room.type === 'hall' ? ROOM_LIGHT_TILES * 2 : ROOM_LIGHT_TILES)));
}

/**
 * One light per `ceil(area / 24)` (hall: per 48, stairs: 1), laid out on a grid that best matches the interior's aspect,
 * each at the centre of its cell. A short last row is spread over the full width. Pure and rand-free, so it cannot
 * disturb any procgen stream; reads `interior` only (lights never block).
 */
export function planRoomLights(rooms: readonly Pick<GeneratedRoom, 'id' | 'type' | 'interior'>[]): RoomLight[] {
  const out: RoomLight[] = [];
  for (const room of rooms) {
    const { x: x0, y: y0, w, h } = room.interior;
    const n = lightCount(room);
    if (n === 0) continue;
    let cols = Math.max(1, Math.min(n, w, Math.round(Math.sqrt((n * w) / h))));
    let rows = Math.ceil(n / cols);
    if (rows > h) {
      rows = h;
      cols = Math.ceil(n / h);
    }
    const reachTiles = Math.min(REACH_MAX, Math.max(REACH_MIN, Math.sqrt((w * h) / n) * 0.9));
    let placed = 0;
    for (let r = 0; r < rows; r++) {
      const inRow = Math.min(cols, n - placed);
      const y = y0 + Math.floor(((r + 0.5) * h) / rows);
      for (let i = 0; i < inRow; i++) {
        out.push({ roomId: room.id, x: x0 + Math.floor(((i + 0.5) * w) / inRow), y, reachTiles });
      }
      placed += inRow;
    }
  }
  return out;
}
