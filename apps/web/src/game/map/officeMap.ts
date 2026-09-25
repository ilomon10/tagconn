import { ZONES, type Zone } from '@tagconn/shared';

/** Framework-agnostic procedural office layout. Everything is in tile units. */

export const TILE = 16;
export const MAP_COLS = 48;
export const MAP_ROWS = 30;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FurnitureKind =
  | 'desk'
  | 'boss-desk'
  | 'table'
  | 'whiteboard'
  | 'rack'
  | 'shelf'
  | 'sofa'
  | 'armchair'
  | 'plant'
  | 'coffee'
  | 'bench'
  | 'booth'
  | 'mat'
  | 'rug';

export interface Furniture {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Blocking furniture is not walkable. Sofas, rugs and mats are. */
  blocking: boolean;
  zone: Zone;
}

export interface Seat extends Point {
  zone: Zone;
  kind: 'sit' | 'stand';
}

export interface ZoneInfo {
  zone: Zone;
  rect: Rect;
  walled: boolean;
  /** Preferred spots (chairs, standing spots), all reachable from the spawn point. */
  seats: Seat[];
  /** Every reachable walkable tile inside the zone rect (fallback when seats are full). */
  tiles: Point[];
}

export interface OfficeMap {
  cols: number;
  rows: number;
  tileSize: number;
  /** [y][x] 0 = walkable, 1 = blocked. Suitable for easystarjs. */
  walkable: number[][];
  /** [y][x] true where a wall is drawn. */
  walls: boolean[][];
  /** [y][x] zone whose floor this tile belongs to, if any. */
  zoneAt: (Zone | null)[][];
  zones: Record<Zone, ZoneInfo>;
  furniture: Furniture[];
  doors: Point[];
  /** Where characters appear and leave (just inside the front door). */
  spawn: Point;
  /** Front door tile in the outer wall (visual only). */
  frontDoor: Point;
}

export const DEFAULT_ZONE_RECTS: Record<Zone, Rect> = {
  'pm-office': { x: 1, y: 1, w: 9, h: 7 },
  'meeting-room': { x: 11, y: 1, w: 11, h: 7 },
  whiteboard: { x: 23, y: 1, w: 8, h: 7 },
  library: { x: 32, y: 1, w: 15, h: 7 },
  desks: { x: 1, y: 10, w: 27, h: 10 },
  'review-booth': { x: 30, y: 11, w: 7, h: 8 },
  'qa-lab': { x: 39, y: 11, w: 8, h: 8 },
  lounge: { x: 1, y: 22, w: 13, h: 7 },
  entrance: { x: 17, y: 22, w: 10, h: 7 },
  'server-room': { x: 31, y: 22, w: 16, h: 7 },
};

export const WALLED_ZONES: ReadonlySet<Zone> = new Set<Zone>([
  'pm-office',
  'meeting-room',
  'library',
  'review-booth',
  'qa-lab',
  'server-room',
]);

const key = (p: Point) => `${p.x},${p.y}`;

function clampRect(r: Rect, cols: number, rows: number): Rect {
  const x = Math.max(1, Math.min(cols - 3, Math.round(r.x)));
  const y = Math.max(1, Math.min(rows - 3, Math.round(r.y)));
  const w = Math.max(2, Math.min(cols - 1 - x, Math.round(r.w)));
  const h = Math.max(2, Math.min(rows - 1 - y, Math.round(r.h)));
  return { x, y, w, h };
}

function isRect(v: unknown): v is Rect {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return ['x', 'y', 'w', 'h'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]));
}

export function resolveZoneRects(overrides: Record<string, unknown> = {}, cols = MAP_COLS, rows = MAP_ROWS): Record<Zone, Rect> {
  const out = { ...DEFAULT_ZONE_RECTS };
  for (const zone of ZONES) {
    const o = overrides[zone];
    out[zone] = clampRect(isRect(o) ? o : DEFAULT_ZONE_RECTS[zone], cols, rows);
  }
  return out;
}

function grid<T>(cols: number, rows: number, fill: T): T[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill));
}

