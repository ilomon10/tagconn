import { z } from 'zod';
import { ZONES, type Zone } from './domain.js';

/**
 * Office layouts (M7). A layout is the persisted, user-drawn floor plan: a grid plus axis-aligned
 * rooms. Walls, doors, corridors, furniture and seats are generated from it deterministically
 * (apps/web/src/game/procgen). The geometry does not depend on the visual style, so switching the
 * skin never moves seats or characters. See docs/design/guild-hall.md.
 */

// ------------------------------------------------------------------ styles

/** Visual skins. Separate from the day/night lighting (`office.theme`). */
export const OFFICE_STYLES = ['modern', 'guild'] as const;
export type OfficeStyle = (typeof OFFICE_STYLES)[number];

// ------------------------------------------------------------------ room types

/**
 * Room types: every activity zone, plus
 * - `stairs`: a landing that holds the up/down staircases (portal in the guild style). Not a zone.
 * - `hall`: explicit walkable open floor (useful with `background: 'void'`). Not a zone.
 */
export const ROOM_TYPES = [...ZONES, 'stairs', 'hall'] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const isZoneRoomType = (t: RoomType): t is Zone => (ZONES as readonly string[]).includes(t);

/** Room types that get a wall ring by default (a room may override with `walled`). */
export const DEFAULT_WALLED_ROOM_TYPES: readonly RoomType[] = [
  'pm-office',
  'meeting-room',
  'library',
  'review-booth',
  'qa-lab',
  'server-room',
];

/** Minimum INTERIOR size (tiles inside the wall ring, or the whole rect for open rooms). */
export const ROOM_MIN_INTERIOR: Record<RoomType, { w: number; h: number }> = {
  entrance: { w: 3, h: 3 },
  'pm-office': { w: 4, h: 3 },
  desks: { w: 4, h: 3 },
  'meeting-room': { w: 5, h: 5 },
  whiteboard: { w: 3, h: 3 },
  'qa-lab': { w: 3, h: 3 },
  'review-booth': { w: 3, h: 3 },
  'server-room': { w: 3, h: 3 },
  library: { w: 4, h: 4 },
  lounge: { w: 4, h: 3 },
  stairs: { w: 2, h: 2 },
  hall: { w: 2, h: 2 },
};

/**
 * When a layout has no room for a zone, agents heading there go to the first fallback that exists.
 * `entrance` always exists (validation requires exactly one), so resolution always terminates.
 */
export const ZONE_FALLBACKS: Record<Zone, readonly Zone[]> = {
  entrance: [],
  'pm-office': ['meeting-room', 'desks', 'lounge', 'entrance'],
  desks: ['pm-office', 'lounge', 'entrance'],
  'meeting-room': ['whiteboard', 'pm-office', 'desks', 'lounge', 'entrance'],
  whiteboard: ['meeting-room', 'pm-office', 'desks', 'entrance'],
  'qa-lab': ['server-room', 'desks', 'entrance'],
  'review-booth': ['library', 'desks', 'entrance'],
  'server-room': ['qa-lab', 'desks', 'entrance'],
  library: ['review-booth', 'desks', 'lounge', 'entrance'],
  lounge: ['entrance'],
};

/** The zone an agent actually walks to, given which room types the current layout contains. */
export function resolveZone(zone: Zone, available: ReadonlySet<RoomType>): Zone {
  if (available.has(zone)) return zone;
  for (const f of ZONE_FALLBACKS[zone]) if (available.has(f)) return f;
  return 'entrance';
}

// ------------------------------------------------------------------ limits

export const LAYOUT_LIMITS = {
  maxDoorsPerRoom: 8,
  maxSeatsPerRoom: 64,
  minWidth: 16,
  maxWidth: 128,
  minHeight: 12,
  maxHeight: 96,
  maxRooms: 64,
  maxStairs: 4,
  maxNameLength: 80,
} as const;

// ------------------------------------------------------------------ schemas

/** Excludes `__proto__`/`constructor`/`prototype`: reserved JS property names that would otherwise
 * be accepted as a layout id and could poison plain-object property lookups elsewhere. */
