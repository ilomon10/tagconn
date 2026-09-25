// apps/web/src/game/multiverse/plan.ts (W6, see docs/design/living-office.md section 6.1)
//
// Pure TS, no Phaser: turns the live projects into a normal `OfficeLayout` (a central Nexus plus
// one realm per project, joined by rift corridors carved by the existing `void`-background procgen
// algorithm) that `generateMap` and `validateLayout` handle unchanged (L7 in the design doc).
import {
  MULTIVERSE_LAYOUT_ID,
  MULTIVERSE_LIMITS,
  type LayoutRoom,
  type MultiverseProjectInput,
  type MultiversePlan,
  type MultiverseRealm,
  type OfficeLayout,
  type RoomType,
  type TileRect,
} from '@tagconn/shared';
import { fnv1a } from '../procgen/rng';

export interface PlanMultiverseOptions {
  /** `office.multiverseMaxRealms`, already clamped to `MULTIVERSE_LIMITS.maxRealms` by the schema. */
  maxRealms: number;
  /** `office.floorOrder`: how the chosen realms are ordered around the Nexus (same order as the stairs). */
  floorOrder: 'created' | 'name' | 'recent';
  /** `Date.now()`-like clock, injected for deterministic tests. */
  now: number;
  /** `office.idleLeaveSec`: a realm stays for this long after its last live agent leaves. */
  idleLeaveSec: number;
}

const CELL_W = MULTIVERSE_LIMITS.cellWidth;
const CELL_H = MULTIVERSE_LIMITS.cellHeight;

// The realm template (guild-hall.md section 6.1 point 4): a 26x18 room block inset by 2 tiles on
// every side of its 30x22 cell, leaving a void margin for rift corridors and the "floating island"
// paint effect (themes/rift.ts). Widths: 8 + 10 + 8 = 26 (top row) and 13 + 13 = 26 (bottom row).
// Heights: 7 (top row) + 11 (bottom row) = 18.
const REALM_BLOCK_W = 26;
const REALM_BLOCK_H = 18;
const REALM_BLOCK_OFFSET = { x: 2, y: 2 } as const;

interface RealmRoomSpec {
  /** Room id suffix: the id is `r<realm index>-<suffix>`. */
  suffix: string;
  type: RoomType;
  x: number;
  y: number;
  w: number;
  h: number;
}

// Walled-ness follows `DEFAULT_WALLED_ROOM_TYPES` (pm-office, library, meeting-room are walled;
// desks and lounge are open), so the rooms below omit `walled` and take the shared default.
const REALM_ROOM_TEMPLATE: readonly RealmRoomSpec[] = [
  { suffix: 'pm', type: 'pm-office', x: 0, y: 0, w: 8, h: 7 },
  { suffix: 'desks', type: 'desks', x: 8, y: 0, w: 10, h: 7 },
  { suffix: 'lib', type: 'library', x: 18, y: 0, w: 8, h: 7 },
  { suffix: 'lounge', type: 'lounge', x: 0, y: 7, w: 13, h: 11 },
  { suffix: 'council', type: 'meeting-room', x: 13, y: 7, w: 13, h: 11 },
];

// The Nexus (guild-hall.md section 6.1 point 5): an entrance plaza plus a stairs landing, centred
// in the (1 or 2 cell wide) middle block of the grid.
const NEXUS_ENTRANCE = { w: 20, h: 12 };
const NEXUS_STAIRS = { w: 4, h: 4 };
const NEXUS_GAP = 2;

/** 3x3 grid (8 perimeter cells) up to 8 realms, 4x4 grid (12 perimeter cells) for 9-12. */
function gridSizeFor(realmSlots: number): number {
  return realmSlots <= 8 ? 3 : 4;
}

/**
 * Every cell of the grid's outer ring (the perimeter around the centred Nexus block), walked
 * clockwise starting at the cell(s) touching the top-centre. For a 3x3 grid this is the classic
 * "8 cells around a centre"; for 4x4 the centre is a 2x2 block and the ring is the remaining 12
 * cells — in both cases the ring is exactly the grid's outer border (`x/y === 0 or gridSize - 1`),
 * because the Nexus block is always inset by exactly one cell on every side.
 */
