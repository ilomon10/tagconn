// apps/web/src/game/procgen/harmony.ts  (M16 F1, docs/design/furnishing.md sections 2-4)
//
// The harmony model: furniture GROUPS (a desk with its chairs, a sofa with its coffee table, rug and lamp),
// per-room PLANS (which groups a room type wants), a half-cell OccupancyGrid, candidate placement, scoring and
// "best of K". Pure TS, no Phaser. Groups, affinities and facings are keyed by kind / room type, never by a
// theme (D2). `recipes.ts` calls `bestCandidate` from `furnishRoom` when it is given a `FurnishContext`.
import { LAYOUT_LIMITS, type Facing, type FurnishDensity, type RoomType } from '@tagconn/shared';
import { coveredTileRect } from './geometry';
import { facingSupported, frontStrip } from './facingSpec';
import { KIND_BLOCKING } from './pins';
import { fnv1a, mulberry32 } from './rng';
import type { FurnishContext, RecipeItem, RecipeSeat } from './recipes';
import type { FurnitureKind, Point, Rect } from './types';

// ---------------------------------------------------------------------------------------------------------------
// Constants

/** Half-gap pitches (navigation.md T8): at `normal` density, 2+ wide row items sit half a tile closer (pitch `w + 0.5`
 *  instead of `w + 1`). Tiles stay conservatively blocked, so reachability is unchanged. Toggle off if property 5 fails. */
export const HALF_GAPS = true;
/** Security (threat check #10): `MAX_GROUP_INSTANCES = maxSeatsPerRoom` bounds a numeric repeat. A `fill` repeat is bounded by
 *  `MAX_FILL_INSTANCES` (8x): a dense 28x18 desks room legitimately holds ~80 desks (the old recipe held ~60, more at
 *  `packed`), so a literal 64 cut the bottom rows off and broke the coverage bands. Total plan size is also capped
 *  (`MAX_PLAN_SLOTS`), so generation work stays linear in the interior. */
export const MAX_GROUP_INSTANCES = LAYOUT_LIMITS.maxSeatsPerRoom;
export const MAX_FILL_INSTANCES = MAX_GROUP_INSTANCES * 8;
/** Slot ordinals must fit `SLOT_ID_RE` (`\d{1,3}`): a plan never has more than this many member slots. */
export const MAX_PLAN_SLOTS = 1000;
/** Draws reserved per candidate so candidate j always starts at the same offset of the room stream. */
export const CANDIDATE_DRAWS = 64;
export const SCORE_WEIGHTS = { reach: 0.35, clearance: 0.25, density: 0.2, alignment: 0.1, symmetry: 0.1 } as const;
/** Blocking coverage of the interior each density aims for (scoring only; the row plans decide the real number). */
export const DENSITY_TARGET: Record<FurnishDensity, number> = { sparse: 0.18, normal: 0.3, dense: 0.45, packed: 0.6 };
/** A candidate at or above this total ends the search early (the stream still advances `CANDIDATE_DRAWS` per candidate). */
export const GOOD_ENOUGH_SCORE = 0.95;
export const CANDIDATES: Record<FurnishDensity, number> = { sparse: 3, normal: 4, dense: 5, packed: 6 };

/**
 * Row-fill plan per density: `stack` rows are packed back-to-back sharing a single `aisle` gap after the whole
 * stack, `colGap` is the gap left between items along a row (M8 8n; see the long comment this moved from).
 */
export const DENSITY_PLAN: Record<FurnishDensity, { stack: number; colGap: number }> = {
  sparse: { stack: 1, colGap: 1 },
  normal: { stack: 2, colGap: 1 },
  dense: { stack: 4, colGap: 0 },
  packed: { stack: 10, colGap: 0 },
};

// ---------------------------------------------------------------------------------------------------------------
// Row fill (moved from recipes.ts; `halfGap` is the only addition)

export interface RowSlot {
  x: number;
  y: number;
  atStart: boolean;
  atEnd: boolean;
}

/**
 * Generic row filler (guild-hall.md section 4 step 8): tiles `itemW x itemH` blocking items left-to-right across `r`,
 * `stack` rows deep before the next `aisle` gap, one full-height "spine" column always left free, and a 1-tile inset
 * when there is room (a door can open onto any point of a wall). `halfGap` closes the column gap by half a tile.
 */
export function fillRows(rOuter: Rect, itemW: number, itemH: number, aisle: number, density: FurnishDensity, halfGap = false): RowSlot[] {
  const canInset = rOuter.w > itemW + 2 && rOuter.h > itemH + 2;
  const r: Rect = canInset ? { x: rOuter.x + 1, y: rOuter.y + 1, w: rOuter.w - 2, h: rOuter.h - 2 } : rOuter;
  const { stack, colGap } = DENSITY_PLAN[density];
  const colPitch = itemW + (halfGap && density === 'normal' && itemW >= 2 ? 0.5 : colGap);
  const stackHeight = itemH * stack;
  const rowPitch = stackHeight + aisle;
  const spineX = r.x + Math.max(0, r.w - 1); // reserved full-height gap, never covered by an item
  const out: RowSlot[] = [];
  for (let y = r.y; y + itemH <= r.y + r.h; y += rowPitch) {
    const rowsInStack = Math.min(stack, Math.floor((r.y + r.h - y) / itemH));
    for (let x = r.x; x + itemW <= r.x + r.w; x += colPitch) {
      if (x < spineX + 1 && x + itemW > spineX) continue; // would cover the spine
      for (let s = 0; s < rowsInStack; s++) {
        out.push({ x, y: y + itemH * s, atStart: s === 0, atEnd: s === rowsInStack - 1 });
      }
    }
  }
  return out;
}

