import {
  DEFAULT_LAYOUT,
  hasLayoutErrors,
  isRoomWalled,
  isZoneRoomType,
  roomInterior,
  resolveZone,
  validateLayout,
  ZONES,
  type DoorSpec,
  type LayoutIssue,
  type LayoutRoom,
  type OfficeLayout,
  type RoomType,
  type Zone,
} from '@tagconn/shared';
import { flagAgainstNorthWall, isEligibleForBackWall, placeAppliances, planNorthWall } from './backWall';
import { TALL_AGAINST_WALL_KINDS } from './backWallSpec';
import { astarVoid, carveCorridor, findExitCandidates, type ExitCandidate } from './corridors';
import {
  doorOffsetAndWidth,
  explicitDoorPositions,
  footprintRing,
  findDoorSpans,
  LOCAL_TO_SHARED_SIDE,
  SIDE_DIR,
  type DoorRoomShape,
  type DoorSpan,
  type Side,
} from './doors';
import { decorateRoom, furnishRoom, type FurnishOptions, type RecipeItem } from './recipes';
import { buildRegionAtGrid, buildRoomToRegion, findRegions, findVoidAreas, reachableFrom, regionCentroid, type Region } from './regions';
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
  UnreachableReason,
  UnreachableRoom,
  WallDecorSlot,
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

/**
 * An open (unwalled) room has no door apron - it merges straight into the surrounding hall/corridor
 * on every side it touches, so any perimeter cell next to outside floor is a valid entry point (M8
 * 8n: without this, the local reachability retry below fell back to a single interior corner, and a
 * denser furnish recipe that happened to block that one corner's escape route made it strip nearly
 * every item in the room instead of just the ones actually in the way).
 */
function openRoomEntryPoints(interior: Rect, tiles: readonly TileKind[][]): Point[] {
  const out: Point[] = [];
  for (const p of rectCells(interior)) {
    const onEdge = p.x === interior.x || p.x === interior.x + interior.w - 1 || p.y === interior.y || p.y === interior.y + interior.h - 1;
    if (!onEdge) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (insideRect(n, interior)) continue;
      if (tiles[n.y]?.[n.x] === 'floor') {
        out.push(p);
        break;
      }
    }
  }
  return out;
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
  /** Offset/width of the whole span this tile belongs to (every tile in a multi-wide door shares the
   *  same group offset/width, so the editor can dedupe `GeneratedMap.doors` back into one `DoorSpec`). */
  offset: number;
  width: number;
  /** false when this door came from `room.doors` (explicit) rather than the automatic generator. */
  auto: boolean;
}

/**
 * `generateMap` (guild-hall.md section 4). Deterministic: the same layout always yields a
 * byte-identical map. Falls back to `DEFAULT_LAYOUT` (which always validates clean) when the given
 * layout has a geometry error, so the scene never crashes on a bad layout.
 */
/**
 * `opts.backWall` (M8 8p, default true) is an internal knob only, never a user setting: `false`
 * reproduces the exact pre-8p output (no appliances, no `againstNorthWall` flags, no `northWall`
 * slots) and exists purely so the parity sweep in `__tests__/backWall.test.ts` can compare the two
 * (docs/design/back-wall.md section 2.5).
 */
export function generateMap(layout: OfficeLayout, opts?: { backWall?: boolean }): GeneratedMap {
  const issues = validateLayout(layout);
  if (hasLayoutErrors(issues)) {
    const fallback = build(DEFAULT_LAYOUT, [], opts);
    return { ...fallback, issues: [...issues, ...fallback.issues] };
  }
  return build(layout, issues, opts);
}

