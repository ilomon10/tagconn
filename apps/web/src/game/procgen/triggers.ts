// apps/web/src/game/procgen/triggers.ts  (M12 G3/G4, docs/design/game-office.md section 5.3)
//
// Trigger guarantee: after the room loop, mark exactly one item per panel action (board, log, quests,
// settings, heroes, receptionist) as the floor's trigger, placing a missing one in the entrance or a lounge
// when it can do so without cutting anything off. Mutates `furniture` and `tallColumnsByRoom`; pure otherwise.
import type { RoomType } from '@tagconn/shared';
import { TRIGGER_KINDS, TRIGGER_ORDER, TRIGGER_PLACE } from '../furnitureTriggers';
import type { RecipeItem } from './recipes';
import { rngFor } from './rng';
import type { FurnitureAction, GeneratedRoom, Point, Rect, TileKind } from './types';

type TriggerItem = RecipeItem & {
  roomId: string;
  roomType: RoomType;
  againstNorthWall?: boolean;
  pinned?: true;
  trigger?: FurnitureAction;
};

export interface TriggerPassInput {
  rooms: readonly GeneratedRoom[]; // seats already final for the room loop
  furniture: TriggerItem[]; // mutated: trigger marks + new items
  tiles: readonly TileKind[][];
  apronsByRoom: ReadonlyMap<string, ReadonlySet<string>>;
  tallColumnsByRoom: Map<string, Set<number>>; // mutated: columns of new wall-standing items
  seed: number;
}

/** A missing reception desk (see assignTriggers). */
const RECEPTION_PLACE = { kind: 'reception-desk', w: 3 } as const;