function perimeterCells(gridSize: number): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let x = 0; x < gridSize; x++) cells.push({ x, y: 0 });
  for (let y = 1; y < gridSize; y++) cells.push({ x: gridSize - 1, y });
  for (let x = gridSize - 2; x >= 0; x--) cells.push({ x, y: gridSize - 1 });
  for (let y = gridSize - 2; y >= 1; y--) cells.push({ x: 0, y });
  const startX = Math.floor((gridSize - 1) / 2);
  const startIdx = cells.findIndex((c) => c.x === startX && c.y === 0);
  return [...cells.slice(startIdx), ...cells.slice(0, startIdx)];
}

function cellRect(cx: number, cy: number): TileRect {
  return { x: cx * CELL_W, y: cy * CELL_H, w: CELL_W, h: CELL_H };
}

/** A project counts as "realm-worthy": it has a live agent, or had one recently (hysteresis, so a
 *  realm doesn't flicker out the instant the last agent goes idle). */
function isWorthy(p: MultiverseProjectInput, now: number, idleLeaveSec: number): boolean {
  return p.liveAgents > 0 || now - p.lastLiveAt < idleLeaveSec * 1000;
}

/** Deterministic tiebreak: never let two projects with an identical sort key swap order from one
 *  call to the next depending on incidental array order or transient activity counts. */
const byId = (a: MultiverseProjectInput, b: MultiverseProjectInput): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Which of the qualifying realms get their own realm when there are more than fit: busiest first. */
function comparePriority(a: MultiverseProjectInput, b: MultiverseProjectInput): number {
  if (b.liveAgents !== a.liveAgents) return b.liveAgents - a.liveAgents;
  if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
  return byId(a, b);
}

/** Final on-screen order (`office.floorOrder`, the same rule as the stairs), so a realm's position
 *  around the Nexus does not depend on activity — only on this stable key (plus the `id` tiebreak). */
function compareFloorOrder(order: PlanMultiverseOptions['floorOrder']) {
  return (a: MultiverseProjectInput, b: MultiverseProjectInput): number => {
    let cmp: number;
    if (order === 'created') cmp = a.createdAt - b.createdAt;
    else if (order === 'name') cmp = a.name.localeCompare(b.name);
    else cmp = b.lastActivityAt - a.lastActivityAt; // 'recent': most recently active first
    return cmp !== 0 ? cmp : byId(a, b);
  };
}

function unionRect(a: TileRect, b: TileRect): TileRect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Builds the Multiverse floor (docs/design/living-office.md section 6.1): a central Nexus plus one
 * realm per live-enough project (up to `opts.maxRealms - 1`, the rest grouped into one overflow
 * realm), joined by rift corridors. `validateLayout(plan.layout)` reports no errors for 0..40
 * projects, and every realm seat is reachable from the Nexus spawn (checked with `generateMap`,
 * which this function does not call — see `multiverse/__tests__/plan.test.ts`).
 */