/** Collapses a stack of 1-tall `fillRows` slots at the same column back into one tall rect (a server room's rack-row). */
export function mergeStacks(positions: readonly RowSlot[]): { x: number; y: number; h: number }[] {
  const groups: { x: number; y: number; h: number }[] = [];
  let current: { x: number; y: number; h: number } | null = null;
  for (const p of positions) {
    if (p.atStart) current = { x: p.x, y: p.y, h: 1 };
    else if (current) current.h++;
    if (p.atEnd && current) {
      groups.push(current);
      current = null;
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------------------------
// Groups

export type Affinity = 'wall' | 'corner' | 'centre' | 'any';

export interface GroupMember {
  kind: FurnitureKind;
  /** Canonical (south-facing) size, halves allowed. */
  w: number;
  h: number;
  /** Offset from the anchor's top-left, local frame (facing `s`). */
  dx: number;
  dy: number;
  /** Local facing; rotated with the group. */
  facing?: Facing;
  anchor?: true;
  /** Dropped (not an error) when it does not fit. */
  optional?: true;
  /** Try the mirror image across the anchor (the chair on the other side of its desk) when the first spot is taken. */
  mirror?: true;
  /** Seats this member offers, as tile offsets from the member's top-left AFTER rotation (only used by non-rotatable
   *  groups). `[]` = none; omitted = `seatsFor` rules (with the opposite side as a fallback when the front is blocked). */
  seats?: readonly { dx: number; dy: number; kind: 'sit' | 'stand' }[];
}

/** What a template needs to size itself: the room and which row slot / instance it is. */
export interface MemberCtx {
  interior: Rect;
  density: FurnishDensity;
  aisle: number;
  /** Instance index within its group id. */
  index: number;
  /** Merged stack height for `merge` groups. */
  slotH?: number;
}

export interface GroupTemplate {
  /** Kebab id: the `<group>` of a slot id. */
  id: string;
  members: readonly GroupMember[] | ((c: MemberCtx) => readonly GroupMember[]);
  affinity: Affinity;
  /** Free tiles required in front of the anchor's facing side (the walkway; chairs inside the group may sit in it). */
  clearance: number;
  /** May face e/w/n (the group is rotated); a non-rotatable group only ever faces `s` (its art is one-sided). */
  rotatable: boolean;
  /** Restricts the facings a rotatable group may take (default: all four). */
  facings?: readonly Facing[];
  /** `fill` = one per row slot (`any` affinity), a number = exactly that many (if they fit), a function of density. */
  repeat: 'fill' | number | ((d: FurnishDensity) => number);
  /** Placement order (higher first); slot ordinals follow plan order, not weight. */
  weight: number;
  /** `fill` rows are laid out in this sub-rect of the interior (null = none). */
  region?: (r: Rect) => Rect | null;
  /** `fill` rows: the anchor is a merged stack (a rack-row as tall as the stack). */
  merge?: true;
  minW?: number;
  minH?: number;
  minDensity?: FurnishDensity;
}

const m = (kind: FurnitureKind, w: number, h: number, dx: number, dy: number, extra: Partial<GroupMember> = {}): GroupMember => ({
  kind,
  w,
  h,
  dx,
  dy,
  ...extra,
});
const anchor = (kind: FurnitureKind, w: number, h: number, extra: Partial<GroupMember> = {}): GroupMember =>
  m(kind, w, h, 0, 0, { anchor: true, ...extra });
const chairAt = (dx: number, dy: number, facing: Facing = 'n'): GroupMember =>
  m('chair', 1, 1, dx, dy, { facing, mirror: true, seats: [{ dx: 0, dy: 0, kind: 'sit' }] });

/** The meeting group: a table sized to the room (guild-hall.md 8n: the margin is a fraction of the shorter side) plus a
 *  chair on the ring tiles (every other one on a very long ring; every ring tile still seats through the table). */
const MEETING_MARGIN: Record<FurnishDensity, number> = { sparse: 0.24, normal: 0.16, dense: 0.1, packed: 0.04 };
function meetingMembers(c: MemberCtx): GroupMember[] {
  const { interior: r, density } = c;
  const margin = Math.max(1, Math.round(Math.min(r.w, r.h) * MEETING_MARGIN[density]));
  const tw = Math.max(1, r.w - margin * 2);
  const th = Math.max(1, r.h - margin * 2);
  const out: GroupMember[] = [anchor('table', tw, th)];
  const step = 2 * (tw + th) > 24 ? 2 : 1;
  for (let x = 0; x < tw; x += step) {
    out.push(m('chair', 1, 1, x, -1, { facing: 's', seats: [] }), m('chair', 1, 1, x, th, { facing: 'n', seats: [] }));
  }
  for (let y = 0; y < th; y += step) {
    out.push(m('chair', 1, 1, -1, y, { facing: 'e', seats: [] }), m('chair', 1, 1, tw, y, { facing: 'w', seats: [] }));
  }
  return out;
}

const sofaWidth = (r: Rect): number => Math.max(2, Math.min(4, r.w - 2));

/** The group templates. Offsets are in the local frame facing `s`; see furnishing.md section 2.1. */
export const GROUPS: Record<string, GroupTemplate> = {
  desk: {
    id: 'desk',
    members: [anchor('work-desk', 2, 1, { seats: [] }), chairAt(0, 1), chairAt(1, 1)],
    affinity: 'any',
    clearance: 0,
    rotatable: false,
    repeat: 'fill',
    weight: 10,
  },
  // PM office: the lead's team sits below the meeting corner, as the old recipe did.
  'desk-team': {
    id: 'desk-team',
    members: [anchor('work-desk', 2, 1, { seats: [] }), chairAt(0, 1), chairAt(1, 1)],
    affinity: 'any',
    clearance: 0,
    rotatable: false,
    repeat: 'fill',
    weight: 10,
    region: (r) => (r.h > 7 ? { x: r.x, y: r.y + 7, w: r.w, h: r.h - 7 } : null),
  },
  lead: {
    id: 'lead',
    members: [
      anchor('lead-desk', 3, 1, { seats: [] }),
      chairAt(1, 1),
      m('rug', 4, 2, 0, 2, { seats: [{ dx: 0, dy: 0, kind: 'stand' }, { dx: 2, dy: 0, kind: 'stand' }, { dx: 1, dy: 1, kind: 'stand' }] }),
    ],
    affinity: 'centre',
    clearance: 0,
    rotatable: false,
    repeat: 1,
    weight: 90,
    minW: 6,
    minH: 6,
  },
  meeting: {
    id: 'meeting',
    members: meetingMembers,
    affinity: 'centre',
    clearance: 0,
    rotatable: false,
    repeat: 1,
    weight: 95,
  },
  board: {
    id: 'board',
    members: (c) => [anchor('board', Math.max(1, Math.min(3, c.interior.w - 2)), 1, { seats: [] })],
    affinity: 'wall',
    clearance: 1,
    rotatable: true,
    repeat: 1,
    weight: 80,
  },
  'board-wide': {
    id: 'board-wide',
    members: (c) => [anchor('board', Math.max(1, c.interior.w - 2), 1, { seats: [] })],
    affinity: 'wall',
    clearance: 0,
    rotatable: true,
    facings: ['s'],
    repeat: 1,
    weight: 80,
  },
  'standing-row': {
    id: 'standing-row',
    members: [anchor('standing-table', 2, 1)],
    affinity: 'any',
    clearance: 0,
    rotatable: false,
    repeat: 'fill',
    weight: 10,
    region: (r) => ({ x: r.x + 1, y: r.y + 2, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) }),
  },
  'sofa-set': {
    id: 'sofa-set',
    members: (c) => {
      const w = sofaWidth(c.interior);
      return [
        anchor('sofa', w, 1),
        m('table', 2, 1, 0.5, 1.5),
        m('rug', w + 1, 3, -0.5, 0.5),
        m('lamp', 1, 1, w, 0, { optional: true }),
      ];
    },
    affinity: 'wall',
    clearance: 0,
    rotatable: true,
    facings: ['s'],
    repeat: 1,
    weight: 70,
    minW: 5,
  },
  'armchair-nook': {
    id: 'armchair-nook',
    members: [anchor('armchair', 1, 1), m('lamp', 1, 1, 1, 0, { optional: true })],
    affinity: 'corner',
    clearance: 0,
    rotatable: true,
    repeat: 1,
    weight: 40,
  },
  counter: {
    id: 'counter',
    members: (c) => [anchor('counter', Math.max(1, Math.min(3, c.interior.w - 4)), 1)],
    affinity: 'wall',
    clearance: 1,
    rotatable: true,
    repeat: 1,
    weight: 60,
  },
  amenity: {
    id: 'amenity',
    members: (c) => {
      // The first slots host the life amenities (M13 W1-10), by slot index; later slots stay plain tables.
      const kind = LOUNGE_SLOT_KINDS[c.index] ?? 'table';
      return [anchor(kind, kind === 'arcade' ? 1 : 2, 1)];
    },
    affinity: 'any',
    clearance: 0,
    rotatable: false,
    repeat: 'fill',
    weight: 10,
    region: (r) => (r.h > 5 ? { x: r.x, y: r.y + 4, w: r.w, h: r.h - 4 } : null),
  },
  'shelf-row': {
    id: 'shelf-row',
    members: (c) => [anchor('shelf-stack', Math.min(c.interior.w, 3), 1)],
    affinity: 'any',
    clearance: 0,
    rotatable: false,
    repeat: 'fill',
    weight: 10,
  },
  reading: {
    id: 'reading',
    members: [anchor('reading-table', 2, 1, { seats: [] }), chairAt(0, 1), chairAt(1, 1)],
    affinity: 'centre',
    clearance: 0,
    rotatable: false,
    repeat: 1,
    weight: 50,
    minW: 5,
    minH: 4,
  },
  'bench-row': {
    id: 'bench-row',
    members: (c) => [anchor(c.density === 'sparse' ? 'workbench' : 'lab-bench', Math.max(1, c.interior.w - 2), 1)],
    affinity: 'any',
    clearance: 0,
    rotatable: false,
    repeat: 'fill',
    weight: 10,
  },
  equipment: {
    id: 'equipment',
    members: [anchor('equipment', 2, 2)],
    affinity: 'corner',
    clearance: 0,
    rotatable: false,
    repeat: 1,
    weight: 40,
    minW: 5,
    minH: 5,
  },
  'booth-row': {
    id: 'booth-row',
    members: [anchor('booth', 1, 1)],
    affinity: 'any',
    clearance: 0,
    rotatable: false,
    repeat: 'fill',
    weight: 10,
  },
  'chair-corner': {
    id: 'chair-corner',
    members: [anchor('chair', 1, 1, { seats: [] })],
    affinity: 'corner',
    clearance: 0,
    rotatable: true,
    repeat: 1,
    weight: 5,
    minDensity: 'normal',
  },
  'rack-row': {
    id: 'rack-row',
    members: (c) => [anchor('rack-row', 1, c.slotH ?? 1)],
    affinity: 'any',
    clearance: 0,
    rotatable: false,
    repeat: 'fill',
    weight: 10,
    merge: true,
  },
  console: {
    id: 'console',
    members: [anchor('console', 1, 1, { seats: [{ dx: -1, dy: 0, kind: 'sit' }] })],
    affinity: 'corner',
    clearance: 0,
    rotatable: false,
    repeat: 1,
    weight: 40,
  },
  'sigil-corner': {
    id: 'sigil-corner',
    members: [anchor('sigil', 1, 1, { seats: [] })],
    affinity: 'corner',
    clearance: 0,
    rotatable: false,
    repeat: 1,
    weight: 5,
    minW: 5,
    minH: 5,
  },
  reception: {
    id: 'reception',
    members: (c) => [anchor('reception-desk', Math.max(1, Math.min(3, c.interior.w - 2)), 1, { seats: [] }), chairAt(0, 1)],
    affinity: 'wall',
    clearance: 0,
    rotatable: false,
    repeat: 1,
    weight: 85,
  },
  'mat-door': {
    id: 'mat-door',
    members: [anchor('mat', 2, 1)],
    affinity: 'wall',
    clearance: 0,
    rotatable: true,
    facings: ['n'],
    repeat: 1,
    weight: 30,
  },
  'bench-row-entrance': {
    id: 'bench-row-entrance',
    members: [anchor('bench', 2, 1)],
    affinity: 'any',
    clearance: 0,
    rotatable: false,
    repeat: 'fill',
    weight: 10,
    region: (r) => ({ x: r.x, y: r.y + 2, w: r.w, h: Math.max(0, r.h - 3) }),
  },
  'cabinet-corner': {
    id: 'cabinet-corner',
    members: [anchor('cabinet', 1, 1)],
    affinity: 'corner',
    clearance: 0,
    rotatable: true,
    repeat: 1,
    weight: 40,
  },
  'shelf-wall': {
    id: 'shelf-wall',
    members: [anchor('shelf', 1, 1)],
    affinity: 'wall',
    clearance: 0,
    rotatable: true,
    facings: ['s'],
    repeat: 1,
    weight: 40,
  },
  'plant-corner': {
    id: 'plant-corner',
    members: [anchor('plant', 1, 1)],
    affinity: 'corner',
    clearance: 0,
    rotatable: true,
    repeat: 1,
    weight: 5,
  },
  'plant-corner-extra': {
    id: 'plant-corner-extra',
    members: [anchor('plant', 1, 1)],
    affinity: 'corner',
    clearance: 0,
    rotatable: true,
    repeat: 1,
    weight: 5,
    minDensity: 'normal',
  },
};

/** Lounge extra-row slot kinds by placed-slot index; later slots stay plain tables. */
const LOUNGE_SLOT_KINDS: readonly FurnitureKind[] = ['ping-pong', 'board-game-table', 'foosball', 'arcade'];

/** Group ids per room type, in plan (= slot ordinal) order. A group id may repeat (a second instance). */
export const ROOM_PLANS: Record<RoomType, readonly string[]> = {
  desks: ['desk'],
  'meeting-room': ['meeting', 'board', 'plant-corner', 'plant-corner-extra'],
  whiteboard: ['board-wide', 'standing-row'],
  'pm-office': ['lead', 'cabinet-corner', 'shelf-wall', 'plant-corner', 'desk-team'],
  library: ['shelf-row', 'reading', 'armchair-nook', 'armchair-nook'],
  'qa-lab': ['bench-row', 'equipment'],
  'review-booth': ['booth-row', 'chair-corner'],
  'server-room': ['rack-row', 'console', 'sigil-corner'],
  lounge: ['sofa-set', 'counter', 'amenity', 'armchair-nook', 'plant-corner', 'plant-corner'],
  entrance: ['reception', 'mat-door', 'plant-corner', 'plant-corner', 'bench-row-entrance'],
  stairs: [],
  hall: [],
};

const groupOf = (id: string): GroupTemplate | undefined => (Object.hasOwn(GROUPS, id) ? GROUPS[id] : undefined);
const planOf = (type: RoomType): readonly string[] => (Object.hasOwn(ROOM_PLANS, type) ? ROOM_PLANS[type] : []);
const blockingCache = new Map<string, boolean>();
/** Own-property guarded `KIND_BLOCKING` lookup (a stored kind like `constructor` never blocks); memoised, it is hot. */
export const isBlockingKind = (kind: string): boolean => {
  let v = blockingCache.get(kind);
  if (v === undefined) {
    v = Object.hasOwn(KIND_BLOCKING, kind) && KIND_BLOCKING[kind as FurnitureKind];
    blockingCache.set(kind, v);
  }
  return v;
};

const FACING_ORDER: readonly Facing[] = ['n', 'e', 's', 'w'];
const rotateFacing = (f: Facing, steps: number): Facing => FACING_ORDER[(FACING_ORDER.indexOf(f) + steps + 4) % 4] ?? 's';
export const oppositeFacing = (f: Facing): Facing => rotateFacing(f, 2);

const staticMembers = (t: GroupTemplate, c?: MemberCtx): readonly GroupMember[] =>
  typeof t.members === 'function' ? (c ? t.members(c) : []) : t.members;

/**
 * Rotates a group's members to face `facing` (offsets stay relative to the rotated anchor's top-left; footprints and
 * member facings rotate with it). `members` defaults to a static template's own; pass the resolved list for a sized one.
 */
export function rotateGroup(t: GroupTemplate, facing: Facing, members: readonly GroupMember[] = staticMembers(t)): GroupMember[] {
  if (facing === 's') return members as GroupMember[]; // read-only for every caller
  const minX = Math.min(...members.map((mem) => mem.dx));
  const minY = Math.min(...members.map((mem) => mem.dy));
  const bw = Math.max(...members.map((mem) => mem.dx + mem.w)) - minX;
  const bh = Math.max(...members.map((mem) => mem.dy + mem.h)) - minY;
  const steps = (FACING_ORDER.indexOf(facing) - 2 + 4) % 4; // s -> facing, in quarter turns
  const rects = members.map((mem) => {
    const x = mem.dx - minX;
    const y = mem.dy - minY;
    if (facing === 'n') return { x: bw - x - mem.w, y: bh - y - mem.h, w: mem.w, h: mem.h };
    if (facing === 'e') return { x: y, y: bw - x - mem.w, w: mem.h, h: mem.w };
    return { x: bh - y - mem.h, y: x, w: mem.h, h: mem.w };
  });
  const ai = Math.max(0, members.findIndex((mem) => mem.anchor));
  const ar = rects[ai]!;
  return members.map((mem, i) => {
    const r = rects[i]!;
    const out: GroupMember = { ...mem, w: r.w, h: r.h, dx: r.x - ar.x, dy: r.y - ar.y };
    if (mem.facing) out.facing = rotateFacing(mem.facing, steps);
    return out;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Occupancy grid

export const CELL_FREE = 0;
export const CELL_BLOCKING = 1;
export const CELL_SOFT = 2;
export const CELL_RESERVED = 3;

/**
 * Half-tile occupancy over the interior (cells = `2w x 2h`): free / blocking / soft / reserved, plus the id of the group
 * instance that wrote each cell (0 = nobody: aprons and pins). A group may overlap its OWN cells (a rug under its table,
 * chairs in its own clearance strip); nothing may overlap another owner's. Out of the interior counts as occupied.
 */
export class OccupancyGrid {
  readonly cw: number;
  readonly ch: number;
  readonly cells: Uint8Array;
  readonly owner: Uint16Array;
  /** Conservative tile mask kept in step with blocking writes (row-major over the interior). */
  private readonly tiles: Uint8Array;
  private readonly tw: number;
  constructor(readonly interior: Rect) {
    this.cw = Math.round(interior.w * 2);
    this.ch = Math.round(interior.h * 2);
    this.cells = new Uint8Array(this.cw * this.ch);
    this.owner = new Uint16Array(this.cw * this.ch);
    this.tw = Math.round(interior.w);
    this.tiles = new Uint8Array(this.tw * Math.round(interior.h));
  }
  private span(r: Rect): { x0: number; y0: number; x1: number; y1: number } | null {
    const x0 = Math.round((r.x - this.interior.x) * 2);
    const y0 = Math.round((r.y - this.interior.y) * 2);
    const x1 = Math.round((r.x + r.w - this.interior.x) * 2);
    const y1 = Math.round((r.y + r.h - this.interior.y) * 2);
    if (x0 < 0 || y0 < 0 || x1 > this.cw || y1 > this.ch || x1 <= x0 || y1 <= y0) return null;
    return { x0, y0, x1, y1 };
  }
  inside(r: Rect): boolean {
    return this.span(r) !== null;
  }
  /** Whether `r` is inside the interior and every cell is free or owned by `owner` (a non-zero id). */
  canPlace(r: Rect, owner: number): boolean {
    const s = this.span(r);
    if (!s) return false;
    for (let y = s.y0; y < s.y1; y++) {
      for (let x = s.x0; x < s.x1; x++) {
        const i = y * this.cw + x;
        if (this.cells[i] !== CELL_FREE && (owner === 0 || this.owner[i] !== owner)) return false;
      }
    }
    return true;
  }
  /** Writes `type` over `r`. A blocking write wins over soft/reserved; nothing else overwrites a non-free cell. */
  mark(r: Rect, type: number, owner: number): void {
    const s = this.span(r);
    if (!s) return;
    for (let y = s.y0; y < s.y1; y++) {
      for (let x = s.x0; x < s.x1; x++) {
        const i = y * this.cw + x;
        if (this.cells[i] === CELL_FREE || (type === CELL_BLOCKING && this.cells[i] !== CELL_BLOCKING)) {
          this.cells[i] = type;
          this.owner[i] = owner;
          if (type === CELL_BLOCKING) this.tiles[(y >> 1) * this.tw + (x >> 1)] = 1;
        }
      }
    }
  }
  /** Conservative tile test (invariant 4): a tile with any blocking cell is blocked. Tile coords are absolute; outside = blocked. */
  tileBlocked(tx: number, ty: number): boolean {
    const x = tx - this.interior.x;
    const y = ty - this.interior.y;
    if (x < 0 || y < 0 || x >= this.tw || y * this.tw + x >= this.tiles.length) return true;
    return this.tiles[y * this.tw + x] === 1;
  }
  /** Tile-level blocked mask (row-major over the interior); a copy. */
  tileMask(): Uint8Array {
    return this.tiles.slice();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Seats

/**
 * The seats a single item of `kind` at `rect` offers inside `interior` (M12 G4: pinned furniture brings its own seats).
 * Desks, booths and reading tables seat their FRONT row (the row below for `s`, above for `n`, the column for `e`/`w`),
 * else the opposite one; tables ring; benches, shelves, racks and counters stand there every 2 tiles for the long ones; a
 * console sits to its left; sofas and armchairs sit on themselves. M16: `facing` picks the front (default `s`).
 */
export function seatsFor(kind: FurnitureKind, rect: Rect, interior: Rect, facing: Facing = 's'): RecipeSeat[] {
  const out: RecipeSeat[] = [];
  // M15: seats are whole tiles, so a half-offset item seats the ring around (or the tiles under) the integer rect it covers.
  rect = coveredTileRect(rect);
  const x2 = rect.x + rect.w - 1;
  const y2 = rect.y + rect.h - 1;
  const ix2 = interior.x + interior.w - 1;
  const iy2 = interior.y + interior.h - 1;
  const inside = (x: number, y: number) => x >= interior.x && x <= ix2 && y >= interior.y && y <= iy2;
  const along = (seatKind: RecipeSeat['kind'], step: number) => {
    if (facing === 's' || facing === 'n') {
      const front = facing === 's' ? y2 + 1 : rect.y - 1;
      const back = facing === 's' ? rect.y - 1 : y2 + 1;
      const y = front >= interior.y && front <= iy2 ? front : back >= interior.y && back <= iy2 ? back : null;
      if (y === null) return;
      for (let x = rect.x; x <= x2; x += step) out.push({ x, y, kind: seatKind });
    } else {
      const front = facing === 'e' ? x2 + 1 : rect.x - 1;
      const back = facing === 'e' ? rect.x - 1 : x2 + 1;
      const x = front >= interior.x && front <= ix2 ? front : back >= interior.x && back <= ix2 ? back : null;
      if (x === null) return;
      for (let y = rect.y; y <= y2; y += step) out.push({ x, y, kind: seatKind });
    }
  };
  switch (kind) {
    case 'work-desk':
    case 'lead-desk':
    case 'booth':
    case 'reading-table':
      along('sit', 1);
      break;
    case 'table': {
      for (let x = rect.x; x <= x2; x++) {
        if (inside(x, rect.y - 1)) out.push({ x, y: rect.y - 1, kind: 'sit' });
        if (inside(x, y2 + 1)) out.push({ x, y: y2 + 1, kind: 'sit' });
      }
      for (let y = rect.y; y <= y2; y++) {
        if (inside(rect.x - 1, y)) out.push({ x: rect.x - 1, y, kind: 'sit' });
        if (inside(x2 + 1, y)) out.push({ x: x2 + 1, y, kind: 'sit' });
      }
      break;
    }
    case 'bench':
    case 'standing-table':
      along('stand', 1);
      break;
    case 'lab-bench':
    case 'workbench':
    case 'shelf':
    case 'shelf-stack':
    case 'counter':
      along('stand', 2);
      break;
    case 'rack':
    case 'rack-row': {
      along('stand', 1000); // one seat, at the start of the front line
      break;
    }
    case 'console':
      if (inside(rect.x - 1, rect.y)) out.push({ x: rect.x - 1, y: rect.y, kind: 'sit' });
      break;
    case 'sofa':
    case 'armchair':
      for (let y = rect.y; y <= y2; y++) for (let x = rect.x; x <= x2; x++) out.push({ x, y, kind: 'sit' });
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Plan, anchors and placement

export interface PlacementCtx extends FurnishContext {
  interior: Rect;
  density: FurnishDensity;
  aisle: number;
  decor: number;
}

/** One group instance of a room's plan: its resolved members and their stable slot ids. */
export interface PlanInstance {
  group: GroupTemplate;
  /** `<group>#<n>` (n = index among instances of that group id in this room). */
  groupId: string;
  index: number;
  members: GroupMember[];
  /** `<group>:<ordinal-in-plan>` per member. */
  slotIds: string[];
  /** The row slot for `fill` groups. */
  slot?: { x: number; y: number };
  /** 1-based owner id in the occupancy grid. */
  owner: number;
  /** Ordinal of the first member slot; member i is `firstOrdinal + i`. */
  firstOrdinal: number;
  /** Per-facing rotation and anchor lists, filled on first use (they do not depend on the candidate's stream). */
  cache?: Partial<Record<Facing, { rotated: GroupMember[]; anchors: Point[] }>>;
}

function rowSlotsFor(t: GroupTemplate, c: PlacementCtx): { x: number; y: number; h?: number }[] {
  const region = t.region ? t.region(c.interior) : c.interior;
  if (!region || region.w <= 0 || region.h <= 0) return [];
  const probe = staticMembers(t, { interior: c.interior, density: c.density, aisle: c.aisle, index: 0, slotH: 1 });
  const a = probe.find((mem) => mem.anchor) ?? probe[0];
  if (!a) return [];
  const half = HALF_GAPS && c.density === 'normal' && a.w >= 2;
  const rows = fillRows(region, a.w, a.h, c.aisle, c.density, half);
  const slots = t.merge ? mergeStacks(rows) : rows.map((p) => ({ x: p.x, y: p.y }));
  return slots.slice(0, MAX_FILL_INSTANCES);
}

const DENSITY_RANK: Record<FurnishDensity, number> = { sparse: 0, normal: 1, dense: 2, packed: 3 };

/**
 * The room's plan: the ordered `(group instance, member)` list the room WANTS, computed before any collision test from
 * `ROOM_PLANS[type]`, the interior size, density and the repeat rule. Slot ordinals count members across the whole plan.
 */
export function buildPlan(type: RoomType, c: PlacementCtx): PlanInstance[] {
  const out: PlanInstance[] = [];
  const perGroup = new Map<string, number>();
  let ordinal = 0;
  for (const id of planOf(type)) {
    const t = groupOf(id);
    if (!t) continue;
    if (t.minW !== undefined && c.interior.w < t.minW) continue;
    if (t.minH !== undefined && c.interior.h < t.minH) continue;
    if (t.minDensity && DENSITY_RANK[c.density] < DENSITY_RANK[t.minDensity]) continue;
    let slots: { x: number; y: number; h?: number }[] | undefined;
    let count: number;
    if (t.repeat === 'fill') {
      slots = rowSlotsFor(t, c);
      count = slots.length;
    } else {
      count = Math.min(MAX_GROUP_INSTANCES, typeof t.repeat === 'function' ? t.repeat(c.density) : t.repeat);
    }
    for (let k = 0; k < count; k++) {
      const index = perGroup.get(id) ?? 0;
      const slot = slots?.[k];
      const members = [...staticMembers(t, { interior: c.interior, density: c.density, aisle: c.aisle, index, ...(slot?.h !== undefined && { slotH: slot.h }) })];
      if (!members.length || ordinal + members.length > MAX_PLAN_SLOTS) continue;
      perGroup.set(id, index + 1);
      out.push({
        group: t,
        groupId: `${id}#${index}`,
        index,
        members,
        slotIds: members.map((_, mi) => `${id}:${ordinal + mi}`),
        firstOrdinal: ordinal,
        ...(slot && { slot: { x: slot.x, y: slot.y } }),
        owner: out.length + 1,
      });
      ordinal += members.length;
    }
  }
  return out;
}

const snapHalf = (v: number): number => Math.round(v * 2) / 2 + 0;
const SIDE_OF_FACING: Record<Facing, Facing> = { s: 'n', n: 's', e: 'w', w: 'e' };

interface Bounds {
  minX: number;
  minY: number;
  w: number;
  h: number;
}
/** Bounding box of the mandatory (non-optional) members, relative to the anchor's top-left. */
function boundsOf(members: readonly GroupMember[]): Bounds {
  const req = members.filter((mem) => !mem.optional);
  const list = req.length ? req : members;
  const minX = Math.min(...list.map((mem) => mem.dx));
  const minY = Math.min(...list.map((mem) => mem.dy));
  return { minX, minY, w: Math.max(...list.map((mem) => mem.dx + mem.w)) - minX, h: Math.max(...list.map((mem) => mem.dy + mem.h)) - minY };
}

/** Centre-out deltas (in tiles, halves allowed) tried around the interior centre. */
const CENTRE_DELTAS: readonly Point[] = (() => {
  const out: Point[] = [{ x: 0, y: 0 }];
  for (const d of [0.5, 1, 1.5, 2, 3]) {
    out.push({ x: -d, y: 0 }, { x: d, y: 0 }, { x: 0, y: -d }, { x: 0, y: d }, { x: -d, y: -d }, { x: d, y: -d }, { x: -d, y: d }, { x: d, y: d });
  }
  return out;
})();

/**
 * Anchor top-left positions a group may take for `facing`, in priority order for its affinity. Walls: flush to the side
 * the facing looks away from (`s` = north wall), centre-out along it; corners: the corners (a non-rotatable group takes
 * all four, facing `s`); centre: the interior centre snapped to halves, then a ring around it; any: the row slots (the
 * half-gap pitch is in `rowSlotsFor`). Every candidate keeps the whole group inside the interior; clearance and aprons
 * are checked at placement.
 */
export function anchorCandidates(t: GroupTemplate, facing: Facing, ctx: PlacementCtx, members?: readonly GroupMember[]): Point[] {
  const { interior: r } = ctx;
  if (t.affinity === 'any') return rowSlotsFor(t, ctx).map((s) => ({ x: s.x, y: s.y }));
  const rotated = rotateGroup(t, facing, members ?? staticMembers(t, { interior: r, density: ctx.density, aisle: ctx.aisle, index: 0 }));
  if (!rotated.length) return [];
  const b = boundsOf(rotated);
  const at = (px: number, py: number): Point => ({ x: px - b.minX, y: py - b.minY });
  if (b.w > r.w || b.h > r.h) return [];
  const out: Point[] = [];
  if (t.affinity === 'wall') {
    const side = SIDE_OF_FACING[facing];
    const along = (lo: number, hi: number): number[] => {
      const centre = (lo + hi) / 2;
      const xs: number[] = [];
      for (let v = lo; v <= hi; v++) xs.push(v);
      return xs.sort((p, q) => Math.abs(p - centre) - Math.abs(q - centre) || p - q);
    };
    if (side === 'n' || side === 's') {
      const py = side === 'n' ? r.y : r.y + r.h - b.h;
      for (const px of along(r.x, r.x + r.w - b.w)) out.push(at(px, py));
    } else {
      const px = side === 'w' ? r.x : r.x + r.w - b.w;
      for (const py of along(r.y, r.y + r.h - b.h)) out.push(at(px, py));
    }
  } else if (t.affinity === 'corner') {
    const north = [at(r.x, r.y), at(r.x + r.w - b.w, r.y)];
    const south = [at(r.x, r.y + r.h - b.h), at(r.x + r.w - b.w, r.y + r.h - b.h)];
    if (!t.rotatable) out.push(...north, ...south);
    else if (facing === 's') out.push(...north);
    else if (facing === 'n') out.push(...south);
  } else {
    const cx = snapHalf(r.x + (r.w - b.w) / 2);
    const cy = snapHalf(r.y + (r.h - b.h) / 2);
    for (const d of CENTRE_DELTAS) {
      const px = cx + d.x;
      const py = cy + d.y;
      if (px >= r.x && py >= r.y && px + b.w <= r.x + r.w && py + b.h <= r.y + r.h) out.push(at(px, py));
    }
  }
  return out;
}

export interface PlacedMember {
  index: number;
  member: GroupMember;
  rect: Rect;
  facing: Facing;
}
/** A group instance placed in phase 1 (the anchor, blocking members and the clearance strip); soft members follow. */
export interface PlacedInstance {
  inst: PlanInstance;
  facing: Facing;
  anchor: Point;
  rotated: GroupMember[];
  placed: PlacedMember[];
}

const isPhaseOne = (mem: GroupMember): boolean => !!mem.anchor || isBlockingKind(mem.kind);
const rectOf = (a: Point, mem: GroupMember): Rect => ({ x: a.x + mem.dx, y: a.y + mem.dy, w: mem.w, h: mem.h });
const facingOrDefault = (mem: GroupMember, groupFacing: Facing): Facing => mem.facing ?? groupFacing;

function facingChoices(t: GroupTemplate, ctx: PlacementCtx, rng: () => number): Facing[] {
  if (t.affinity === 'any') return ['s'];
  const base: readonly Facing[] = t.rotatable ? (t.facings ?? ['s', 'n', 'e', 'w']) : ['s'];
  // Facings whose wall is solid come first; an open-plan room still gets its group (the rest follow).
  const list = [...base].sort(
    (a, b) => Number(ctx.wallSides.has(SIDE_OF_FACING[b])) - Number(ctx.wallSides.has(SIDE_OF_FACING[a])),
  );
  if (list.length > 1 && rng() >= 0.5) {
    const k = Math.floor(rng() * list.length);
    return [...list.slice(k), ...list.slice(0, k)];
  }
  return list;
}

/**
 * Phase 1 of placing one instance: tries facings (`s` first; others when `rotatable`) and anchors in order and returns
 * the instance with its anchor and blocking members written into `grid`, or null. A consumed member (a pin took its slot)
 * is neither checked nor written; the rest of the group is placed around it. Soft members follow in `placeSoft`.
 */
export function placeGroup(inst: PlanInstance, ctx: PlacementCtx, grid: OccupancyGrid, rng: () => number, consumed: ReadonlySet<string> = ctx.consumedSlots): PlacedInstance | null {
  const t = inst.group;
  for (const facing of facingChoices(t, ctx, rng)) {
    const cache = (inst.cache ??= {});
    const hit = (cache[facing] ??= {
      rotated: rotateGroup(t, facing, inst.members),
      anchors: inst.slot ? [inst.slot] : anchorCandidates(t, facing, ctx, inst.members),
    });
    const rotated = hit.rotated;
    let anchors = hit.anchors;
    if (anchors.length > 1) {
      const start = Math.floor(rng() * rng() * anchors.length);
      anchors = [...anchors.slice(start), ...anchors.slice(0, start)];
    }
    for (const a of anchors) {
      const placed = tryAnchor(inst, rotated, facing, a, ctx, grid, consumed);
      if (placed) return placed;
    }
  }
  return null;
}

function tryAnchor(
  inst: PlanInstance,
  rotated: GroupMember[],
  facing: Facing,
  a: Point,
  ctx: PlacementCtx,
  grid: OccupancyGrid,
  consumed: ReadonlySet<string>,
): PlacedInstance | null {
  const t = inst.group;
  const placed: PlacedMember[] = [];
  const anchorMember = rotated.find((mem) => mem.anchor) ?? rotated[0]!;
  for (let i = 0; i < rotated.length; i++) {
    const mem = rotated[i]!;
    if (!isPhaseOne(mem) || consumed.has(inst.slotIds[i]!)) continue;
    const rect = rectOf(a, mem);
    if (!grid.canPlace(rect, inst.owner)) {
      if (mem.optional) continue;
      return null;
    }
    placed.push({ index: i, member: mem, rect, facing: facingOrDefault(mem, facing) });
  }
  let strip: Rect | null = null;
  if (t.clearance > 0) {
    strip = frontStrip(rectOf(a, anchorMember), facing, t.clearance);
    if (!grid.canPlace(strip, inst.owner)) return null;
  }
  for (const p of placed) grid.mark(p.rect, isBlockingKind(p.member.kind) ? CELL_BLOCKING : CELL_SOFT, inst.owner);
  if (strip) grid.mark(strip, CELL_RESERVED, inst.owner);
  return { inst, facing, anchor: a, rotated, placed };
}

/** Phase 2: the soft members (chairs, rugs, lamps). One that does not fit is skipped, or tried mirrored across the anchor. */
export function placeSoft(pi: PlacedInstance, grid: OccupancyGrid, consumed: ReadonlySet<string>): void {
  const { inst, rotated, facing } = pi;
  const anchorMember = rotated.find((mem) => mem.anchor) ?? rotated[0]!;
  const ar = rectOf(pi.anchor, anchorMember);
  for (let i = 0; i < rotated.length; i++) {
    const mem = rotated[i]!;
    if (isPhaseOne(mem) || consumed.has(inst.slotIds[i]!)) continue;
    let rect = rectOf(pi.anchor, mem);
    let mf = facingOrDefault(mem, facing);
    if (!grid.canPlace(rect, inst.owner) && mem.mirror) {
      rect = { ...rect, y: ar.y + ar.h - (rect.y - ar.y + rect.h) };
      mf = oppositeFacing(mf);
    }
    if (!grid.canPlace(rect, inst.owner)) continue;
    grid.mark(rect, CELL_SOFT, inst.owner);
    pi.placed.push({ index: i, member: mem, rect, facing: mf });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring

export interface HarmonyScore {
  reach: number;
  clearance: number;
  alignment: number;
  symmetry: number;
  density: number;
  total: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const apronCache = new WeakMap<ReadonlySet<string>, [number, number][]>();
/** The apron keys parsed once per set (parsing "x,y" strings per candidate showed up in the profile). */
function apronPoints(aprons: ReadonlySet<string>): [number, number][] {
  let pts = apronCache.get(aprons);
  if (!pts) {
    pts = [...aprons].map((k) => k.split(',').map(Number) as [number, number]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    apronCache.set(aprons, pts);
  }
  return pts;
}

/** Tile flood over the interior minus a blocked mask, from the door aprons (else the free interior edge). */
function floodReach(mask: Uint8Array, ctx: PlacementCtx): { free: (x: number, y: number) => boolean; seen: Uint8Array; reached: number } {
  const r = ctx.interior;
  const w = Math.round(r.w);
  const h = Math.round(r.h);
  const free = (x: number, y: number): boolean => x >= r.x && x < r.x + w && y >= r.y && y < r.y + h && mask[(y - r.y) * w + (x - r.x)] === 0;
  const seen = new Uint8Array(w * h);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    if (!free(x, y)) return;
    const i = (y - r.y) * w + (x - r.x);
    if (seen[i]) return;
    seen[i] = 1;
    queue.push(i);
  };
  let sources = 0;
  for (const [sx, sy] of apronPoints(ctx.aprons)) {
    if (free(sx, sy)) {
      push(sx, sy);
      sources++;
    }
  }
  if (!sources) {
    for (let x = r.x; x < r.x + w; x++) {
      push(x, r.y);
      push(x, r.y + h - 1);
    }
    for (let y = r.y; y < r.y + h; y++) {
      push(r.x, y);
      push(r.x + w - 1, y);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    const x = r.x + (i % w);
    const y = r.y + Math.floor(i / w);
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return { free, seen, reached: queue.length };
}

/**
 * reach: 0 when any seat is unreachable from the aprons (tile flood over the interior minus blocking), else the reachable
 *   fraction of the free floor; clearance: mean of the fraction of seats with a free neighbour tile and of aprons with a
 *   free next tile; alignment: fraction of blocking items sharing an edge line with another item or the interior; symmetry
 *   (rooms >= 6 on a side): overlap of the blocking tile mask with its mirror, best of the two axes, else 1; density:
 *   1 - |coverage - target| / target. total = weighted sum; reach = 0 forces total = 0.
 */
export function scoreCandidate(items: readonly RecipeItem[], seats: readonly RecipeSeat[], ctx: PlacementCtx): HarmonyScore {
  const r = ctx.interior;
  const w = Math.round(r.w);
  const h = Math.round(r.h);
  const mask = new Uint8Array(w * h);
  const paint = (rect: Rect) => {
    const c = coveredTileRect(rect);
    for (let y = Math.max(c.y, r.y); y < Math.min(c.y + c.h, r.y + h); y++) {
      for (let x = Math.max(c.x, r.x); x < Math.min(c.x + c.w, r.x + w); x++) mask[(y - r.y) * w + (x - r.x)] = 1;
    }
  };
  for (const it of items) if (it.blocking) paint(it);
  for (const p of ctx.pinned) paint(p);
  return scoreWith(items, seats, ctx, mask, floodReach(mask, ctx));
}

function scoreWith(items: readonly RecipeItem[], seats: readonly RecipeSeat[], ctx: PlacementCtx, mask: Uint8Array, flood: ReturnType<typeof floodReach>): HarmonyScore {
  const r = ctx.interior;
  const w = Math.round(r.w);
  const h = Math.round(r.h);
  const blocking = items.filter((it) => it.blocking);
  const { free, seen, reached } = flood;
  let freeCount = 0;
  for (let i = 0; i < mask.length; i++) if (!mask[i]) freeCount++;
  const seatsOk = seats.every((s) => free(s.x, s.y) && seen[(s.y - r.y) * w + (s.x - r.x)] === 1);
  const reach = seatsOk ? (freeCount ? reached / freeCount : 1) : 0;
  // clearance
  const hasFreeNeighbour = (x: number, y: number) => free(x + 1, y) || free(x - 1, y) || free(x, y + 1) || free(x, y - 1);
  const parts: number[] = [];
  if (seats.length) parts.push(seats.filter((s) => hasFreeNeighbour(s.x, s.y)).length / seats.length);
  const apronsIn = apronPoints(ctx.aprons).filter(([x, y]) => x >= r.x && x < r.x + w && y >= r.y && y < r.y + h);
  if (apronsIn.length) parts.push(apronsIn.filter(([x, y]) => hasFreeNeighbour(x, y)).length / apronsIn.length);
  const clearance = parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : 1;
  // alignment: an item is aligned when one of its edge lines is the interior's or another item's (line counts, not O(n^2))
  const xLines = new Map<number, number>();
  const yLines = new Map<number, number>();
  const bump = (m: Map<number, number>, a: number, b: number) => {
    m.set(a, (m.get(a) ?? 0) + 1);
    if (b !== a) m.set(b, (m.get(b) ?? 0) + 1);
  };
  for (const a of blocking) {
    bump(xLines, a.x, a.x + a.w);
    bump(yLines, a.y, a.y + a.h);
  }
  let aligned = 0;
  for (const a of blocking) {
    const ax1 = a.x + a.w;
    const ay1 = a.y + a.h;
    const touchesEdge = a.x === r.x || ax1 === r.x + r.w || a.y === r.y || ay1 === r.y + r.h;
    const shares = (xLines.get(a.x) ?? 0) > 1 || (xLines.get(ax1) ?? 0) > 1 || (yLines.get(a.y) ?? 0) > 1 || (yLines.get(ay1) ?? 0) > 1;
    if (touchesEdge || shares) aligned++;
  }
  const alignment = blocking.length ? aligned / blocking.length : 1;
  // symmetry
  let symmetry = 1;
  if (w >= 6 || h >= 6) {
    let total = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        total++;
        if (mask[y * w + (w - 1 - x)]) sx++;
        if (mask[(h - 1 - y) * w + x]) sy++;
      }
    }
    symmetry = total ? Math.max(sx, sy) / total : 1;
  }
  // density
  const area = blocking.reduce((s, it) => s + it.w * it.h, 0);
  const target = DENSITY_TARGET[ctx.density];
  const density = clamp01(1 - Math.abs(area / (r.w * r.h) - target) / target);
  const total =
    reach === 0
      ? 0
      : SCORE_WEIGHTS.reach * reach +
        SCORE_WEIGHTS.clearance * clearance +
        SCORE_WEIGHTS.density * density +
        SCORE_WEIGHTS.alignment * alignment +
        SCORE_WEIGHTS.symmetry * symmetry;
  return { reach, clearance, alignment, symmetry, density, total };
}

// ---------------------------------------------------------------------------------------------------------------
// Candidates

export interface CandidateResult {
  items: RecipeItem[];
  seats: RecipeSeat[];
  score: HarmonyScore;
  /** Plan slots that could not be placed (collision or no room), excluding consumed ones. */
  skippedSlots: string[];
}

function buildCandidate(plan: readonly PlanInstance[], ctx: PlacementCtx, rng: () => number): CandidateResult & { placedFlag: Uint8Array } {
  const r = ctx.interior;
  const grid = new OccupancyGrid(r);
  for (const [x, y] of apronPoints(ctx.aprons)) grid.mark({ x, y, w: 1, h: 1 }, CELL_RESERVED, 0);
  for (const p of ctx.pinned) grid.mark(p, CELL_BLOCKING, 0);
  const placed = new Map<number, PlacedInstance>();
  const order = plan.map((inst, i) => ({ inst, i })).sort((a, b) => b.inst.group.weight - a.inst.group.weight || a.i - b.i);
  for (const { inst } of order) {
    const pi = placeGroup(inst, ctx, grid, rng);
    if (pi) placed.set(inst.owner, pi);
  }
  for (const inst of plan) {
    const pi = placed.get(inst.owner);
    if (pi) placeSoft(pi, grid, ctx.consumedSlots);
  }
  // items (plan order = slot ordinal order) and the seats they offer
  const items: RecipeItem[] = [];
  const placedFlag = new Uint8Array(plan.reduce((n, inst) => n + inst.members.length, 0));
  const seats: RecipeSeat[] = [];
  const seatKeys = new Set<number>();
  const mask = grid.tileMask();
  const flood = floodReach(mask, ctx);
  const reachable = (s: RecipeSeat) => flood.seen[(s.y - r.y) * Math.round(r.w) + (s.x - r.x)] === 1;
  const addSeat = (s: RecipeSeat, explicit: boolean) => {
    const k = s.y * 4096 + s.x;
    // A default seat in a sealed pocket (a packed stack's inner gap) is dropped; an explicit one is kept and scores reach 0.
    if (seatKeys.has(k) || grid.tileBlocked(s.x, s.y) || (!explicit && !reachable(s))) return;
    seatKeys.add(k);
    seats.push(s);
  };
  for (const inst of plan) {
    const pi = placed.get(inst.owner);
    if (!pi) continue;
    for (const p of pi.placed.sort((a, b) => a.index - b.index)) {
      placedFlag[inst.firstOrdinal + p.index] = 1;
      const item: RecipeItem = {
        kind: p.member.kind,
        x: p.rect.x,
        y: p.rect.y,
        w: p.rect.w,
        h: p.rect.h,
        blocking: isBlockingKind(p.member.kind),
        variant: Math.floor(rng() * 4),
        slotId: inst.slotIds[p.index]!,
        groupId: inst.groupId,
      };
      if (p.facing !== 's' && facingSupported(p.member.kind, p.facing)) item.facing = p.facing;
      items.push(item);
      if (p.member.seats) {
        for (const s of p.member.seats) addSeat({ x: Math.floor(p.rect.x + s.dx), y: Math.floor(p.rect.y + s.dy), kind: s.kind }, true);
      } else if (SEATING_KINDS.has(p.member.kind)) {
        // Default seats: the front side when a tile there is free, else the opposite side (a stack's inner rows share aisles).
        const front = seatsFor(p.member.kind, p.rect, r, p.facing).filter((s) => !grid.tileBlocked(s.x, s.y) && reachable(s));
        const own = front.length ? front : seatsFor(p.member.kind, p.rect, r, oppositeFacing(p.facing)).filter((s) => !grid.tileBlocked(s.x, s.y) && reachable(s));
        for (const s of own) addSeat(s, false);
      }
    }
  }
  return { items, seats, score: scoreWith(items, seats, ctx, mask, flood), skippedSlots: [], placedFlag };
}

/** Kinds `seatsFor` can seat; any other member skips the call. */
const SEATING_KINDS: ReadonlySet<string> = new Set([
  'work-desk', 'lead-desk', 'booth', 'reading-table', 'table', 'bench', 'standing-table', 'lab-bench', 'workbench', 'shelf', 'shelf-stack',
  'counter', 'rack', 'rack-row', 'console', 'sofa', 'armchair',
]);

/**
 * K candidates from the room's stream, scored; the best wins, ties by index. The stream advances by exactly
 * `CANDIDATE_DRAWS` per candidate (candidate j starts at a fixed offset whatever the earlier ones consumed).
 */
export function bestCandidate(type: RoomType, ctx: PlacementCtx, rand: () => number, K: number): CandidateResult {
  const plan = buildPlan(type, ctx);
  // Row-only plans place identically whatever the stream says (only item variants differ): build one candidate.
  const varies = plan.some((inst) => inst.group.affinity !== 'any');
  let best: (CandidateResult & { placedFlag: Uint8Array }) | null = null;
  for (let j = 0; j < Math.max(1, K); j++) {
    const rng = mulberry32(Math.floor(rand() * 4294967296));
    for (let d = 1; d < CANDIDATE_DRAWS; d++) rand();
    if ((j > 0 && !varies) || (best && best.score.total >= GOOD_ENOUGH_SCORE)) continue;
    const cand = buildCandidate(plan, ctx, rng);
    if (!best || cand.score.total > best.score.total) best = cand;
  }
  const win = best!;
  const skippedSlots: string[] = [];
  for (const inst of plan) {
    inst.slotIds.forEach((slotId, i) => {
      if (!win.placedFlag[inst.firstOrdinal + i] && !ctx.consumedSlots.has(slotId)) skippedSlots.push(slotId);
    });
  }
  return { items: win.items, seats: win.seats, score: win.score, skippedSlots };
}

/**
 * Displacement (furnishing.md 3.4): slides a group's items along their row/wall axis by +-0.5, +-1 ... up to 3 tiles and
 * returns the shifted copies when every blocking item then fits in `grid` (which must NOT contain the items themselves),
 * else null (the caller drops the item and records the slot). Facing and affinity are preserved.
 */
export function relocate(items: readonly RecipeItem[], axis: 'x' | 'y', grid: OccupancyGrid): RecipeItem[] | null {
  for (let d = 0.5; d <= 3; d += 0.5) {
    for (const sign of [1, -1]) {
      const shifted = items.map((it) => ({ ...it, [axis]: it[axis] + sign * d }));
      if (shifted.every((it) => (it.blocking ? grid.canPlace(it, 0) : grid.inside(it)))) return shifted;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Decor (furnishing.md 3.5)

export interface DecorContext {
  wallSides: ReadonlySet<Facing>;
  /** Seat tiles ("x,y") decor must not cover; lamps cluster near them. */
  seats: ReadonlySet<string>;
  corners: readonly Point[];
  aprons: ReadonlySet<string>;
}
export type DecorAffinity = Affinity | 'seat';
export const DECOR_AFFINITY: Record<'plant' | 'rug' | 'lamp' | 'crate' | 'banner' | 'wall-art' | 'bin', DecorAffinity> = {
  plant: 'corner',
  rug: 'centre',
  lamp: 'seat',
  crate: 'wall',
  banner: 'wall',
  'wall-art': 'wall',
  bin: 'wall',
};
const DECOR_KINDS: readonly (keyof typeof DECOR_AFFINITY)[] = ['plant', 'rug', 'lamp', 'crate', 'banner', 'wall-art', 'bin'];

/** Stable per-item hash: pinning or consuming one item never reshuffles the others. */
export const decorHash = (roomSeed: string, i: number, tag: string): number => fnv1a(`${roomSeed}|${i}|${tag}`);

export function decorateWithContext(r: Rect, freeCells: readonly Point[], decor: number, roomSeed: string, ctx: DecorContext): RecipeItem[] {
  if (decor <= 0 || freeCells.length === 0) return [];
  const perimeter = 2 * (r.w + r.h);
  const count = Math.min(freeCells.length, Math.round(perimeter * decor * 0.25));
  const x2 = r.x + r.w - 1;
  const y2 = r.y + r.h - 1;
  const key = (p: Point) => `${p.x},${p.y}`;
  const free = freeCells.filter((p) => !ctx.seats.has(key(p)) && !ctx.aprons.has(key(p)));
  const nearCorner = (p: Point, d: number) => ctx.corners.some((c) => Math.abs(c.x - p.x) <= d && Math.abs(c.y - p.y) <= d);
  const wallCell = (p: Point) =>
    (p.y === r.y && ctx.wallSides.has('n')) || (p.y === y2 && ctx.wallSides.has('s')) || (p.x === r.x && ctx.wallSides.has('w')) || (p.x === x2 && ctx.wallSides.has('e'));
  const seatPoints = [...ctx.seats].map((k) => k.split(',').map(Number) as [number, number]);
  const eligibleFor = (kind: keyof typeof DECOR_AFFINITY): Point[] => {
    switch (DECOR_AFFINITY[kind]) {
      case 'wall':
        return free.filter(wallCell);
      case 'corner': {
        const exact = free.filter((p) => ctx.corners.some((c) => c.x === p.x && c.y === p.y));
        return exact.length ? exact : free.filter((p) => nearCorner(p, 1));
      }
      case 'seat':
        return free.filter((p) => nearCorner(p, 1) || seatPoints.some(([sx, sy]) => Math.abs(sx - p.x) + Math.abs(sy - p.y) === 1));
      default:
        return free.filter((p) => p.x > r.x && p.x < x2 && p.y > r.y && p.y < y2);
    }
  };
  const eligible = new Map<string, Point[]>();
  const used = new Set<string>();
  const out: RecipeItem[] = [];
  for (let i = 0; i < count; i++) {
    const kind = DECOR_KINDS[decorHash(roomSeed, i, 'kind') % DECOR_KINDS.length]!;
    let cells = eligible.get(kind);
    if (!cells) {
      cells = eligibleFor(kind);
      eligible.set(kind, cells);
    }
    if (!cells.length) continue;
    const start = decorHash(roomSeed, i, 'cell') % cells.length;
    for (let probe = 0; probe < cells.length; probe++) {
      const cell = cells[(start + probe) % cells.length]!;
      if (used.has(key(cell))) continue;
      used.add(key(cell));
      out.push({ kind, x: cell.x, y: cell.y, w: 1, h: 1, blocking: false, variant: decorHash(roomSeed, i, 'variant') % 4 });
      break;
    }
  }
  return out;
}
