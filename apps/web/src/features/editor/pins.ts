import { HALF_TILE, LAYOUT_LIMITS, coveredTileRect, isRoomWalled, roomInterior, type LayoutRoom, type PinnedFurniture } from '@tagconn/shared';
import type { GeneratedMap, PlacedFurniture } from '../../game/procgen';

/**
 * Pure helpers for locking furniture in the Hall Planner (M12, docs/design/game-office.md section 5.4).
 * Pins are interior-relative (`PinnedFurniture`); generated items are absolute world tiles. M15
 * (docs/design/navigation.md section 3.2): pin positions are multiples of `HALF_TILE`, sizes stay
 * whole, so hit-testing takes a fractional world point. Nothing here touches the store, so the store
 * can import it (prunePins) without a cycle.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An item under the cursor: a pin of the draft or a generated item of the map. */
export interface FurnitureHit {
  room: LayoutRoom;
  /** Absolute world-tile rect, kind and variant of the item. */
  item: Rect & { kind: string; variant?: number };
  /** Index into `room.furniture` when the item is a pin, else null (generated). */
  pinIndex: number | null;
}

/** Max pin size, from `PinnedFurnitureSchema`. */
const MAX_PIN_SIDE = 8;

/** Stairs keep their landing free; they are never pinnable. */
export function isPinnableKind(kind: string): boolean {
  return kind !== 'stairs-up' && kind !== 'stairs-down';
}

/** False for stairs and for items wider/taller than a pin may be ("Too large to lock"). */
export function isPinnableItem(item: { kind: string; w: number; h: number }): boolean {
  return isPinnableKind(item.kind) && item.w <= MAX_PIN_SIDE && item.h <= MAX_PIN_SIDE;
}

/** Why an item cannot be locked, for the planner's hint; null when it can. */
export function unpinnableReason(item: { kind: string; w: number; h: number }): string | null {
  if (!isPinnableKind(item.kind)) return 'Stairs cannot be locked';
  if (item.w > MAX_PIN_SIDE || item.h > MAX_PIN_SIDE) return 'Too large to lock';
  return null;
}

/** A generated item as an interior-relative pin. */
export function pinFromPlaced(item: Rect & { kind: string; variant?: number }, interior: Rect): PinnedFurniture {
  const pin: PinnedFurniture = { kind: item.kind, x: item.x - interior.x, y: item.y - interior.y, w: item.w, h: item.h };
  if (item.variant !== undefined) pin.variant = item.variant;
  return pin;
}

/** A pin as an absolute world-tile rect. */
export function pinToWorld(pin: PinnedFurniture, interior: Rect): Rect & { kind: string; variant?: number } {
  return { kind: pin.kind, x: interior.x + pin.x, y: interior.y + pin.y, w: pin.w, h: pin.h, ...(pin.variant !== undefined ? { variant: pin.variant } : {}) };
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * True when the pin covers the interior tile just inside one of the room's EXPLICIT doors (as
 * `validateLayout` checks). Conservative with half-tile positions: any covered apron tile seals the door.
 */
function onDoorApron(room: LayoutRoom, pin: Rect): boolean {
  if (!isRoomWalled(room) || !room.doors) return false;
  const iw = Math.max(0, room.w - 2);
  const ih = Math.max(0, room.h - 2);
  const c = coveredTileRect(pin);
  for (const d of room.doors) {
    const width = d.width ?? 1;
    for (let k = 0; k < width; k++) {
      const along = d.offset + k - 1;
      const tile = d.side === 'n' ? { x: along, y: 0 } : d.side === 's' ? { x: along, y: ih - 1 } : d.side === 'w' ? { x: 0, y: along } : { x: iw - 1, y: along };
      if (tile.x >= c.x && tile.x < c.x + c.w && tile.y >= c.y && tile.y < c.y + c.h) return true;
    }
  }
  return false;
}

/**
 * Whether `pin` may sit in `room` without making `validateLayout` complain: inside the interior,
 * clear of every other pin (except `ignoreIndex`, the pin being moved) and off explicit door aprons.
 */
export function pinFits(room: LayoutRoom, pin: PinnedFurniture, ignoreIndex?: number): boolean {
  const inner = roomInterior(room);
  if (pin.x < 0 || pin.y < 0 || pin.x + pin.w > inner.w || pin.y + pin.h > inner.h) return false;
  if ((room.furniture ?? []).some((p, i) => i !== ignoreIndex && intersects(p, pin))) return false;
  return !onDoorApron(room, pin);
}

/** Nearest multiple of `HALF_TILE` (M15: the pin position grid). `+ 0` turns `Math.round(-0.2) * 0.5` (-0) into 0. */
import { snapHalf } from '../../game/procgen/geometry';
/** Re-exported for the editor's callers/tests; the single implementation lives in procgen/geometry.ts. */
export { snapHalf };