/** Furniture + seat recipes per zone. */
function furnish(zone: Zone, r: Rect): { furniture: Omit<Furniture, 'zone'>[]; seats: Omit<Seat, 'zone'>[] } {
  const f: Omit<Furniture, 'zone'>[] = [];
  const s: Omit<Seat, 'zone'>[] = [];
  const x2 = r.x + r.w - 1;
  const y2 = r.y + r.h - 1;
  const block = (kind: FurnitureKind, x: number, y: number, w = 1, h = 1) => f.push({ kind, x, y, w, h, blocking: true });
  const soft = (kind: FurnitureKind, x: number, y: number, w = 1, h = 1) => f.push({ kind, x, y, w, h, blocking: false });

  switch (zone) {
    case 'desks': {
      for (let y = r.y + 1; y + 1 <= y2; y += 3) {
        for (let x = r.x + 1; x + 1 <= x2 - 1; x += 4) {
          block('desk', x, y, 2, 1);
          s.push({ x, y: y + 1, kind: 'sit' }, { x: x + 1, y: y + 1, kind: 'sit' });
        }
      }
      break;
    }
    case 'meeting-room': {
      const tx = r.x + 2;
      const ty = r.y + 2;
      const tw = Math.max(1, r.w - 4);
      const th = Math.max(1, r.h - 4);
      block('table', tx, ty, tw, th);
      for (let x = tx; x < tx + tw; x++) s.push({ x, y: ty - 1, kind: 'sit' }, { x, y: ty + th, kind: 'sit' });
      for (let y = ty; y < ty + th; y++) s.push({ x: tx - 1, y, kind: 'sit' }, { x: tx + tw, y, kind: 'sit' });
      block('plant', r.x, r.y);
      break;
    }
    case 'whiteboard': {
      block('whiteboard', r.x + 1, r.y, Math.max(1, r.w - 2), 1);
      for (let y = r.y + 2; y <= y2; y += 2) for (let x = r.x + 1; x <= x2 - 1; x += 2) s.push({ x, y, kind: 'stand' });
      break;
    }
    case 'pm-office': {
      block('boss-desk', r.x + 2, r.y + 2, 3, 1);
      s.push({ x: r.x + 3, y: r.y + 1, kind: 'sit' });
      soft('rug', r.x + 2, r.y + 4, 4, 2);
      s.push({ x: r.x + 2, y: r.y + 4, kind: 'stand' }, { x: r.x + 4, y: r.y + 4, kind: 'stand' }, { x: r.x + 3, y: r.y + 5, kind: 'stand' });
      block('plant', x2, r.y);
      block('shelf', x2 - 2, r.y, 2, 1);
      break;
    }
    case 'library': {
      block('shelf', r.x, r.y, r.w, 1);
      const mid = r.y + 3;
      if (mid < y2) {
        const gap = r.x + Math.floor(r.w / 2);
        block('shelf', r.x + 1, mid, gap - r.x - 1, 1);
        block('shelf', gap + 2, mid, x2 - gap - 2, 1);
      }
      for (let x = r.x + 1; x <= x2; x += 2) s.push({ x, y: r.y + 1, kind: 'stand' });
      for (let x = r.x + 1; x <= x2; x += 3) s.push({ x, y: mid + 1, kind: 'stand' });
      soft('armchair', r.x + 1, y2);
      soft('armchair', x2 - 1, y2);
      s.push({ x: r.x + 1, y: y2, kind: 'sit' }, { x: x2 - 1, y: y2, kind: 'sit' });
      break;
    }
    case 'qa-lab': {
      for (let y = r.y + 1; y + 1 <= y2; y += 3) {
        block('bench', r.x + 1, y, Math.max(1, r.w - 2), 1);
        for (let x = r.x + 1; x <= x2 - 1; x += 2) s.push({ x, y: y + 1, kind: 'stand' });
      }
      break;
    }
    case 'review-booth': {
      for (let y = r.y + 1; y + 1 <= y2; y += 3) {
        block('booth', r.x + 1, y);
        s.push({ x: r.x + 1, y: y + 1, kind: 'sit' });
        if (r.w >= 5) {
          block('booth', x2 - 1, y);
          s.push({ x: x2 - 1, y: y + 1, kind: 'sit' });
        }
      }
      break;
    }
    case 'server-room': {
      for (let x = r.x + 1; x <= x2 - 1; x += 3) {
        block('rack', x, r.y + 1, 1, Math.max(1, r.h - 3));
        for (let y = r.y + 1; y <= y2 - 2; y += 2) s.push({ x: x + 1, y, kind: 'stand' });
      }
      break;
    }
    case 'lounge': {
      soft('sofa', r.x + 1, r.y + 1, 4, 1);
      for (let x = r.x + 1; x < r.x + 5; x++) s.push({ x, y: r.y + 1, kind: 'sit' });
      block('table', r.x + 2, r.y + 3, 2, 1);
      soft('armchair', r.x + 5, r.y + 3);
      s.push({ x: r.x + 5, y: r.y + 3, kind: 'sit' });
      block('coffee', x2 - 1, r.y);
      s.push({ x: x2 - 1, y: r.y + 1, kind: 'stand' }, { x: x2 - 2, y: r.y + 2, kind: 'stand' });
      block('plant', x2, y2);
      block('plant', r.x, y2);
      soft('rug', r.x + 1, r.y + 2, 5, 3);
      for (let x = r.x + 2; x <= x2 - 2; x += 2) s.push({ x, y: y2 - 1, kind: 'stand' });
      break;
    }
    case 'entrance': {
      const cx = r.x + Math.floor(r.w / 2);
      soft('mat', cx - 1, y2, 2, 1);
      block('plant', r.x, r.y);
      block('plant', x2, r.y);
      for (let y = r.y + 1; y <= y2 - 1; y += 2) for (let x = r.x + 1; x <= x2 - 1; x += 2) s.push({ x, y, kind: 'stand' });
      break;
    }
  }
  return { furniture: f, seats: s };
}