export const LAYOUT_ID_RE = /^(?!__proto__$|constructor$|prototype$)[a-z0-9][a-z0-9-]{0,63}$/;
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Strips control characters and Unicode bidi-override/isolate marks (U+202A-U+202E, U+2066-U+2069)
 * from user-entered names, so a saved layout/room name can't spoof direction or hide characters
 * in the UI (e.g. an RTL-override trick). */
const stripControlAndBidi = (s: string): string => s.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, '');

/** Trimmed, control/bidi-stripped display name, re-validated for length after stripping. */
const NameSchema = z
  .string()
  .transform(stripControlAndBidi)
  .pipe(z.string().trim().min(1).max(LAYOUT_LIMITS.maxNameLength));

/**
 * A drawn room. (x, y, w, h) is the FOOTPRINT in tiles, including the wall ring for walled rooms.
 * Walled rooms may share a 1-tile wall with each other or with the outer wall.
 */
/** How full a room is furnished (M8 8n). `packed` fills every free tile that keeps paths open. */
export const FURNISH_DENSITIES = ['sparse', 'normal', 'dense', 'packed'] as const;
export type FurnishDensity = (typeof FURNISH_DENSITIES)[number];

export const RoomFurnishSchema = z.object({
  density: z.enum(FURNISH_DENSITIES).optional(),
  /** Target number of seats/workstations (desks, lab benches, racks, tables…; meaning depends on the room type). */
  seats: z.number().int().min(0).max(LAYOUT_LIMITS.maxSeatsPerRoom).optional(),
  /** Decoration amount, 0 = none … 1 = lavish (plants, rugs, lamps, crates, banners…). */
  decor: z.number().min(0).max(1).optional(),
  /** Minimum walkway width between furniture rows, in tiles. */
  aisle: z.number().int().min(1).max(3).optional(),
  /** Re-roll this room's arrangement without changing the layout seed. */
  seed: z.number().int().min(0).max(0xffffffff).optional(),
});
export type RoomFurnish = z.infer<typeof RoomFurnishSchema>;

export const DOOR_SIDES = ['n', 's', 'e', 'w'] as const;
export type DoorSide = (typeof DOOR_SIDES)[number];

/** A door on a room's wall ring: `offset` tiles from the side's start (north/south: from x; east/west: from y). */
export const DoorSpecSchema = z.object({
  side: z.enum(DOOR_SIDES),
  offset: z.number().int().min(1),
  width: z.number().int().min(1).max(3).default(1),
});
export type DoorSpec = z.infer<typeof DoorSpecSchema>;

export const LayoutRoomSchema = z.object({
  id: z.string().regex(ROOM_ID_RE),
  type: z.enum(ROOM_TYPES),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  /** Display name override, e.g. "East Wing Workshop". Defaults to the style's zone name. */
  name: NameSchema.optional(),
  /** Override the per-type wall default (`DEFAULT_WALLED_ROOM_TYPES`). */
  walled: z.boolean().optional(),
  /** Furnishing controls (M8 8n). Omitted fields fall back to the layout's `furnishDefaults`, then built-ins. */
  furnish: RoomFurnishSchema.optional(),
  /**
   * Explicit doors on this room's wall ring (walled rooms only). Omitted = automatic doors;
   * `[]` = no doors (the room is sealed — the reachability check will flag it).
   */
  doors: z.array(DoorSpecSchema).max(LAYOUT_LIMITS.maxDoorsPerRoom).optional(),
});
export type LayoutRoom = z.infer<typeof LayoutRoomSchema>;

/** What fills tiles that no room covers. */
export const LAYOUT_BACKGROUNDS = ['hall', 'void'] as const;
export type LayoutBackground = (typeof LAYOUT_BACKGROUNDS)[number];