/**
 * Snaps a pin's top-left to half tiles, then clamps it inside the room's interior (a pin larger than
 * it pins to 0). The clamp bound `inner.w - pin.w` is an integer (sizes are whole), so it keeps alignment.
 */
export function clampPinPos(room: LayoutRoom, pin: PinnedFurniture, pos: { x: number; y: number }): { x: number; y: number } {
  const inner = roomInterior(room);
  return {
    x: Math.max(0, Math.min(Math.max(0, inner.w - pin.w), snapHalf(pos.x))),
    y: Math.max(0, Math.min(Math.max(0, inner.h - pin.h), snapHalf(pos.y))),
  };
}

/**
 * Drops pins that no longer fit after the room changed (resize, type, walled, doors): outside the new
 * interior or on an explicit door apron. Returns the same object when nothing changed; `furniture`
 * becomes `undefined` once empty. `source` lets a drag prune from its pre-gesture pins so shrinking
 * and growing back within one gesture restores them.
 */
export function prunePins(room: LayoutRoom, source: readonly PinnedFurniture[] | undefined = room.furniture): LayoutRoom {
  if (!source?.length) return room;
  const inner = roomInterior(room);
  const kept = source.filter((p) => p.x + p.w <= inner.w && p.y + p.h <= inner.h && !onDoorApron(room, p));
  if (kept.length === source.length && source === room.furniture) return room;
  return { ...room, furniture: kept.length ? kept : undefined };
}

/** Topmost room whose footprint contains the world point (fractional or whole). */
function roomAt(rooms: readonly LayoutRoom[], at: { x: number; y: number }): LayoutRoom | undefined {
  for (let i = rooms.length - 1; i >= 0; i--) {
    const r = rooms[i]!;
    if (at.x >= r.x && at.x < r.x + r.w && at.y >= r.y && at.y < r.y + r.h) return r;
  }
  return undefined;
}

const covers = (r: Rect, t: { x: number; y: number }) => t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h;

/**
 * The topmost furniture item under a world point, pins first (they are read from the draft, so they
 * stay hittable whether or not the generator has rendered them yet), then generated items of the
 * map (later = on top). Generated items flagged `pinned` are skipped: their pin already answers.
 * M15: `at` may be fractional and real rect bounds are tested, so two half-offset items sharing a
 * tile are told apart (half-cell resolution).
 */
export function hitFurnitureAt(map: GeneratedMap | null, rooms: readonly LayoutRoom[], at: { x: number; y: number }): FurnitureHit | null {
  const room = roomAt(rooms, at);
  if (!room) return null;
  const inner = roomInterior(room);
  const pins = room.furniture ?? [];
  for (let i = pins.length - 1; i >= 0; i--) {
    const item = pinToWorld(pins[i]!, inner);
    if (covers(item, at)) return { room, item, pinIndex: i };
  }
  const furniture: readonly PlacedFurniture[] = map?.furniture ?? [];
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i]!;
    if (f.roomId !== room.id || f.pinned || !covers(f, at)) continue;
    return { room, item: { kind: f.kind, x: f.x, y: f.y, w: f.w, h: f.h, variant: f.variant }, pinIndex: null };
  }
  return null;
}

/**
 * Pins for "Lock all": every pinnable generated item of the room, deduped by kind + rect, skipping
 * any that would overlap an existing or earlier pin or sit on a door apron, capped so the room never
 * exceeds `LAYOUT_LIMITS.maxPinnedPerRoom`. `overflow` counts the items that would have fit but for the cap.
 */
export function planLockAll(map: GeneratedMap | null, room: LayoutRoom): { pins: PinnedFurniture[]; overflow: number } {
  const out: PinnedFurniture[] = [];
  if (!map) return { pins: out, overflow: 0 };
  const inner = roomInterior(room);
  const seen = new Set<string>();
  let overflow = 0;
  let probe: LayoutRoom = room;
  for (const f of map.furniture) {
    if (f.roomId !== room.id || f.pinned || !isPinnableItem(f)) continue;
    const pin = pinFromPlaced(f, inner);
    const key = `${pin.kind}:${pin.x},${pin.y},${pin.w},${pin.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!pinFits(probe, pin)) continue;
    if ((probe.furniture?.length ?? 0) >= LAYOUT_LIMITS.maxPinnedPerRoom) {
      overflow++;
      continue;
    }
    out.push(pin);
    probe = { ...probe, furniture: [...(probe.furniture ?? []), pin] };
  }
  return { pins: out, overflow };
}

export function pinsForLockAll(map: GeneratedMap | null, room: LayoutRoom): PinnedFurniture[] {
  return planLockAll(map, room).pins;
}