type Side = 'top' | 'bottom' | 'left' | 'right';

function doorCandidates(r: Rect, cols: number, rows: number): { side: Side; tiles: Point[]; outside: Point[] }[] {
  const cx = r.x + Math.floor((r.w - 1) / 2);
  const cy = r.y + Math.floor((r.h - 1) / 2);
  const mk = (side: Side): { side: Side; tiles: Point[]; outside: Point[] } => {
    switch (side) {
      case 'top':
        return { side, tiles: [{ x: cx, y: r.y - 1 }, { x: cx + 1, y: r.y - 1 }], outside: [{ x: cx, y: r.y - 2 }, { x: cx + 1, y: r.y - 2 }] };
      case 'bottom':
        return { side, tiles: [{ x: cx, y: r.y + r.h }, { x: cx + 1, y: r.y + r.h }], outside: [{ x: cx, y: r.y + r.h + 1 }, { x: cx + 1, y: r.y + r.h + 1 }] };
      case 'left':
        return { side, tiles: [{ x: r.x - 1, y: cy }, { x: r.x - 1, y: cy + 1 }], outside: [{ x: r.x - 2, y: cy }, { x: r.x - 2, y: cy + 1 }] };
      case 'right':
        return { side, tiles: [{ x: r.x + r.w, y: cy }, { x: r.x + r.w, y: cy + 1 }], outside: [{ x: r.x + r.w + 1, y: cy }, { x: r.x + r.w + 1, y: cy + 1 }] };
    }
  };
  const dx = cols / 2 - (r.x + r.w / 2);
  const dy = rows / 2 - (r.y + r.h / 2);
  const horiz: Side = dx >= 0 ? 'right' : 'left';
  const vert: Side = dy >= 0 ? 'bottom' : 'top';
  const order: Side[] = Math.abs(dx) > Math.abs(dy) ? [horiz, vert] : [vert, horiz];
  for (const s of ['top', 'bottom', 'left', 'right'] as const) if (!order.includes(s)) order.push(s);
  return order.map(mk);
}