const key = (p: Point) => `${p.x},${p.y}`;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const cellsOf = (r: Rect): string[] => {
  const out: string[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push(`${x},${y}`);
  return out;
};

/** Interior cells reachable from `starts` without crossing `blocked` (4-neighbour). */
function reachFrom(interior: Rect, blocked: ReadonlySet<string>, starts: readonly Point[]): Set<string> {
  const inside = (p: Point) => p.x >= interior.x && p.x < interior.x + interior.w && p.y >= interior.y && p.y < interior.y + interior.h;
  const seen = new Set<string>();
  const queue: Point[] = [];
  for (const s of starts) {
    if (!inside(s) || blocked.has(key(s)) || seen.has(key(s))) continue;
    seen.add(key(s));
    queue.push(s);
  }
  let head = 0;
  while (head < queue.length) {
    const p = queue[head++]!;
    for (const [dx, dy] of DIRS) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (!inside(n) || blocked.has(key(n)) || seen.has(key(n))) continue;
      seen.add(key(n));
      queue.push(n);
    }
  }
  return seen;
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

const byLowestYThenX = (a: Rect, b: Rect) => a.y - b.y || a.x - b.x;

/** Marks / places one trigger item per action. See the file header and design 5.3. */
export function assignTriggers(input: TriggerPassInput): void {
  const { rooms, furniture, tiles, apronsByRoom, tallColumnsByRoom } = input;
  const rand = rngFor(input.seed, 'triggers');
  const entranceIds = new Set(rooms.filter((r) => r.type === 'entrance').map((r) => r.id));
  const loungeIds = new Set(rooms.filter((r) => r.type === 'lounge').map((r) => r.id));
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  // Candidate rooms for a new item: the entrance(s) first, then each lounge by id.
  const placeRooms = [
    ...rooms.filter((r) => r.type === 'entrance').sort((a, b) => a.id.localeCompare(b.id)),
    ...rooms.filter((r) => r.type === 'lounge').sort((a, b) => a.id.localeCompare(b.id)),
  ];

  for (const action of TRIGGER_ORDER) {
    const kinds = TRIGGER_KINDS[action];
    // 1. An existing item of a qualifying kind: entrance, else a lounge, else anywhere (lowest y, then x).
    const existing = furniture.filter((f) => kinds.includes(f.kind));
    if (existing.length) {
      const rank = (f: TriggerItem) => (entranceIds.has(f.roomId) ? 0 : loungeIds.has(f.roomId) ? 1 : 2);
      existing.sort((a, b) => rank(a) - rank(b) || byLowestYThenX(a, b));
      existing[0]!.trigger = action;
      continue;
    }

    // 2. Place the missing kind where it cannot split the room. The design says the reception desk is never
    // placed, but ~45% of generated entrances lose theirs to a door apron on the top row, which would break the
    // "all six actions" guarantee, so it is placed (entrance only) like the others.
    const spec = action === 'receptionist' ? RECEPTION_PLACE : TRIGGER_PLACE[action];
    for (const room of action === 'receptionist' ? placeRooms.filter((r) => r.type === 'entrance') : placeRooms) {
      if (placeIn(room, action, spec.kind, spec.w)) break;
    }
    // 3. Nothing fits: no trigger for this action (the menu still works).
  }

  function placeIn(room: GeneratedRoom, action: FurnitureAction, kind: TriggerItem['kind'], wanted: 1 | 2 | 3): boolean {
    const interior = room.interior;
    if (interior.w < 1 || interior.h < 1) return false;
    const aprons = apronsByRoom.get(room.id) ?? new Set<string>();
    const mine = furniture.filter((f) => f.roomId === room.id);
    const occupied = new Set<string>();
    const blocked = new Set<string>();
    for (const f of mine) {
      for (const c of cellsOf(f)) {
        occupied.add(c);
        if (f.blocking) blocked.add(c);
      }
    }
    const seatCells = new Set(roomById.get(room.id)!.seats.map(key));
    const nearApron = (p: Point) => aprons.has(key(p)) || DIRS.some(([dx, dy]) => aprons.has(key({ x: p.x + dx, y: p.y + dy })));
    // Reachability from the first open apron (or, with none, the interior cells that touch outside floor).
    const starts: Point[] = [];
    for (const a of aprons) {
      const [x, y] = a.split(',').map(Number);
      if (!blocked.has(a)) {
        starts.push({ x: x!, y: y! });
        break;
      }
    }
    if (!starts.length) {
      for (let y = interior.y; y < interior.y + interior.h; y++) {
        for (let x = interior.x; x < interior.x + interior.w; x++) {
          const edge = x === interior.x || x === interior.x + interior.w - 1 || y === interior.y || y === interior.y + interior.h - 1;
          if (!edge || blocked.has(`${x},${y}`)) continue;
          const open = DIRS.some(([dx, dy]) => {
            const t = tiles[y + dy]?.[x + dx];
            const outside = x + dx < interior.x || x + dx >= interior.x + interior.w || y + dy < interior.y || y + dy >= interior.y + interior.h;
            return outside && (t === 'floor' || t === 'door');
          });
          if (open) starts.push({ x, y });
        }
      }
    }
    if (!starts.length) return false;
    const baseReach = reachFrom(interior, blocked, starts);

    const valid = (x: number, y: number, w: number, northWall: boolean): boolean => {
      if (x < interior.x || x + w > interior.x + interior.w) return false;
      const cells = cellsOf({ x, y, w, h: 1 });
      for (let cx = x; cx < x + w; cx++) {
        const p = { x: cx, y };
        if (occupied.has(key(p)) || seatCells.has(key(p)) || nearApron(p)) return false;
        if (northWall && tiles[y - 1]?.[cx] !== 'wall') return false;
      }
      if (northWall) {
        const front = { x, y: y + 1 };
        if (blocked.has(key(front)) || aprons.has(key(front))) return false;
      }
      // No split: every cell that could be reached before still can be (bar the item's own cells).
      const after = new Set(blocked);
      for (const c of cells) after.add(c);
      const reach = reachFrom(interior, after, starts);
      for (const c of baseReach) if (!reach.has(c) && !cells.includes(c)) return false;
      return true;
    };

    const topRow: Point[] = [];
    const edge: Point[] = [];
    for (let y = interior.y; y < interior.y + interior.h; y++) {
      for (let x = interior.x; x < interior.x + interior.w; x++) {
        if (y === interior.y) topRow.push({ x, y });
        else if (x === interior.x || x === interior.x + interior.w - 1 || y === interior.y + interior.h - 1) edge.push({ x, y });
        else continue;
      }
    }
    // Edge cells of the top row too (e.g. open rooms without a wall behind them).
    const anyEdge = [...topRow, ...edge];
    shuffle(topRow, rand);
    shuffle(anyEdge, rand);

    const widths = Array.from({ length: wanted }, (_, i) => wanted - i);
    for (const w of widths) {
      const spots: { p: Point; northWall: boolean }[] = [
        ...topRow.map((p) => ({ p, northWall: true })),
        ...anyEdge.map((p) => ({ p, northWall: false })),
      ];
      for (const { p, northWall } of spots) {
        if (!valid(p.x, p.y, w, northWall)) continue;
        let wallBacked = p.y === interior.y;
        for (let cx = p.x; cx < p.x + w; cx++) if (tiles[p.y - 1]?.[cx] !== 'wall') wallBacked = false;
        const item: TriggerItem = {
          kind,
          x: p.x,
          y: p.y,
          w,
          h: 1,
          blocking: true,
          variant: Math.floor(rand() * 4),
          roomId: room.id,
          roomType: room.type,
          trigger: action,
          ...(wallBacked && { againstNorthWall: true }),
        };
        furniture.push(item);
        if (wallBacked) {
          const cols = tallColumnsByRoom.get(room.id) ?? new Set<number>();
          for (let x = p.x; x < p.x + w; x++) cols.add(x);
          tallColumnsByRoom.set(room.id, cols);
        }
        return true;
      }
    }
    return false;
  }
}