function build(layout: OfficeLayout, baseIssues: LayoutIssue[] = [], genOpts?: { backWall?: boolean }): GeneratedMap {
  const cols = layout.width;
  const rows = layout.height;
  const seed = layout.seed >>> 0;
  const issues: LayoutIssue[] = [...baseIssues];
  const backWallEnabled = genOpts?.backWall ?? true;

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
  const roomSpecById = new Map(layout.rooms.map((r) => [r.id, r]));
  const footprintById = new Map(rooms.map((r) => [r.id, r.footprint]));
  /** Rooms with `doors` set (explicit list, possibly empty = sealed) opt out of automatic doors and
   *  corridor exits entirely (guild-hall.md section 4, M8 8n): the generator never adds a door the
   *  editor didn't ask for, and never carves a corridor mouth into a wall the user meant to seal. */
  const explicitDoorRoomIds = new Set(layout.rooms.filter((r) => r.doors !== undefined).map((r) => r.id));

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
  // Explicit-door rooms are excluded here: their openings are placed by the explicit pass below,
  // never guessed by findDoorSpans/findExitCandidates.
  const roomShapesForDoors: DoorRoomShape[] = rooms.map((r) => ({ id: r.id, footprint: r.footprint, walled: r.walled }));
  const autoRoomShapes = roomShapesForDoors.filter((r) => !explicitDoorRoomIds.has(r.id));
  const doorSpans = findDoorSpans(autoRoomShapes, tiles, regionAt);

  const uf = new UnionFind(regions.length);
  const opened: OpenedDoor[] = [];
  /** Interior tile just inside each opening (a wall door, or an open room's edge tile at a corridor mouth). */
  const entryPoints: { roomId: string; tile: Point }[] = [];
  const regionLabel = (regionId: number): string | 'hall' => {
    const region = regions[regionId];
    if (!region) return 'hall';
    if (!region.hasHall && region.roomIds.length === 1) return region.roomIds[0]!;
    return 'hall';
  };

  // --- 5b. explicit doors: direct opens now (floor or double-wall neighbour), void-facing ones
  // become synthetic corridor exits below so the normal MST/corridor step carves to them. Read from
  // pristine tiles/regionAt (nothing has been opened yet), so this never races the auto candidates.
  const explicitVoidExits: ExitCandidate[] = [];
  const inBounds = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows;
  for (const roomId of explicitDoorRoomIds) {
    const room = rooms.find((r) => r.id === roomId);
    const spec = roomSpecById.get(roomId);
    if (!room || !spec?.doors?.length) continue;
    const fromRegion = roomToRegion.get(roomId);
    for (const doorSpec of spec.doors) {
      const { side, positions } = explicitDoorPositions(room.footprint, doorSpec);
      const dir = SIDE_DIR[side];
      const first = positions[0]!;
      const out1 = { x: first.x + dir.x, y: first.y + dir.y };
      const out2 = { x: first.x + dir.x * 2, y: first.y + dir.y * 2 };
      const out1Tile = inBounds(out1) ? tiles[out1.y]![out1.x] : undefined;
      const out2Tile = inBounds(out2) ? tiles[out2.y]![out2.x] : undefined;
      const { offset, width } = doorOffsetAndWidth(room.footprint, side, positions);
      if (out1Tile === 'floor') {
        const toRegion = regionAt[out1.y]?.[out1.x];
        const toRoomId = toRegion != null ? regionLabel(toRegion) : 'hall';
        for (const p of positions) {
          tiles[p.y]![p.x] = 'door';
          opened.push({ tile: p, roomId, to: toRoomId, side, offset, width, auto: false });
          entryPoints.push({ roomId, tile: { x: p.x - dir.x, y: p.y - dir.y } });
          // The neighbour's own apron too (M8 8n fix): out1 IS the neighbour's edge tile here (no wall
          // between them), so without this its own recipe was free to block its side of the doorway,
          // even though this side reserved its own.
          if (toRoomId !== 'hall') entryPoints.push({ roomId: toRoomId, tile: { x: p.x + dir.x, y: p.y + dir.y } });
        }
        if (fromRegion != null && toRegion != null) uf.union(fromRegion, toRegion);
      } else if (out1Tile === 'wall' && out2Tile === 'floor') {
        const toRegion = regionAt[out2.y]?.[out2.x];
        const toRoomId = toRegion != null ? regionLabel(toRegion) : 'hall';
        for (const p of positions) {
          tiles[p.y]![p.x] = 'door';
          const p2 = { x: p.x + dir.x, y: p.y + dir.y };
          if (inBounds(p2)) tiles[p2.y]![p2.x] = 'door';
          opened.push({ tile: p, roomId, to: toRoomId, side, offset, width, auto: false });
          entryPoints.push({ roomId, tile: { x: p.x - dir.x, y: p.y - dir.y } });
          // The neighbour's own apron (M8 8n fix, double-wall case): out2 is already one step past its
          // own wall ring, i.e. exactly its interior-side apron tile.
          if (toRoomId !== 'hall') entryPoints.push({ roomId: toRoomId, tile: { x: p.x + dir.x * 2, y: p.y + dir.y * 2 } });
        }
        if (fromRegion != null && toRegion != null) uf.union(fromRegion, toRegion);
      } else if (out1Tile === 'void') {
        // No target region yet - hand the door tile to the corridor carver below as a fixed exit.
        explicitVoidExits.push({ roomId, roomTile: first, doorTile: first, voidTile: out1, side, explicit: true });
      }
      // Anything else (out of bounds, or a wall with nothing beyond it) is a dead end: the spec asked
      // for a door there, but there is nowhere to connect it, so it stays a solid wall.
    }
  }

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
  const placeDoorSpan = (span: DoorSpan) => {
    const width = span.positions.length >= 4 ? 2 : 1;
    const mid = Math.floor((span.positions.length - width) / 2);
    const jitterRand = rngFor(seed, `door:${span.roomId}:${span.side}`);
    const jitter = randInt(jitterRand, -1, 1);
    const start = Math.max(0, Math.min(span.positions.length - width, mid + jitter));
    const chosenPositions = span.positions.slice(start, start + width);
    const dir = SIDE_DIR[span.side];
    const footprint = footprintById.get(span.roomId)!;
    const group = doorOffsetAndWidth(footprint, span.side, chosenPositions);
    for (const p of chosenPositions) {
      tiles[p.y]![p.x] = 'door';
      if (span.depth === 2) {
        const outer = { x: p.x + dir.x, y: p.y + dir.y };
        if (outer.x >= 0 && outer.y >= 0 && outer.x < cols && outer.y < rows) tiles[outer.y]![outer.x] = 'door';
      }
      opened.push({ tile: p, roomId: span.roomId, to: regionLabel(span.toRegionId), side: span.side, offset: group.offset, width: group.width, auto: true });
      entryPoints.push({ roomId: span.roomId, tile: { x: p.x - dir.x, y: p.y - dir.y } });
    }
  };

  const exitCandidatesAll = findExitCandidates(autoRoomShapes, tiles);
  const exitsByRegion = new Map<number, ExitCandidate[]>();
  for (const ex of [...exitCandidatesAll, ...explicitVoidExits]) {
    const rid = roomToRegion.get(ex.roomId);
    if (rid == null) continue;
    const list = exitsByRegion.get(rid) ?? [];
    list.push(ex);
    exitsByRegion.set(rid, list);
  }

  // Precomputed once: two exits that don't share a void area can never be joined by `astarVoid`, so
  // `tryCorridor` below can skip that (potentially expensive, and here guaranteed doomed) call
  // entirely — see `findVoidAreas`'s doc comment for why this matters for many sealed void pockets.
  const voidAreas = layout.background === 'void' ? findVoidAreas(tiles) : null;
  const voidAreaAt = (p: Point): number | null => voidAreas?.[p.y]?.[p.x] ?? null;

  const tryCorridor = (a: number, b: number): boolean => {
    const exitsA = exitsByRegion.get(a) ?? [];
    const exitsB = exitsByRegion.get(b) ?? [];
    if (!exitsA.length || !exitsB.length) return false;
    const pairs: { a: ExitCandidate; b: ExitCandidate; d: number }[] = [];
    for (const ea of exitsA) {
      for (const eb of exitsB) {
        if (voidAreas) {
          const areaA = voidAreaAt(ea.voidTile);
          const areaB = voidAreaAt(eb.voidTile);
          if (areaA === null || areaB === null || areaA !== areaB) continue;
        }
        pairs.push({ a: ea, b: eb, d: manhattan(ea.voidTile, eb.voidTile) });
      }
    }
    if (!pairs.length) return false;
    pairs.sort((p1, p2) => p1.d - p2.d);
    for (const { a: ea, b: eb } of pairs.slice(0, 4)) {
      const path = astarVoid(tiles, ea.voidTile, eb.voidTile);
      if (!path) continue;
      carveCorridor(tiles, roomAt, path, layout.corridorWidth);
      for (const ex of [ea, eb]) {
        if (ex.doorTile) {
          // A wall stood here: open it into a real door, and reserve the interior tile just inside it.
          tiles[ex.doorTile.y]![ex.doorTile.x] = 'door';
          const footprint = footprintById.get(ex.roomId);
          const group = footprint ? doorOffsetAndWidth(footprint, ex.side, [ex.doorTile]) : { offset: 0, width: 1 };
          opened.push({ tile: ex.doorTile, roomId: ex.roomId, to: 'hall', side: ex.side, offset: group.offset, width: group.width, auto: !ex.explicit });
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
  const furniture: (RecipeItem & { roomId: string; roomType: RoomType; againstNorthWall?: boolean })[] = [];
  const stairs: StairsSpot[] = [];
  const generatedRooms: GeneratedRoom[] = [];

  // Door aprons: the interior tile directly inside each opening (a door, or an open room's corridor mouth).
  const apronsByRoom = new Map<string, Set<string>>();
  // M8 8p: wall-row (interior.y - 1) columns each room's appliances/tall against-wall items occupy,
  // consumed by step 13's planNorthWall below.
  const tallColumnsByRoom = new Map<string, Set<number>>();
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

    // Furnishing knobs (M8 8n): per-room `furnish` overrides the layout-wide `furnishDefaults`,
    // which overrides these built-ins. `seed` re-rolls the room's own RNG stream without touching
    // the layout seed (RoomFurnishSchema's doc comment); `seats` has no layout-wide default (the
    // schema omits it from `furnishDefaults` on purpose - it only ever makes sense per room).
    const spec = roomSpecById.get(room.id);
    const furnish = spec?.furnish;
    const defaults = layout.furnishDefaults;
    const opts: FurnishOptions = {
      density: furnish?.density ?? defaults?.density ?? 'normal',
      decor: furnish?.decor ?? defaults?.decor ?? 0.35,
      aisle: furnish?.aisle ?? defaults?.aisle ?? 1,
      ...(furnish?.seats !== undefined && { seatsTarget: furnish.seats }),
    };
    const roomRand = rngFor(seed, furnish?.seed !== undefined ? `room:${room.id}:${furnish.seed}` : `room:${room.id}`);
    const recipe = furnishRoom(room.type, interior, roomRand, opts);
    const blocked = new Set<string>();
    const keptItems: (RecipeItem & { roomId: string; roomType: RoomType; againstNorthWall?: boolean })[] = [];
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
    const aprons = reserved.size
      ? [...reserved].map((k) => {
          const [x, y] = k.split(',').map(Number);
          return { x: x!, y: y! };
        })
      : room.walled
        ? [] // a sealed walled room: no apron, but any interior cell is as good a start as another below
        : openRoomEntryPoints(interior, tiles);
    const localReach = (blockedSet: Set<string>, starts: readonly Point[]): Set<string> => {
      const seen = new Set<string>();
      const queue: Point[] = [];
      for (const s of starts) {
        if (!insideRect(s, interior) || blockedSet.has(key(s))) continue;
        if (!seen.has(key(s))) {
          seen.add(key(s));
          queue.push(s);
        }
      }
      let head = 0;
      while (head < queue.length) {
        const p = queue[head++]!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const n = { x: p.x + dx, y: p.y + dy };
          if (!insideRect(n, interior) || blockedSet.has(key(n)) || seen.has(key(n))) continue;
          seen.add(key(n));
          queue.push(n);
        }
      }
      return seen;
    };
    const reachStarts = aprons.length ? aprons : rectCells(interior).slice(0, 1);
    const totalFloor = interior.w * interior.h;
    // M8 8p: step 8b (below) needs this room's local reach too, against the FINAL `blocked`. Captured
    // from the loop's last iteration (cheap - it's already computed here) instead of a redundant
    // extra flood fill after the loop, which showed up as a real perf.test.ts regression on a
    // 128x96/64-room map with dozens of eligible rooms.
    let lastReach: Set<string> | undefined;
    // True once a `break` below leaves `lastReach` valid for the CURRENT `blocked` (nothing changes
    // after either break). False means the loop instead ran out of `guard` right after a removal, so
    // `lastReach` reflects the state BEFORE that last removal - stale by one item (confirmed on
    // DEFAULT_LAYOUT's qa-lab: its fallback single-cell `reachStarts` sits under its own first-row
    // recipe item, so every iteration reads reach=0 until the very last item is gone, and `guard`
    // (== the room's own starting item count) runs out in the same iteration that removes it).
    let settledCleanly = false;
    let guard = keptItems.length;
    while (guard-- > 0) {
      const reach = localReach(blocked, reachStarts);
      lastReach = reach;
      const unreachableSeats = seats.filter((s) => !reach.has(key(s)));
      // The 10% tolerance is against the WALKABLE floor (interior minus blocking furniture), not the
      // whole interior (M8 8n fix): a denser recipe can legitimately cover 60-85% of the room in
      // furniture by design, and none of that occupied area is "unreachable" - it's just occupied.
      // Measuring against the whole interior made any density above ~10% coverage strip itself back
      // down to ~10% every time, defeating the point of `dense`/`packed`.
      const walkableFloor = totalFloor - blocked.size;
      const unreachableFloor = walkableFloor - reach.size;
      // A room with several doors (a throughfare between two clusters, e.g. DEFAULT_LAYOUT's qa-lab)
      // can pass the checks above from the COMBINED apron set while still walling one door's area off
      // from another's - which cuts off everything only reachable through that specific door, even
      // though this room's own tiles still look "reachable" globally (via whichever door IS on the
      // spawn side). Reachability from spawn needs every door mutually reachable from every other one.
      const firstOpenApron = aprons.find((a) => !blocked.has(key(a)));
      const reachFromOneApron = firstOpenApron ? localReach(blocked, [firstOpenApron]) : reach;
      const doorsMutuallyConnected = aprons.every((a) => blocked.has(key(a)) || reachFromOneApron.has(key(a)));
      if (unreachableSeats.length === 0 && unreachableFloor <= Math.max(1, walkableFloor) * 0.1 && doorsMutuallyConnected) {
        settledCleanly = true;
        break;
      }
      let lastBlockingIdx = -1;
      for (let i = keptItems.length - 1; i >= 0; i--) {
        if (keptItems[i]!.blocking) {
          lastBlockingIdx = i;
          break;
        }
      }
      if (lastBlockingIdx === -1) {
        settledCleanly = true;
        break;
      }
      const removed = keptItems.splice(lastBlockingIdx, 1)[0]!;
      for (const c of rectCells({ x: removed.x, y: removed.y, w: removed.w, h: removed.h })) blocked.delete(key(c));
    }

    // --- 8b. standing appliances (M8 8p, docs/design/back-wall.md section 2.3) -----------------
    const tallColumns = new Set<number>();
    // Cheap pre-check (perf.test.ts budget): most rooms in a big void-mode layout have no wall at
    // all above their top row (an open room's north side just borders void/hall), and `flagAgainstNorthWall`
    // could never flag anything there either - skip the O(furniture+seats) set-building below entirely
    // in that case instead of doing it on every eligible room only to find zero wall-backed columns.
    let anyWallBacked = false;
    for (let x = interior.x; x < interior.x + interior.w && !anyWallBacked; x++) {
      if (tiles[interior.y - 1]?.[x] === 'wall') anyWallBacked = true;
    }
    if (anyWallBacked && isEligibleForBackWall(room.type, interior, opts.decor, backWallEnabled)) {
      const finalReach = settledCleanly && lastReach ? lastReach : localReach(blocked, reachStarts);
      const occupiedCells = new Set<string>();
      for (const item of keptItems) {
        for (const c of rectCells({ x: item.x, y: item.y, w: item.w, h: item.h })) occupiedCells.add(key(c));
      }
      const seatCellsSet = new Set(seats.map(key));
      const applianceRand = rngFor(seed, furnish?.seed !== undefined ? `wall:${room.id}:${furnish.seed}` : `wall:${room.id}`);
      const appliances = placeAppliances({
        roomType: room.type,
        interior,
        density: opts.density,
        tiles,
        occupiedCells,
        blockedCells: blocked,
        seatCells: seatCellsSet,
        aprons: reserved,
        reach: finalReach,
        recipeSeatCount: seats.length,
        rand: applianceRand,
      });
      for (const item of appliances) {
        keptItems.push({ ...item, roomId: room.id, roomType: room.type });
        for (const c of rectCells({ x: item.x, y: item.y, w: item.w, h: item.h })) blocked.add(key(c));
        for (let x = item.x; x < item.x + item.w; x++) tallColumns.add(x);
      }
      flagAgainstNorthWall(keptItems, interior.y, tiles);
      for (const item of keptItems) {
        if (item.y !== interior.y || !item.againstNorthWall || !TALL_AGAINST_WALL_KINDS.has(item.kind)) continue;
        for (let x = item.x; x < item.x + item.w; x++) tallColumns.add(x);
      }
    }
    tallColumnsByRoom.set(room.id, tallColumns);
    furniture.push(...keptItems);

    // Seat target shortfall (M8 8n): "place exactly N seats when feasible, else as many as fit and
    // report a warning" - `unreachable-seat` is the closest existing issue code for a seat that
    // didn't work out.
    if (recipe.seatsShortfall && seats.length < recipe.seatsShortfall.wanted) {
      issues.push({
        severity: 'warning',
        code: 'unreachable-seat',
        message: `Only ${seats.length} of ${recipe.seatsShortfall.wanted} requested seats fit in room "${room.name ?? room.id}".`,
        roomIds: [room.id],
      });
    }

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
  let unreachableSeatsTotal = 0;
  for (const gr of generatedRooms) {
    if (gr.type === 'stairs' || gr.type === 'hall') continue;
    const tilesInRoom = rectCells(gr.interior).filter((p) => reach.has(key(p)));
    gr.tiles = tilesInRoom;
    // Seats are filtered against the global `reach` set regardless of whether the room has ANY
    // reachable tile, so `reachability.unreachableSeats` (below) counts every seat a fully sealed
    // room's recipe placed too, not just ones in a partially-blocked room.
    const beforeSeats = gr.seats.length;
    gr.seats = gr.seats.filter((s) => reach.has(key(s)));
    unreachableSeatsTotal += beforeSeats - gr.seats.length;
    if (gr.seats.length < beforeSeats) {
      issues.push({ severity: 'warning', code: 'unreachable-seat', message: `Some seats in room "${gr.name ?? gr.id}" are unreachable from the spawn and were dropped.`, roomIds: [gr.id] });
    }
    if (tilesInRoom.length === 0) {
      issues.push({ severity: 'error', code: 'unreachable-room', message: `No tile in room "${gr.name ?? gr.id}" is reachable from the spawn.`, roomIds: [gr.id] });
      continue;
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
  // M8 8p: wall tiles directly above an eligible room's interior top row are handled by
  // planNorthWall below instead of the legacy wall-light/wall-hanging loop.
  // A plain boolean grid (like `walls`/`walkable` above), not a `Set<string>` of "x,y" keys: this is
  // read once per cell of the legacy wall-decor scan below, which covers most of the map, so avoiding
  // a string allocation + hash per lookup matters for perf.test.ts's 128x96/64-room budget.
  const eligibleWallRow: boolean[][] = grid(cols, rows, false);
  for (const room of rooms) {
    const spec = roomSpecById.get(room.id);
    const decorAmount = spec?.furnish?.decor ?? layout.furnishDefaults?.decor ?? 0.35;
    if (!isEligibleForBackWall(room.type, room.interior, decorAmount, backWallEnabled)) continue;
    const wy = room.interior.y - 1;
    for (let x = room.interior.x; x < room.interior.x + room.interior.w; x++) {
      eligibleWallRow[wy]![x] = true;
    }
  }

  const decor: DecorSlot[] = [];
  const decorRand = rngFor(seed, 'decor');
  const wallLightCandidates: { p: Point; roomId: string | null }[] = [];
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols; x++) {
      if (tiles[y]![x] !== 'wall' || tiles[y + 1]![x] !== 'floor') continue;
      if (eligibleWallRow[y]![x]) continue;
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

  // M8 8p step 13: semantic north-wall decor + light slots for eligible rooms (pushed after the
  // legacy wall slots and before floor-scatter, per docs/design/back-wall.md).
  const northWall: WallDecorSlot[] = [];
  for (const gr of generatedRooms) {
    const spec = roomSpecById.get(gr.id);
    const decorAmount = spec?.furnish?.decor ?? layout.furnishDefaults?.decor ?? 0.35;
    if (!isEligibleForBackWall(gr.type, gr.interior, decorAmount, backWallEnabled)) continue;
    const wallDecorRand = rngFor(seed, `wallDecor:${gr.id}`);
    const result = planNorthWall({
      roomId: gr.id,
      roomType: gr.type,
      interior: gr.interior,
      tiles,
      tallColumns: tallColumnsByRoom.get(gr.id) ?? new Set<number>(),
      decor: decorAmount,
      rand: wallDecorRand,
    });
    northWall.push(...result.slots);
    for (const light of result.lights) {
      decor.push({ x: light.x, y: light.y, kind: 'wall-light', roomId: gr.id, variant: light.variant });
    }
  }

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
    // Density-scaled decor furniture (M8 8n): plants/rugs/lamps/crates/banners/wall-art/bins along
    // walls/corners, never blocking. Runs after the reachability retry above and only ever touches
    // `free` cells, so it can never be the thing that seals off a seat or a door apron.
    const spec = roomSpecById.get(gr.id);
    const decorAmount = spec?.furnish?.decor ?? layout.furnishDefaults?.decor ?? 0.35;
    const stillFree = free.filter((t) => !decor.some((d) => d.roomId === gr.id && d.x === t.x && d.y === t.y));
    const decorItems = decorateRoom(gr.interior, stillFree, decorAmount, roomDecorRand);
    for (const item of decorItems) furniture.push({ ...item, roomId: gr.id, roomType: gr.type });
  }

  // --- doors (public shape) ----------------------------------------------------------------------
  const doors: Door[] = opened.map((d) => ({
    x: d.tile.x,
    y: d.tile.y,
    roomId: d.roomId,
    to: d.to,
    vertical: d.side === 'left' || d.side === 'right',
    side: LOCAL_TO_SHARED_SIDE[d.side],
    offset: d.offset,
    width: d.width,
    auto: d.auto,
  }));

  const zoneAt: (Zone | null)[][] = grid(cols, rows, null);
  for (const gr of generatedRooms) {
    if (!isZoneRoomType(gr.type)) continue;
    for (const p of rectCells(gr.interior)) zoneAt[p.y]![p.x] = gr.type;
  }

  // --- reachability report (M8 8n) ---------------------------------------------------------------
  // "verify every room reachable" (the user's accessibility ask): explain *why* each unreachable
  // room can't be reached, and suggest a door that would fix it.
  const suggestDoor = (room: RoomShape): DoorSpec | undefined => {
    const candidates: { side: Side; touches: boolean }[] = [
      { side: 'bottom', touches: room.footprint.y + room.footprint.h < rows },
      { side: 'left', touches: room.footprint.x > 0 },
      { side: 'right', touches: room.footprint.x + room.footprint.w < cols },
      { side: 'top', touches: room.footprint.y > 0 },
    ];
    const len = (side: Side) => (side === 'top' || side === 'bottom' ? room.footprint.w : room.footprint.h);
    for (const c of candidates) {
      if (!c.touches) continue;
      const sideLen = len(c.side);
      if (sideLen < 3) continue; // no valid non-corner offset for a 1-wide door
      const offset = Math.max(1, Math.floor(sideLen / 2));
      if (offset > sideLen - 2) continue;
      const dir = SIDE_DIR[c.side];
      const first = c.side === 'top' || c.side === 'bottom'
        ? { x: room.footprint.x + offset, y: c.side === 'top' ? room.footprint.y : room.footprint.y + room.footprint.h - 1 }
        : { x: c.side === 'left' ? room.footprint.x : room.footprint.x + room.footprint.w - 1, y: room.footprint.y + offset };
      const out = { x: first.x + dir.x, y: first.y + dir.y };
      if (!inBounds(out)) continue;
      const outTile = tiles[out.y]![out.x];
      if (outTile === 'wall' && (room.walled === false)) continue; // nowhere to open into
      return { side: LOCAL_TO_SHARED_SIDE[c.side], offset, width: 1 };
    }
    return undefined;
  };

  const unreachableRooms: UnreachableRoom[] = [];
  for (const gr of generatedRooms) {
    if (gr.type === 'stairs' || gr.type === 'hall') continue;
    if (gr.tiles.length > 0) continue;
    const spec = roomSpecById.get(gr.id);
    const roomShape = rooms.find((r) => r.id === gr.id)!;
    let reason: UnreachableReason;
    if (spec?.doors !== undefined && spec.doors.length === 0) {
      reason = 'sealed';
    } else if ((apronsByRoom.get(gr.id)?.size ?? 0) === 0) {
      reason = 'no-corridor';
    } else {
      reason = 'blocked-by-furniture';
    }
    const suggestion = suggestDoor(roomShape);
    unreachableRooms.push({ roomId: gr.id, reason, ...(suggestion && { suggestion }) });
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
    northWall,
    spawn,
    frontDoor,
    issues,
    reachability: { unreachableRooms, unreachableSeats: unreachableSeatsTotal },
  };
}