/** Breadth-first flood fill over walkable tiles. */
export function reachableFrom(walkable: number[][], start: Point): Set<string> {
  const seen = new Set<string>();
  if (walkable[start.y]?.[start.x] !== 0) return seen;
  const queue: Point[] = [start];
  seen.add(key(start));
  while (queue.length) {
    const p = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (walkable[n.y]?.[n.x] !== 0) continue;
      const k = key(n);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
}

export function buildOfficeMap(zoneOverrides: Record<string, unknown> = {}): OfficeMap {
  const cols = MAP_COLS;
  const rows = MAP_ROWS;
  const rects = resolveZoneRects(zoneOverrides, cols, rows);
  const walls = grid(cols, rows, false);
  const zoneAt = grid<Zone | null>(cols, rows, null);
  const inBounds = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows;
  const isOuter = (p: Point) => p.x === 0 || p.y === 0 || p.x === cols - 1 || p.y === rows - 1;

  for (let x = 0; x < cols; x++) {
    walls[0]![x] = true;
    walls[rows - 1]![x] = true;
  }
  for (let y = 0; y < rows; y++) {
    walls[y]![0] = true;
    walls[y]![cols - 1] = true;
  }

  // Floors first (later zones win on overlap), then walls around walled rooms.
  for (const zone of ZONES) {
    const r = rects[zone];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) zoneAt[y]![x] = zone;
  }
  for (const zone of ZONES) {
    if (!WALLED_ZONES.has(zone)) continue;
    const r = rects[zone];
    for (let x = r.x - 1; x <= r.x + r.w; x++) {
      for (const y of [r.y - 1, r.y + r.h]) if (inBounds({ x, y })) walls[y]![x] = true;
    }
    for (let y = r.y - 1; y <= r.y + r.h; y++) {
      for (const x of [r.x - 1, r.x + r.w]) if (inBounds({ x, y })) walls[y]![x] = true;
    }
  }

  // Doors: first side whose outside tiles are open floor.
  const doors: Point[] = [];
  for (const zone of ZONES) {
    if (!WALLED_ZONES.has(zone)) continue;
    const r = rects[zone];
    const opensOnto = (o: Point, allowRooms: boolean) => {
      if (!inBounds(o) || walls[o.y]![o.x]) return false;
      const z = zoneAt[o.y]![o.x];
      return allowRooms || !z || !WALLED_ZONES.has(z);
    };
    const candidates = doorCandidates(r, cols, rows);
    const ok = (allowRooms: boolean) =>
      candidates.find((c) => c.tiles.every((t) => inBounds(t) && !isOuter(t)) && c.outside.every((o) => opensOnto(o, allowRooms)));
    const pick = ok(false) ?? ok(true);
    for (const t of pick?.tiles ?? []) {
      walls[t.y]![t.x] = false;
      doors.push(t);
    }
  }

  const walkable = walls.map((row) => row.map((w) => (w ? 1 : 0)));
  const furniture: Furniture[] = [];
  const rawSeats: Seat[] = [];
  for (const zone of ZONES) {
    const r = rects[zone];
    const { furniture: fs, seats } = furnish(zone, r);
    for (const item of fs) {
      // Keep furniture inside its zone rect and off walls/doors.
      const cells: Point[] = [];
      for (let y = item.y; y < item.y + item.h; y++) for (let x = item.x; x < item.x + item.w; x++) cells.push({ x, y });
      const fits =
        item.w > 0 &&
        item.h > 0 &&
        cells.every((c) => c.x >= r.x && c.y >= r.y && c.x < r.x + r.w && c.y < r.y + r.h && walkable[c.y]?.[c.x] === 0 && zoneAt[c.y]?.[c.x] === zone);
      if (!fits) continue;
      furniture.push({ ...item, zone });
      if (item.blocking) for (const c of cells) walkable[c.y]![c.x] = 1;
    }
    for (const seat of seats) rawSeats.push({ ...seat, zone });
  }

  const entrance = rects.entrance;
  const frontDoor = { x: entrance.x + Math.floor(entrance.w / 2), y: rows - 1 };
  let spawn: Point = { x: frontDoor.x, y: entrance.y + entrance.h - 1 };
  if (walkable[spawn.y]?.[spawn.x] !== 0) {
    spawn = { x: entrance.x, y: entrance.y };
    for (let y = entrance.y + entrance.h - 1; y >= entrance.y; y--) {
      const x = entrance.x + Math.floor(entrance.w / 2);
      if (walkable[y]?.[x] === 0) {
        spawn = { x, y };
        break;
      }
    }
  }
  // The front door is only drawn where the entrance touches the outer wall.
  const doorVisible = entrance.y + entrance.h === rows - 1;

  const reach = reachableFrom(walkable, spawn);
  const zones = {} as Record<Zone, ZoneInfo>;
  for (const zone of ZONES) {
    const r = rects[zone];
    const tiles: Point[] = [];
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) if (zoneAt[y]![x] === zone && reach.has(key({ x, y }))) tiles.push({ x, y });
    const seen = new Set<string>();
    let seats = rawSeats.filter((s) => {
      const k = key(s);
      if (s.zone !== zone || !reach.has(k) || zoneAt[s.y]?.[s.x] !== zone || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (seats.length === 0) seats = tiles.slice(0, 12).map((t) => ({ ...t, zone, kind: 'stand' as const }));
    zones[zone] = { zone, rect: r, walled: WALLED_ZONES.has(zone), seats, tiles };
  }

  return {
    cols,
    rows,
    tileSize: TILE,
    walkable,
    walls,
    zoneAt,
    zones,
    furniture,
    doors,
    spawn,
    frontDoor: doorVisible ? frontDoor : { x: -1, y: -1 },
  };
}