/** Fields a client may send when saving. The server owns timestamps and `builtin`. */
export const OfficeLayoutInputSchema = z.object({
  /** Omit to let the server generate one (create). */
  id: z.string().regex(LAYOUT_ID_RE).optional(),
  name: NameSchema,
  width: z.number().int().min(LAYOUT_LIMITS.minWidth).max(LAYOUT_LIMITS.maxWidth),
  height: z.number().int().min(LAYOUT_LIMITS.minHeight).max(LAYOUT_LIMITS.maxHeight),
  /** uint32 seed for furniture variation, corridor tie-breaks and decoration. */
  seed: z.number().int().min(0).max(0xffffffff),
  /**
   * `hall`: uncovered tiles are walkable open floor (classic office).
   * `void`: uncovered tiles are solid; the generator carves corridors between rooms.
   */
  background: z.enum(LAYOUT_BACKGROUNDS).default('hall'),
  /** Corridor width in tiles when `background` is `void`. */
  corridorWidth: z.number().int().min(1).max(3).default(2),
  rooms: z.array(LayoutRoomSchema).max(LAYOUT_LIMITS.maxRooms),
  /** Layout-wide furnishing defaults (M8 8n); each room's `furnish` overrides them. */
  furnishDefaults: RoomFurnishSchema.omit({ seed: true, seats: true }).optional(),
  /** Per-layout skin override; falls back to `settings.office.style`. */
  style: z.enum(OFFICE_STYLES).optional(),
  /**
   * Optimistic concurrency (M7 hardening). When set on a PUT, the server 409s if the stored
   * `updatedAt` no longer matches (someone else saved first) or the layout was deleted meanwhile,
   * instead of silently resurrecting it under the same id. Omit to keep the old create-or-replace
   * behavior (backward compatible).
   */
  baseUpdatedAt: z.number().optional(),
});
export type OfficeLayoutInput = z.input<typeof OfficeLayoutInputSchema>;