export function planMultiverse(projects: readonly MultiverseProjectInput[], opts: PlanMultiverseOptions): MultiversePlan {
  const capacity = Math.max(1, Math.min(opts.maxRealms, MULTIVERSE_LIMITS.maxRealms));
  const qualifying = projects.filter((p) => isWorthy(p, opts.now, opts.idleLeaveSec));

  let kept: MultiverseProjectInput[];
  let overflow: MultiverseProjectInput[];
  if (qualifying.length <= capacity) {
    kept = qualifying;
    overflow = [];
  } else {
    const byPriority = [...qualifying].sort(comparePriority);
    kept = byPriority.slice(0, capacity - 1);
    overflow = byPriority.slice(capacity - 1);
  }

  const orderedKept = [...kept].sort(compareFloorOrder(opts.floorOrder));
  const orderedOverflow = [...overflow].sort(compareFloorOrder(opts.floorOrder));

  const realmSlots = orderedKept.length + (orderedOverflow.length > 0 ? 1 : 0);
  const gridSize = gridSizeFor(realmSlots);
  const cells = perimeterCells(gridSize);
  const nexusOrigin = 1;
  const nexusSize = gridSize - 2;
  const nexusCell: TileRect = {
    x: nexusOrigin * CELL_W,
    y: nexusOrigin * CELL_H,
    w: nexusSize * CELL_W,
    h: nexusSize * CELL_H,
  };

  const realms: MultiverseRealm[] = [];
  const realmByProject: Record<string, number> = {};

  const addRealm = (index: number, projectIds: string[], overflowRealm: boolean, name: string, style: OfficeLayout['style'] | null) => {
    const cellPos = cells[index];
    if (!cellPos) throw new Error(`planMultiverse: no grid cell for realm ${index} (${realmSlots} slots, grid ${gridSize}x${gridSize})`);
    const cell = cellRect(cellPos.x, cellPos.y);
    const blockX = cell.x + REALM_BLOCK_OFFSET.x;
    const blockY = cell.y + REALM_BLOCK_OFFSET.y;
    const realm: MultiverseRealm = {
      index,
      projectIds,
      overflow: overflowRealm,
      name,
      style: overflowRealm ? null : (style ?? null),
      cell,
      roomIds: REALM_ROOM_TEMPLATE.map((spec) => `r${index}-${spec.suffix}`),
      bannerAt: { x: blockX + Math.floor(REALM_BLOCK_W / 2), y: blockY - 1 },
    };
    realms.push(realm);
    for (const pid of projectIds) realmByProject[pid] = index;
    return { blockX, blockY };
  };

  const rooms: LayoutRoom[] = [];
  orderedKept.forEach((p, i) => {
    const { blockX, blockY } = addRealm(i, [p.id], false, p.name, p.style);
    for (const spec of REALM_ROOM_TEMPLATE) {
      rooms.push({ id: `r${i}-${spec.suffix}`, type: spec.type, x: blockX + spec.x, y: blockY + spec.y, w: spec.w, h: spec.h });
    }
  });
  if (orderedOverflow.length > 0) {
    const index = orderedKept.length;
    const { blockX, blockY } = addRealm(
      index,
      orderedOverflow.map((p) => p.id),
      true,
      `Other realms (${orderedOverflow.length})`,
      null,
    );
    for (const spec of REALM_ROOM_TEMPLATE) {
      rooms.push({ id: `r${index}-${spec.suffix}`, type: spec.type, x: blockX + spec.x, y: blockY + spec.y, w: spec.w, h: spec.h });
    }
  }

  // Nexus: an entrance plaza and a stairs landing side by side, centred in the Nexus block.
  const totalW = NEXUS_ENTRANCE.w + NEXUS_GAP + NEXUS_STAIRS.w;
  const entranceX = nexusCell.x + Math.floor((nexusCell.w - totalW) / 2);
  const entranceY = nexusCell.y + Math.floor((nexusCell.h - NEXUS_ENTRANCE.h) / 2);
  const stairsX = entranceX + NEXUS_ENTRANCE.w + NEXUS_GAP;
  const stairsY = nexusCell.y + Math.floor((nexusCell.h - NEXUS_STAIRS.h) / 2);
  const entranceRoom: LayoutRoom = { id: 'nexus-entrance', type: 'entrance', x: entranceX, y: entranceY, w: NEXUS_ENTRANCE.w, h: NEXUS_ENTRANCE.h };
  const stairsRoom: LayoutRoom = { id: 'nexus-stairs', type: 'stairs', x: stairsX, y: stairsY, w: NEXUS_STAIRS.w, h: NEXUS_STAIRS.h };
  rooms.unshift(stairsRoom);
  rooms.unshift(entranceRoom);

  const nexus = unionRect(
    { x: entranceRoom.x, y: entranceRoom.y, w: entranceRoom.w, h: entranceRoom.h },
    { x: stairsRoom.x, y: stairsRoom.y, w: stairsRoom.w, h: stairsRoom.h },
  );

  const key = realms.map((r) => `${r.projectIds.join('+')}:${r.style ?? 'rift'}`).join('|');
  const seed = fnv1a(key);

  const layout: OfficeLayout = {
    id: MULTIVERSE_LAYOUT_ID,
    name: 'The Multiverse',
    width: gridSize * CELL_W,
    height: gridSize * CELL_H,
    seed,
    background: 'void',
    corridorWidth: 2,
    rooms,
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  };

  return { key, layout, nexus, realms, realmByProject };
}
