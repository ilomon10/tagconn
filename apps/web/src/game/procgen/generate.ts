import {
  DEFAULT_LAYOUT,
  hasLayoutErrors,
  isRoomWalled,
  isZoneRoomType,
  roomInterior,
  resolveZone,
  validateLayout,
  ZONES,
  type LayoutIssue,
  type LayoutRoom,
  type OfficeLayout,
  type RoomType,
  type Zone,
} from '@tagconn/shared';
import { astarVoid, carveCorridor, findExitCandidates, type ExitCandidate } from './corridors';
import { footprintRing, findDoorSpans, SIDE_DIR, type DoorRoomShape, type DoorSpan, type Side } from './doors';
import { furnishRoom, type RecipeItem } from './recipes';
import { buildRegionAtGrid, buildRoomToRegion, findRegions, reachableFrom, regionCentroid, type Region } from './regions';
import { rngFor, randInt } from './rng';
import type {
  DecorSlot,
  Door,
  GeneratedMap,
  GeneratedRoom,
  Point,
  Rect,
  Seat,
  StairsSpot,
  TileKind,
  ZoneInfo,
} from './types';

/** Pixel size of one tile, matching the pre-M7 office map. */
export const TILE = 16;

const key = (p: Point) => `${p.x},${p.y}`;
const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function grid<T>(cols: number, rows: number, fill: T): T[][] {
  return Array.from({ length: rows }, () => new Array<T>(cols).fill(fill));
}

function rectCells(r: Rect): Point[] {
  const out: Point[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  return out;
}

function insideRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
}

/** Tiny union-find for Kruskal's MST over regions. */
class UnionFind {
  private parent: number[];
  private rank: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0) as number[];
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra]! < this.rank[rb]!) this.parent[ra] = rb;
    else if (this.rank[ra]! > this.rank[rb]!) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]!++;
    }
    return true;
  }
}

interface RoomShape {
  id: string;
  type: RoomType;
  name: string | undefined;
  footprint: Rect;
  interior: Rect;
  walled: boolean;
}

interface DoorEdge {
  kind: 'door';
  a: number;
  b: number;
  weight: number;
  span: DoorSpan;
}
interface CorridorEdge {
  kind: 'corridor';
  a: number;
  b: number;
  weight: number;
}
type Edge = DoorEdge | CorridorEdge;

/** An opened door tile plus which room it belongs to and which way it faces, before it becomes a public `Door`. */
interface OpenedDoor {
  tile: Point;
  roomId: string;
  to: string | 'hall';
  side: Side;
}

/**
 * `generateMap` (guild-hall.md section 4). Deterministic: the same layout always yields a
 * byte-identical map. Falls back to `DEFAULT_LAYOUT` (which always validates clean) when the given
 * layout has a geometry error, so the scene never crashes on a bad layout.
 */
export function generateMap(layout: OfficeLayout): GeneratedMap {
  const issues = validateLayout(layout);
  if (hasLayoutErrors(issues)) {
    const fallback = build(DEFAULT_LAYOUT);
    return { ...fallback, issues: [...issues, ...fallback.issues] };
  }
  return build(layout, issues);
}