export const OfficeLayoutSchema = OfficeLayoutInputSchema.omit({ baseUpdatedAt: true }).extend({
  id: z.string().regex(LAYOUT_ID_RE),
  /** Seeded by the server; read-only (duplicate to edit), cannot be deleted. */
  builtin: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type OfficeLayout = z.infer<typeof OfficeLayoutSchema>;

/** Minimal shape `validateLayout` needs (works for inputs, stored layouts and editor drafts). */
export type LayoutGeometry = Pick<OfficeLayout, 'width' | 'height' | 'rooms'>;

// ------------------------------------------------------------------ validation

export type LayoutIssueSeverity = 'error' | 'warning';

export const LAYOUT_ISSUE_CODES = [
  // Geometry (validateLayout, shared by web + server)
  'grid-size',
  'too-many-rooms',
  'duplicate-id',
  'out-of-bounds',
  'overlap',
  'too-small',
  'entrance-count',
  'stairs-missing',
  'too-many-stairs',
  'entrance-not-on-edge',
  'zone-missing',
  // Generation (reported by the web procgen, never by the server)
  'no-door',
  'unreachable-room',
  'door-invalid',
  'door-overlap',
  'room-sealed',
  'unreachable-seat',
] as const;
export type LayoutIssueCode = (typeof LAYOUT_ISSUE_CODES)[number];

export interface LayoutIssue {
  severity: LayoutIssueSeverity;
  code: LayoutIssueCode;
  message: string;
  /** Rooms involved, for highlighting in the editor. */
  roomIds?: string[];
}

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const isRoomWalled = (room: Pick<LayoutRoom, 'type' | 'walled'>): boolean =>
  room.walled ?? DEFAULT_WALLED_ROOM_TYPES.includes(room.type);

/** Floor area of a room: the footprint minus the wall ring for walled rooms (may be empty). */
export function roomInterior(room: Pick<LayoutRoom, 'type' | 'walled' | 'x' | 'y' | 'w' | 'h'>): TileRect {
  if (!isRoomWalled(room)) return { x: room.x, y: room.y, w: room.w, h: room.h };
  return { x: room.x + 1, y: room.y + 1, w: Math.max(0, room.w - 2), h: Math.max(0, room.h - 2) };
}

export const rectsIntersect = (a: TileRect, b: TileRect): boolean =>
  a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const label = (r: Pick<LayoutRoom, 'id' | 'type' | 'name'>) => (r.name ? `"${r.name}"` : `${r.type} (${r.id})`);

/**
 * Pure geometry validation shared by the editor (live messages) and the server (save gate).
 * Rules:
 * - grid within LAYOUT_LIMITS; at most `maxRooms` rooms; unique room ids;
 * - every footprint inside the grid, every interior inside the outer wall ring;
 * - no room's interior intersects another room's footprint (walls may be shared, floors may not);
 * - interior at least ROOM_MIN_INTERIOR[type];
 * - exactly one entrance; 1..maxStairs stairs rooms.
 * Warnings: entrance not touching the outer wall (no front door is drawn), zones without a room
 * (agents use ZONE_FALLBACKS). Connectivity is checked by the generator (`no-door`, `unreachable-*`).
 */
export function validateLayout(layout: LayoutGeometry): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const err = (code: LayoutIssueCode, message: string, roomIds?: string[]) =>
    issues.push({ severity: 'error', code, message, ...(roomIds && { roomIds }) });
  const warn = (code: LayoutIssueCode, message: string, roomIds?: string[]) =>
    issues.push({ severity: 'warning', code, message, ...(roomIds && { roomIds }) });

  const { width: W, height: H, rooms } = layout;
  const L = LAYOUT_LIMITS;
  const intIn = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!intIn(W, L.minWidth, L.maxWidth) || !intIn(H, L.minHeight, L.maxHeight)) {
    err('grid-size', `Grid must be ${L.minWidth}-${L.maxWidth} x ${L.minHeight}-${L.maxHeight} tiles (got ${W} x ${H}).`);
  }
  if (rooms.length > L.maxRooms) err('too-many-rooms', `At most ${L.maxRooms} rooms (got ${rooms.length}).`);

  const seen = new Map<string, number>();
  for (const r of rooms) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) err('duplicate-id', `Room id "${id}" is used ${n} times.`, [id]);

  const interiors = rooms.map((r) => roomInterior(r));
  rooms.forEach((r, i) => {
    const inner = interiors[i]!;
    const footprintOk = r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= W && r.y + r.h <= H;
    const interiorOk = inner.x >= 1 && inner.y >= 1 && inner.x + inner.w <= W - 1 && inner.y + inner.h <= H - 1;
    if (!footprintOk || !interiorOk) err('out-of-bounds', `${label(r)} must stay inside the outer wall.`, [r.id]);
    const min = ROOM_MIN_INTERIOR[r.type];
    if (inner.w < min.w || inner.h < min.h) {
      err('too-small', `${label(r)} needs at least ${min.w} x ${min.h} floor tiles inside its walls (has ${inner.w} x ${inner.h}).`, [r.id]);
    }
  });

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i]!;
      const b = rooms[j]!;
      if (rectsIntersect(interiors[i]!, b) || rectsIntersect(interiors[j]!, a)) {
        err('overlap', `${label(a)} overlaps ${label(b)} (only walls may be shared).`, [a.id, b.id]);
      }
    }
  }

  const entrances = rooms.filter((r) => r.type === 'entrance');
  if (entrances.length !== 1) {
    err('entrance-count', `A floor needs exactly one entrance (has ${entrances.length}).`, entrances.map((r) => r.id));
  }
  const stairs = rooms.filter((r) => r.type === 'stairs');
  if (stairs.length === 0) err('stairs-missing', 'A floor needs at least one stairs room.');
  if (stairs.length > L.maxStairs) err('too-many-stairs', `At most ${L.maxStairs} stairs rooms (has ${stairs.length}).`, stairs.map((r) => r.id));

  const entrance = entrances.length === 1 ? entrances[0] : undefined;
  if (entrance) {
    const e = roomInterior(entrance);
    const onEdge = e.x === 1 || e.y === 1 || e.x + e.w === W - 1 || e.y + e.h === H - 1;
    if (!onEdge) warn('entrance-not-on-edge', 'The entrance does not touch the outer wall, so no front door is drawn.', [entrance.id]);
  }

  const present = new Set<RoomType>(rooms.map((r) => r.type));
  const missing = ZONES.filter((z) => z !== 'entrance' && !present.has(z));
  if (missing.length) {
    const detail = missing.map((z) => `${z} → ${resolveZone(z, present)}`).join(', ');
    warn('zone-missing', `No room for: ${detail}.`);
  }
  // Doors (M8 8n): only on walled rooms, inside the side excluding corners, no overlaps on a side.
  for (const r of rooms) {
    if (!r.doors) continue;
    const name = r.name ?? r.type;
    if (!isRoomWalled(r)) {
      if (r.doors.length > 0) err('door-invalid', `${name}: doors only apply to walled rooms.`, [r.id]);
      continue;
    }
    if (r.doors.length === 0 && r.type !== 'entrance') {
      warn('room-sealed', `${name} has no doors; nobody can reach it.`, [r.id]);
    }
    const spans: Record<DoorSide, [number, number][]> = { n: [], s: [], e: [], w: [] };
    for (const d of r.doors) {
      const len = d.side === 'n' || d.side === 's' ? r.w : r.h;
      const width = d.width ?? 1;
      if (d.offset < 1 || d.offset + width > len - 1) {
        err('door-invalid', `${name}: a ${d.side.toUpperCase()} door must stay between the corners.`, [r.id]);
        continue;
      }
      const span: [number, number] = [d.offset, d.offset + width - 1];
      if (spans[d.side].some(([a, b]) => span[0] <= b && a <= span[1])) {
        err('door-overlap', `${name}: two doors overlap on the ${d.side.toUpperCase()} side.`, [r.id]);
      }
      spans[d.side].push(span);
    }
  }

  return issues;
}

export const hasLayoutErrors = (issues: readonly LayoutIssue[]): boolean => issues.some((i) => i.severity === 'error');

// ------------------------------------------------------------------ built-in default

export const DEFAULT_LAYOUT_ID = 'default';

/**
 * The classic 48x30 office (same rooms as the pre-M7 map) plus a stairs landing next to the
 * entrance. Seeded by the server as a builtin; also used by the web demo mode and as the fallback
 * when a project's layout is missing.
 */
export const DEFAULT_LAYOUT: OfficeLayout = {
  id: DEFAULT_LAYOUT_ID,
  name: 'Classic Hall',
  width: 48,
  height: 30,
  seed: 1337,
  background: 'hall',
  corridorWidth: 2,
  builtin: true,
  createdAt: 0,
  updatedAt: 0,
  rooms: [
    { id: 'pm-office', type: 'pm-office', x: 0, y: 0, w: 11, h: 9 },
    { id: 'meeting-room', type: 'meeting-room', x: 10, y: 0, w: 13, h: 9 },
    { id: 'whiteboard', type: 'whiteboard', x: 23, y: 1, w: 8, h: 7 },
    { id: 'library', type: 'library', x: 31, y: 0, w: 17, h: 9 },
    { id: 'desks', type: 'desks', x: 1, y: 10, w: 27, h: 10 },
    { id: 'review-booth', type: 'review-booth', x: 29, y: 10, w: 9, h: 10 },
    { id: 'qa-lab', type: 'qa-lab', x: 38, y: 10, w: 10, h: 10 },
    { id: 'lounge', type: 'lounge', x: 1, y: 22, w: 13, h: 7 },
    { id: 'entrance', type: 'entrance', x: 17, y: 22, w: 10, h: 7 },
    { id: 'server-room', type: 'server-room', x: 30, y: 21, w: 18, h: 9 },
    { id: 'stairs', type: 'stairs', x: 27, y: 25, w: 3, h: 3 },
  ],
};

// ------------------------------------------------------------------ API payloads

/** Body of `PATCH /api/projects/:id` / `layouts:assign`: null clears (use `office.defaultLayoutId`). */
export const LayoutAssignSchema = z.object({
  projectId: z.string().min(1),
  layoutId: z.string().regex(LAYOUT_ID_RE).nullable(),
});
export type LayoutAssign = z.infer<typeof LayoutAssignSchema>;