function build(layout: OfficeLayout, baseIssues: LayoutIssue[] = []): GeneratedMap {
  const cols = layout.width;
  const rows = layout.height;
  const seed = layout.seed >>> 0;
  const issues: LayoutIssue[] = [...baseIssues];

  // --- 2. grid ------------------------------------------------------------------------------
  const tiles: TileKind[][] = grid(cols, rows, layout.background === 'hall' ? 'floor' : 'void');
  const roomAt: (string | null)[][] = grid(cols, rows, null);
  for (let x = 0; x < cols; x++) {
    tiles[0]![x] = 'wall';
    tiles[rows - 1]![x] = 'wall';
  }
  for (let y = 0; y < rows; y++) {
    tiles[y]![0] = 'wall';
    tiles[y]![cols - 1] = 'wall';
  }

  // --- 3. stamp rooms -------------------------------------------------------------------------
  const rooms: RoomShape[] = layout.rooms.map((r: LayoutRoom) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    footprint: { x: r.x, y: r.y, w: r.w, h: r.h },
    interior: roomInterior(r),
    walled: isRoomWalled(r),
  }));
  for (const room of rooms) {
    if (room.walled) {
      for (const { p } of footprintRing(room.footprint)) tiles[p.y]![p.x] = 'wall';
      // corners of the ring too (footprintRing skips them, but they are still wall).
      const { x, y, w, h } = room.footprint;
      for (const p of [{ x, y }, { x: x + w - 1, y }, { x, y: y + h - 1 }, { x: x + w - 1, y: y + h - 1 }]) {
        if (p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows) tiles[p.y]![p.x] = 'wall';
      }
      for (const p of rectCells(room.interior)) {
        tiles[p.y]![p.x] = 'floor';
        roomAt[p.y]![p.x] = room.id;
      }
    } else {
      for (const p of rectCells(room.footprint)) {
        tiles[p.y]![p.x] = 'floor';
        roomAt[p.y]![p.x] = room.id;
      }
    }
  }

  // --- 4. regions -----------------------------------------------------------------------------
  const regions: Region[] = findRegions(tiles, roomAt);
  const regionAt = buildRegionAtGrid(regions, rows, cols);
  const roomToRegion = buildRoomToRegion(regions);

  // --- 5. door candidates -----------------------------------------------------------------------
  const roomShapesForDoors: DoorRoomShape[] = rooms.map((r) => ({ id: r.id, footprint: r.footprint, walled: r.walled }));
  const doorSpans = findDoorSpans(roomShapesForDoors, tiles, regionAt);

  // --- 6. connectivity: MST + ~15% extra loops -------------------------------------------------
  const doorsRand = rngFor(seed, 'doors');
  const edges: Edge[] = doorSpans.map((span) => ({
    kind: 'door',
    a: roomToRegion.get(span.roomId) ?? -1,
    b: span.toRegionId,
    weight: 1 + doorsRand() * 0.1,
    span,
  }));

  if (layout.background === 'void') {
    const centroids = regions.map((r) => regionCentroid(r));
    const seenPairs = new Set<string>();
    for (let i = 0; i < regions.length; i++) {
      const nearest = regions
        .map((_, j) => ({ j, d: i === j ? Infinity : manhattan(centroids[i]!, centroids[j]!) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 4);
      for (const { j, d } of nearest) {
        if (d === Infinity) continue;
        const pairKey = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        edges.push({ kind: 'corridor', a: i, b: j, weight: d });
      }
    }
  }

  edges.sort((e1, e2) => e1.weight - e2.weight);
  const uf = new UnionFind(regions.length);
  // MST edges are required for connectivity; a "required" set tracks them so a failed EXTRA loop
  // edge (below) never reports a false `no-door` for two rooms that are already connected.
  const chosen: Edge[] = [];
  const required = new Set<Edge>();
  const leftover: Edge[] = [];
  for (const e of edges) {
    if (e.a < 0 || e.b < 0) continue;
    if (uf.union(e.a, e.b)) {
      chosen.push(e);
      required.add(e);
    } else {
      leftover.push(e);
    }
  }
  const extraCount = Math.round(leftover.length * 0.15);
  const extraRand = rngFor(seed, 'doors-extra');
  const pool = [...leftover];
  for (let i = 0; i < extraCount && pool.length; i++) {
    const idx = Math.floor(extraRand() * pool.length);
    chosen.push(pool.splice(idx, 1)[0]!);
  }

  // --- placement --------------------------------------------------------------------------------
  const opened: OpenedDoor[] = [];
  /** Interior tile just inside each opening (a wall door, or an open room's edge tile at a corridor mouth). */
  const entryPoints: { roomId: string; tile: Point }[] = [];
  const regionLabel = (regionId: number): string | 'hall' => {
    const region = regions[regionId];
    if (!region) return 'hall';
    if (!region.hasHall && region.roomIds.length === 1) return region.roomIds[0]!;
    return 'hall';
  };

  const placeDoorSpan = (span: DoorSpan) => {
    const width = span.positions.length >= 4 ? 2 : 1;
    const mid = Math.floor((span.positions.length - width) / 2);
    const jitterRand = rngFor(seed, `door:${span.roomId}:${span.side}`);
    const jitter = randInt(jitterRand, -1, 1);
    const start = Math.max(0, Math.min(span.positions.length - width, mid + jitter));
    const chosenPositions = span.positions.slice(start, start + width);
    const dir = SIDE_DIR[span.side];
    for (const p of chosenPositions) {
      tiles[p.y]![p.x] = 'door';
      if (span.depth === 2) {
        const outer = { x: p.x + dir.x, y: p.y + dir.y };
        if (outer.x >= 0 && outer.y >= 0 && outer.x < cols && outer.y < rows) tiles[outer.y]![outer.x] = 'door';
      }
      opened.push({ tile: p, roomId: span.roomId, to: regionLabel(span.toRegionId), side: span.side });
      entryPoints.push({ roomId: span.roomId, tile: { x: p.x - dir.x, y: p.y - dir.y } });
    }
  };

  const exitCandidatesAll = findExitCandidates(roomShapesForDoors, tiles);
  const exitsByRegion = new Map<number, ExitCandidate[]>();
  for (const ex of exitCandidatesAll) {
    const rid = roomToRegion.get(ex.roomId);
    if (rid == null) continue;
    const list = exitsByRegion.get(rid) ?? [];
    list.push(ex);
    exitsByRegion.set(rid, list);
  }

  const tryCorridor = (a: number, b: number): boolean => {
    const exitsA = exitsByRegion.get(a) ?? [];
    const exitsB = exitsByRegion.get(b) ?? [];
    if (!exitsA.length || !exitsB.length) return false;
    const pairs: { a: ExitCandidate; b: ExitCandidate; d: number }[] = [];
    for (const ea of exitsA) for (const eb of exitsB) pairs.push({ a: ea, b: eb, d: manhattan(ea.voidTile, eb.voidTile) });
    pairs.sort((p1, p2) => p1.d - p2.d);
    for (const { a: ea, b: eb } of pairs.slice(0, 4)) {
      const path = astarVoid(tiles, ea.voidTile, eb.voidTile);
      if (!path) continue;
      carveCorridor(tiles, roomAt, path, layout.corridorWidth);
      for (const ex of [ea, eb]) {
        if (ex.doorTile) {
          // A wall stood here: open it into a real door, and reserve the interior tile just inside it.
          tiles[ex.doorTile.y]![ex.doorTile.x] = 'door';
          opened.push({ tile: ex.doorTile, roomId: ex.roomId, to: 'hall', side: ex.side });
          const dir = SIDE_DIR[ex.side];
          entryPoints.push({ roomId: ex.roomId, tile: { x: ex.doorTile.x - dir.x, y: ex.doorTile.y - dir.y } });
        } else {
          // An open room's edge tile is already floor - it IS the corridor mouth, so reserve it directly.
          entryPoints.push({ roomId: ex.roomId, tile: ex.roomTile });
        }
      }
      return true;
    }
    return false;
  };

  const failedCorridorRooms = new Set<string>();
  for (const e of chosen) {
    if (e.kind === 'door') {
      placeDoorSpan(e.span);
    } else {
      const ok = tryCorridor(e.a, e.b);
      // Only a REQUIRED (MST) edge failing is a real connectivity problem; a failed EXTRA loop edge
      // just means one fewer bonus loop (the two regions are already connected some other way).
      if (!ok && required.has(e)) {
        for (const roomId of [...(regions[e.a]?.roomIds ?? []), ...(regions[e.b]?.roomIds ?? [])]) failedCorridorRooms.add(roomId);
      }
    }
  }
  for (const roomId of failedCorridorRooms) {
    issues.push({ severity: 'error', code: 'no-door', message: `No corridor could be carved to room "${roomId}".`, roomIds: [roomId] });
  }

  const walkable: number[][] = tiles.map((row) => row.map((t) => (t === 'floor' || t === 'door' ? 0 : 1)));
  const walls: boolean[][] = tiles.map((row) => row.map((t) => t === 'wall'));

  // --- 7. front gate ---------------------------------------------------------------------------
  const entranceRoom = rooms.find((r) => r.type === 'entrance');
  let frontDoor: Point | null = null;
  if (entranceRoom) {
    const e = entranceRoom.interior;
    const sides: { side: Side; touches: boolean }[] = [
      { side: 'bottom', touches: e.y + e.h === rows - 1 },
      { side: 'left', touches: e.x === 1 },
      { side: 'right', touches: e.x + e.w === cols - 1 },
      { side: 'top', touches: e.y === 1 },
    ];
    const pick = sides.find((s) => s.touches);
    if (pick) {
      switch (pick.side) {
        case 'bottom':
          frontDoor = { x: e.x + Math.floor(e.w / 2), y: rows - 1 };
          break;
        case 'left':
          frontDoor = { x: 0, y: e.y + Math.floor(e.h / 2) };
          break;
        case 'right':
          frontDoor = { x: cols - 1, y: e.y + Math.floor(e.h / 2) };
          break;
        case 'top':
          frontDoor = { x: e.x + Math.floor(e.w / 2), y: 0 };
          break;
      }
    }
  }

  // --- 8 & 9. furniture, seats, stairs ------------------------------------------------------------
  const furniture: (RecipeItem & { roomId: string; roomType: RoomType })[] = [];
  const stairs: StairsSpot[] = [];
  const generatedRooms: GeneratedRoom[] = [];

  // Door aprons: the interior tile directly inside each opening (a door, or an open room's corridor mouth).
  const apronsByRoom = new Map<string, Set<string>>();
  for (const ep of entryPoints) {
    const set = apronsByRoom.get(ep.roomId) ?? new Set<string>();
    set.add(key(ep.tile));
    apronsByRoom.set(ep.roomId, set);
  }

  for (const room of rooms) {
    const interior = room.interior;
    const reserved = apronsByRoom.get(room.id) ?? new Set<string>();

    if (room.type === 'stairs') {
      const w = interior.w;
      const startX = interior.x + Math.max(0, Math.floor((w - 2) / 2));
      // Prefer the interior's top row, but never cover a door/corridor apron (that would seal the
      // room off) - try the next row down first, so there is still a landing tile below the stairs.
      let y = interior.y;
      for (let row = interior.y; row < interior.y + interior.h - 1; row++) {
        const xs = w >= 2 ? [startX, startX + 1] : [interior.x];
        if (xs.every((x) => !reserved.has(key({ x, y: row })))) {
          y = row;
          break;
        }
      }
      const positions: { x: number; dir: 'up' | 'down' }[] =
        w >= 2 ? [{ x: startX, dir: 'up' }, { x: startX + 1, dir: 'down' }] : [{ x: interior.x, dir: 'up' }];
      for (const pos of positions) {
        if (pos.x < interior.x || pos.x >= interior.x + interior.w) continue;
        furniture.push({
          kind: pos.dir === 'up' ? 'stairs-up' : 'stairs-down',
          x: pos.x,
          y,
          w: 1,
          h: 1,
          blocking: true,
          variant: 0,
          roomId: room.id,
          roomType: room.type,
        });
        const landing = { x: pos.x, y: Math.min(interior.y + interior.h - 1, y + 1) };
        stairs.push({ x: pos.x, y, dir: pos.dir, roomId: room.id, landing });
      }
      generatedRooms.push({
        id: room.id,
        type: room.type,
        name: room.name,
        footprint: room.footprint,
        interior,
        walled: room.walled,
        seats: [],
        tiles: [],
        labelAt: { x: interior.x, y: interior.y },
      });
      continue;
    }

    if (room.type === 'hall') {
      generatedRooms.push({
        id: room.id,
        type: room.type,
        name: room.name,
        footprint: room.footprint,
        interior,
        walled: room.walled,
        seats: [],
        tiles: [],
        labelAt: { x: interior.x, y: interior.y },
      });
      continue;
    }

    const roomRand = rngFor(seed, `room:${room.id}`);
    const recipe = furnishRoom(room.type, interior, roomRand);
    const blocked = new Set<string>();
    const keptItems: (RecipeItem & { roomId: string; roomType: RoomType })[] = [];
    for (const item of recipe.furniture) {
      const cells = rectCells({ x: item.x, y: item.y, w: item.w, h: item.h });
      const fits =
        item.w > 0 &&
        item.h > 0 &&
        cells.every((c) => insideRect(c, interior) && !reserved.has(key(c)) && !blocked.has(key(c)));
      if (!fits) continue;
      keptItems.push({ ...item, roomId: room.id, roomType: room.type });
      if (item.blocking) for (const c of cells) blocked.add(key(c));
    }
    let seats: Seat[] = recipe.seats
      .filter((s) => insideRect(s, interior) && !reserved.has(key(s)) && !blocked.has(key(s)))
      .map((s) => ({ x: s.x, y: s.y, zone: isZoneRoomType(room.type) ? room.type : 'entrance', roomId: room.id, kind: s.kind }));

    // Local reachability retry (step 8): flood fill this room's interior from its door aprons,
    // discounting blocking furniture; if a seat or > 10% of the floor is unreachable, drop the last
    // blocking item and retry.
    const aprons = [...reserved].map((k) => {
      const [x, y] = k.split(',').map(Number);
      return { x: x!, y: y! };
    });
    const localReach = (blockedSet: Set<string>): Set<string> => {
      const seen = new Set<string>();
      const starts = aprons.length ? aprons : rectCells(interior).slice(0, 1);
      const queue: Point[] = [];
      for (const s of starts) {
        if (!insideRect(s, interior) || blockedSet.has(key(s))) continue;
        if (!seen.has(key(s))) {
          seen.add(key(s));
          queue.push(s);
        }
      }
      while (queue.length) {
        const p = queue.shift()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const n = { x: p.x + dx, y: p.y + dy };
          if (!insideRect(n, interior) || blockedSet.has(key(n)) || seen.has(key(n))) continue;
          seen.add(key(n));
          queue.push(n);
        }
      }
      return seen;
    };
    let guard = keptItems.length;
    while (guard-- > 0) {
      const reach = localReach(blocked);
      const totalFloor = interior.w * interior.h;
      const unreachableSeats = seats.filter((s) => !reach.has(key(s)));
      const unreachableFloor = totalFloor - reach.size;
      if (unreachableSeats.length === 0 && unreachableFloor <= totalFloor * 0.1) break;
      let lastBlockingIdx = -1;
      for (let i = keptItems.length - 1; i >= 0; i--) {
        if (keptItems[i]!.blocking) {
          lastBlockingIdx = i;
          break;
        }
      }
      if (lastBlockingIdx === -1) break;
      const removed = keptItems.splice(lastBlockingIdx, 1)[0]!;
      for (const c of rectCells({ x: removed.x, y: removed.y, w: removed.w, h: removed.h })) blocked.delete(key(c));
    }
    furniture.push(...keptItems);

    generatedRooms.push({
      id: room.id,
      type: room.type,
      name: room.name,
      footprint: room.footprint,
      interior,
      walled: room.walled,
      seats,
      tiles: [], // filled by the global verify pass below
      labelAt: { x: interior.x, y: interior.y },
    });
  }

  // Apply blocking furniture to the walkable grid.
  for (const item of furniture) {
    if (!item.blocking) continue;
    for (const c of rectCells({ x: item.x, y: item.y, w: item.w, h: item.h })) walkable[c.y]![c.x] = 1;
  }

  // --- 10. spawn ---------------------------------------------------------------------------------
  let spawn: Point = { x: Math.floor(cols / 2), y: Math.floor(rows / 2) };
  if (entranceRoom) {
    const e = entranceRoom.interior;
    const target = frontDoor ?? { x: e.x + Math.floor(e.w / 2), y: e.y + Math.floor(e.h / 2) };
    let best: Point | undefined;
    let bestDist = Infinity;
    for (const p of rectCells(e)) {
      if (walkable[p.y]?.[p.x] !== 0) continue;
      const d = manhattan(p, target);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    if (best) spawn = best;
  }

  // --- 11. verify ----------------------------------------------------------------------------------
  const reach = reachableFrom(walkable, spawn);
  for (const gr of generatedRooms) {
    if (gr.type === 'stairs' || gr.type === 'hall') continue;
    const tilesInRoom = rectCells(gr.interior).filter((p) => reach.has(key(p)));
    gr.tiles = tilesInRoom;
    if (tilesInRoom.length === 0) {
      issues.push({ severity: 'error', code: 'unreachable-room', message: `No tile in room "${gr.name ?? gr.id}" is reachable from the spawn.`, roomIds: [gr.id] });
      continue;
    }
    const reachSet = new Set(tilesInRoom.map(key));
    const before = gr.seats.length;
    gr.seats = gr.seats.filter((s) => reachSet.has(key(s)));
    if (gr.seats.length < before) {
      issues.push({ severity: 'warning', code: 'unreachable-seat', message: `Some seats in room "${gr.name ?? gr.id}" are unreachable from the spawn and were dropped.`, roomIds: [gr.id] });
    }
    if (gr.seats.length < 12) {
      const seatKeys = new Set(gr.seats.map(key));
      for (const t of tilesInRoom) {
        if (gr.seats.length >= 12) break;
        if (seatKeys.has(key(t))) continue;
        gr.seats.push({ x: t.x, y: t.y, zone: isZoneRoomType(gr.type) ? gr.type : 'entrance', roomId: gr.id, kind: 'stand' });
        seatKeys.add(key(t));
      }
    }
  }

  // --- 12. zones -------------------------------------------------------------------------------
  const presentTypes = new Set<RoomType>(rooms.map((r) => r.type));
  const zones = {} as Record<Zone, ZoneInfo>;
  for (const zone of ZONES) {
    const zoneRooms = generatedRooms.filter((r) => r.type === zone);
    if (!zoneRooms.length) continue;
    const seats = zoneRooms.flatMap((r) => r.seats);
    const tilesForZone = zoneRooms.flatMap((r) => r.tiles);
    zones[zone] = { zone, rect: zoneRooms[0]!.interior, walled: zoneRooms[0]!.walled, seats, tiles: tilesForZone };
  }
  for (const zone of ZONES) {
    if (zones[zone]) continue;
    const target = resolveZone(zone, presentTypes as ReadonlySet<RoomType>);
    zones[zone] = zones[target] ?? { zone, rect: { x: spawn.x, y: spawn.y, w: 1, h: 1 }, walled: false, seats: [], tiles: [] };
  }

  // --- 13. decor -------------------------------------------------------------------------------
  const decor: DecorSlot[] = [];
  const decorRand = rngFor(seed, 'decor');
  const wallLightCandidates: { p: Point; roomId: string | null }[] = [];
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols; x++) {
      if (tiles[y]![x] !== 'wall' || tiles[y + 1]![x] !== 'floor') continue;
      const southIsDoor = tiles[y + 1]![x] === 'door';
      if (southIsDoor) continue;
      // Skip wall tiles that are themselves doors, or immediately next to one.
      let nearDoor = tiles[y]![x] === 'door';
      for (const [dx] of [[-1], [1]] as const) if (tiles[y]?.[x + dx] === 'door') nearDoor = true;
      if (nearDoor) continue;
      wallLightCandidates.push({ p: { x, y }, roomId: roomAt[y + 1]![x] ?? null });
    }
  }
  const offset = randInt(decorRand, 0, 3);
  let placedCount = 0;
  wallLightCandidates.forEach((c, i) => {
    if ((i + offset) % 4 !== 0) return;
    decor.push({
      x: c.p.x,
      y: c.p.y,
      kind: placedCount % 2 === 0 ? 'wall-light' : 'wall-hanging',
      roomId: c.roomId,
      variant: randInt(decorRand, 0, 3),
    });
    placedCount++;
  });
  for (const gr of generatedRooms) {
    if (gr.type === 'stairs' || gr.type === 'hall') continue;
    const roomDecorRand = rngFor(seed, `decor:${gr.id}`);
    const count = randInt(roomDecorRand, 0, 2);
    const takenCells = new Set<string>();
    for (const f of furniture) if (f.roomId === gr.id) for (const c of rectCells({ x: f.x, y: f.y, w: f.w, h: f.h })) takenCells.add(key(c));
    const apron = apronsByRoom.get(gr.id) ?? new Set<string>();
    const seatCells = new Set(gr.seats.map(key));
    const free = gr.tiles.filter((t) => !takenCells.has(key(t)) && !apron.has(key(t)) && !seatCells.has(key(t)));
    for (let i = 0; i < count && free.length; i++) {
      const idx = Math.floor(roomDecorRand() * free.length);
      const t = free.splice(idx, 1)[0]!;
      decor.push({ x: t.x, y: t.y, kind: 'floor-scatter', roomId: gr.id, variant: randInt(roomDecorRand, 0, 3) });
    }
  }

  // --- doors (public shape) ----------------------------------------------------------------------
  const doors: Door[] = opened.map((d) => ({
    x: d.tile.x,
    y: d.tile.y,
    roomId: d.roomId,
    to: d.to,
    vertical: d.side === 'left' || d.side === 'right',
  }));

  const zoneAt: (Zone | null)[][] = grid(cols, rows, null);
  for (const gr of generatedRooms) {
    if (!isZoneRoomType(gr.type)) continue;
    for (const p of rectCells(gr.interior)) zoneAt[p.y]![p.x] = gr.type;
  }

  return {
    layoutId: layout.id,
    seed,
    cols,
    rows,
    tileSize: TILE,
    tiles,
    walkable,
    walls,
    roomAt,
    zoneAt,
    rooms: generatedRooms,
    zones,
    furniture,
    doors,
    stairs,
    decor,
    spawn,
    frontDoor,
    issues,
  };
}
