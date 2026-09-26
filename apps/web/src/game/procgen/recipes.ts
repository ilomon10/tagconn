import type { FurnishDensity, RoomType } from '@tagconn/shared';
import type { FurnitureKind, Rect } from './types';

export interface RecipeItem {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  blocking: boolean;
  variant: number;
}
export interface RecipeSeat {
  x: number;
  y: number;
  kind: 'sit' | 'stand';
}

/** Per-room furnishing knobs, resolved from `LayoutRoom.furnish` / `OfficeLayout.furnishDefaults`
 *  (precedence: per-room, then layout-wide, then these built-ins) by `generate.ts` before calling
 *  `furnishRoom`. See `packages/shared/src/layout.ts` `RoomFurnishSchema` and guild-hall.md section 4. */
export interface FurnishOptions {
  density: FurnishDensity;
  /** 0 = none .. 1 = lavish. Scales how many plants/rugs/lamps/crates/banners/wall-art/bins get added. */
  decor: number;
  /** Minimum walkway width between furniture rows, in tiles (1-3). */
  aisle: number;
  /** Target seat/workstation count; undefined = let density decide. */
  seatsTarget?: number;
}
export interface RecipeResult {
  furniture: RecipeItem[];
  seats: RecipeSeat[];
  /** Set when `seatsTarget` was requested but the room could only fit fewer (generate.ts turns this
   *  into an `unreachable-seat` warning issue: the closest existing code for "a seat didn't work out"). */
  seatsShortfall?: { wanted: number; fit: number };
}

/**
 * Row-fill plan per density: `stack` rows are packed back-to-back sharing a single `aisle` gap after
 * the whole stack (e.g. a server room's cold/hot aisle sits between two racks, not after every single
 * rack), and `colGap` is the gap left between items along a row. Coverage rises with `stack` (less of
 * the room spent on aisles) and falls with `colGap`; `fillRows` also always reserves one full-height
 * "spine" column so a `colGap` of 0 can never wall a row off from its neighbours (M8 8n: this is what
 * lets `dense`/`packed` push coverage well past what a naive `colGap: 0` grid could safely reach).
 */
const DENSITY_PLAN: Record<FurnishDensity, { stack: number; colGap: number }> = {
  sparse: { stack: 1, colGap: 1 },
  normal: { stack: 2, colGap: 1 },
  dense: { stack: 4, colGap: 0 },
  packed: { stack: 10, colGap: 0 },
};

/**
 * Generic row filler (guild-hall.md section 4 step 8, generalised for density): tiles `itemW x
 * itemH` blocking items left-to-right across `r`'s width, `stack` rows deep before the next `aisle`
 * gap (guild-hall.md 8n's cold/hot aisle pattern - one walkway per stack, not per row). One column is
 * always left as a full-height gap (skipped even at `colGap: 0`) so every stacked row band is still
 * reachable from the next one without depending on the room's width happening to leave a remainder.
 * Returns the top-left of every item (`itemH` apart within a stack) plus `atStart`/`atEnd`: whether
 * it is the first/last row of its stack, so a caller can seat the outward (aisle-facing) side of a
 * stack only, instead of trying to seat a row that is sandwiched between two other items.
 *
 * Always insets `r` by 1 tile on every side first (when there's room to spare): a door can open onto
 * any point of a room's wall, so furniture packed flush against the interior's very first row/column
 * can box a door in on three sides with nothing left but the one gap the door itself reserves (M8 8n
 * regression: a dense library's shelves did exactly this and the local reachability retry had to
 * strip most of the room before it found the one item actually sealing the door off). A 1-tile
 * perimeter walkway means a door always opens onto open floor that already wraps the whole room.
 */
interface RowSlot {
  x: number;
  y: number;
  atStart: boolean;
  atEnd: boolean;
}
function fillRows(rOuter: Rect, itemW: number, itemH: number, aisle: number, density: FurnishDensity): RowSlot[] {
  const canInset = rOuter.w > itemW + 2 && rOuter.h > itemH + 2;
  const r: Rect = canInset ? { x: rOuter.x + 1, y: rOuter.y + 1, w: rOuter.w - 2, h: rOuter.h - 2 } : rOuter;
  const { stack, colGap } = DENSITY_PLAN[density];
  const colPitch = itemW + colGap;
  const stackHeight = itemH * stack;
  const rowPitch = stackHeight + aisle;
  const spineX = r.x + Math.max(0, r.w - 1); // reserved full-height gap, never covered by an item
  const out: RowSlot[] = [];
  for (let y = r.y; y + itemH <= r.y + r.h; y += rowPitch) {
    const rowsInStack = Math.min(stack, Math.floor((r.y + r.h - y) / itemH));
    for (let x = r.x; x + itemW <= r.x + r.w; x += colPitch) {
      if (x <= spineX && x + itemW > spineX) continue; // would cover the spine
      for (let s = 0; s < rowsInStack; s++) {
        out.push({ x, y: y + itemH * s, atStart: s === 0, atEnd: s === rowsInStack - 1 });
      }
    }
  }
  return out;
}

/** Collapses a stack of 1-tall `fillRows` slots at the same column back into one tall rect (a
 *  server room's rack-row is naturally "however many 1-tall slots the stack contains", not one item
 *  per slot) - relies on `fillRows` emitting a stack's slots consecutively, in `atStart..atEnd` order. */
function mergeStacks(positions: readonly RowSlot[]): { x: number; y: number; h: number }[] {
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

/**
 * Furniture + seat recipes per room type, scaled by `FurnishOptions` (M8 8n: the user report that
 * rooms - especially the server room - were mostly empty despite free floor). `rand` is the room's
 * own seeded stream (`room:<id>` or `room:<id>:<furnish.seed>`), so editing one room's density never
 * reshuffles another room's, and re-rolling a room's `furnish.seed` never touches the layout seed.
 */
export function furnishRoom(type: RoomType, r: Rect, rand: () => number, opts: FurnishOptions): RecipeResult {
  const furniture: RecipeItem[] = [];
  const seats: RecipeSeat[] = [];
  const x2 = r.x + r.w - 1;
  const y2 = r.y + r.h - 1;
  const { density, aisle } = opts;
  const block = (kind: FurnitureKind, x: number, y: number, w = 1, h = 1) =>
    furniture.push({ kind, x, y, w, h, blocking: true, variant: Math.floor(rand() * 4) });
  const soft = (kind: FurnitureKind, x: number, y: number, w = 1, h = 1) =>
    furniture.push({ kind, x, y, w, h, blocking: false, variant: Math.floor(rand() * 4) });
  const sit = (x: number, y: number) => seats.push({ x, y, kind: 'sit' });
  const stand = (x: number, y: number) => seats.push({ x, y, kind: 'stand' });
  /** A stack's occupant only gets a seat on the side that actually faces a walkway: the row before
   *  the first item in a stack, or the row after the last one (never a row sandwiched between two
   *  stacked items - that seat would just get filtered out as blocked anyway). */
  const seatOutward = (p: RowSlot, itemH: number): number | null => {
    if (p.atEnd) {
      const sy = p.y + itemH;
      if (sy <= y2) return sy;
    }
    if (p.atStart) {
      const sy = p.y - 1;
      if (sy >= r.y) return sy;
    }
    return null;
  };

  switch (type) {
    case 'desks': {
      // A 2x1 desk with a chair on its outward side; `dense`/`packed` stack several desk rows back
      // to back (M8 8n) so a big desks room fills by density instead of leaving a fixed gap.
      const positions = fillRows({ x: r.x, y: r.y, w: r.w, h: r.h }, 2, 1, aisle, density);
      for (const p of positions) {
        if (p.x + 1 > x2) continue;
        block('work-desk', p.x, p.y, 2, 1);
        const seatY = seatOutward(p, 1);
        if (seatY !== null) {
          sit(p.x, seatY);
          sit(p.x + 1, seatY);
        }
      }
      break;
    }
    case 'meeting-room': {
      // The table is sized to the room (guild-hall.md 8n): the margin around it is a FRACTION of the
      // room's shorter side (not a fixed tile count), so coverage stays in the same density band
      // whether the room is small or large - a fixed-tile margin shrinks to nothing (over)filling a
      // big room, or swallows a small one.
      const MARGIN_FRACTION: Record<FurnishDensity, number> = { sparse: 0.24, normal: 0.16, dense: 0.1, packed: 0.04 };
      const margin = Math.max(1, Math.round(Math.min(r.w, r.h) * MARGIN_FRACTION[density]));
      const tx = r.x + margin;
      const ty = r.y + margin;
      const tw = Math.max(1, r.w - margin * 2);
      const th = Math.max(1, r.h - margin * 2);
      block('table', tx, ty, tw, th);
      for (let x = tx; x < tx + tw; x++) {
        sit(x, ty - 1);
        sit(x, ty + th);
      }
      for (let y = ty; y < ty + th; y++) {
        sit(tx - 1, y);
        sit(tx + tw, y);
      }
      soft('plant', r.x, r.y);
      if (density !== 'sparse') soft('plant', x2, r.y);
      break;
    }
    case 'whiteboard': {
      block('board', r.x + 1, r.y, Math.max(1, r.w - 2), 1);
      // Standing tables (M8 8n) fill the floor by density instead of a single fixed centerpiece.
      const positions = fillRows({ x: r.x + 1, y: r.y + 2, w: r.w - 2, h: r.h - 2 }, 2, 1, aisle, density);
      for (const p of positions) {
        if (p.x + 1 > x2 - 1) continue;
        block('standing-table', p.x, p.y, 2, 1);
        const sy = seatOutward(p, 1);
        if (sy !== null) {
          stand(p.x, sy);
          stand(p.x + 1, sy);
        }
      }
      break;
    }
    case 'pm-office': {
      block('lead-desk', r.x + 2, r.y + 2, 3, 1);
      sit(r.x + 3, r.y + 1);
      soft('rug', r.x + 2, r.y + 4, 4, 2);
      // Meeting corner: a small standing table + chairs.
      stand(r.x + 2, r.y + 4);
      stand(r.x + 4, r.y + 4);
      stand(r.x + 3, r.y + 5);
      soft('plant', x2, r.y);
      block('cabinet', x2, r.y);
      block('shelf', x2 - 2 >= r.x ? x2 - 2 : x2, r.y);
      // Extra desks (M8 8n) for the lead's team, below the meeting corner, scaled by room size and
      // density the same way a `desks` room is - a bigger PM office gets more of them instead of the
      // same fixed handful regardless of size.
      if (r.h > 7) {
        const positions = fillRows({ x: r.x, y: r.y + 7, w: r.w, h: r.h - 7 }, 2, 1, aisle, density);
        for (const p of positions) {
          if (p.x + 1 > x2) continue;
          block('work-desk', p.x, p.y, 2, 1);
          const sy = seatOutward(p, 1);
          if (sy !== null) {
            sit(p.x, sy);
            sit(p.x + 1, sy);
          }
        }
      }
      break;
    }
    case 'library': {
      // Shelf stacks fill the room in rows (M8 8n), scaled by density; a reading table near the
      // middle plus armchairs in the corners so there's always somewhere to sit and read.
      const positions = fillRows({ x: r.x, y: r.y, w: r.w, h: r.h }, Math.min(r.w, 3), 1, aisle, density);
      for (const p of positions) {
        const w = Math.min(3, x2 - p.x + 1);
        block('shelf-stack', p.x, p.y, w, 1);
        const sy = seatOutward(p, 1);
        if (sy !== null) for (let x = p.x; x < p.x + w; x += 2) stand(x, sy);
      }
      if (r.w >= 5 && r.h >= 4) {
        const tx = r.x + Math.max(1, Math.floor(r.w / 2) - 1);
        block('reading-table', tx, y2 - 1, 2, 1);
        sit(tx, y2);
        sit(tx + 1, y2);
      }
      soft('armchair', r.x + 1, y2);
      soft('armchair', x2 - 1, y2);
      sit(r.x + 1, y2);
      sit(x2 - 1, y2);
      break;
    }
    case 'qa-lab': {
      // Full-width lab benches, stacked front to back by density; a piece of test equipment in the corner.
      const benchW = Math.max(1, r.w - 2);
      const positions = fillRows({ x: r.x, y: r.y, w: r.w, h: r.h }, benchW, 1, aisle, density);
      for (const p of positions) {
        const kind: FurnitureKind = density === 'sparse' ? 'workbench' : 'lab-bench';
        block(kind, p.x, p.y, benchW, 1);
        const sy = seatOutward(p, 1);
        if (sy !== null) for (let x = p.x; x < p.x + benchW; x += 2) stand(x, sy);
      }
      if (r.w >= 5 && r.h >= 5) block('equipment', x2 - 1, y2 - 1, 2, 2);
      break;
    }
    case 'review-booth': {
      const positions = fillRows({ x: r.x, y: r.y, w: r.w, h: r.h }, 1, 1, aisle, density);
      for (const p of positions) {
        block('booth', p.x, p.y);
        const sy = seatOutward(p, 1);
        if (sy !== null) sit(p.x, sy);
      }
      if (density !== 'sparse') soft('chair', r.x, y2);
      break;
    }
    case 'server-room': {
      // Rows of racks with a shared cold/hot aisle between back-to-back pairs (M8 8n: the user's
      // literal complaint - "server racks in the server room are mostly empty"). Each column is one
      // `rack-row`, as tall as the density's stack depth allows; a console desk stays clear of them.
      const positions = fillRows({ x: r.x, y: r.y, w: r.w, h: r.h }, 1, 1, aisle, density);
      for (const group of mergeStacks(positions)) {
        block('rack-row', group.x, group.y, 1, group.h);
        const below = group.y + group.h;
        const above = group.y - 1;
        if (below <= y2) stand(group.x, below);
        else if (above >= r.y) stand(group.x, above);
      }
      block('console', x2, y2);
      sit(x2 - 1 >= r.x ? x2 - 1 : x2, y2);
      if (r.w >= 5 && r.h >= 5) soft('sigil', r.x, r.y);
      break;
    }
    case 'lounge': {
      soft('sofa', r.x + 1, r.y + 1, Math.max(1, Math.min(4, r.w - 2)), 1);
      for (let x = r.x + 1; x < r.x + 1 + Math.max(1, Math.min(4, r.w - 2)); x++) sit(x, r.y + 1);
      block('table', r.x + 2, r.y + 3, 2, 1);
      soft('armchair', r.x + 5 <= x2 ? r.x + 5 : x2, r.y + 3);
      sit(r.x + 5 <= x2 ? r.x + 5 : x2, r.y + 3);
      block('counter', x2 - 1, r.y);
      stand(x2 - 1, r.y + 1);
      stand(x2 - 2 >= r.x ? x2 - 2 : x2 - 1, r.y + 2);
      soft('plant', x2, y2);
      soft('plant', r.x, y2);
      soft('rug', r.x + 1, r.y + 2, Math.max(1, Math.min(5, r.w - 2)), 3);
      // Extra tables (M8 8n) fill the remaining floor by density, at every density level (not just
      // dense/packed) so a `sparse` lounge still reads as furnished rather than nearly bare.
      if (r.h > 5) {
        const extra = fillRows({ x: r.x, y: r.y + 4, w: r.w, h: r.h - 4 }, 2, 1, aisle, density);
        for (const p of extra) {
          if (p.x + 1 > x2 - 1) continue;
          block('table', p.x, p.y, 2, 1);
          const sy = seatOutward(p, 1);
          if (sy !== null) {
            stand(p.x, sy);
            stand(p.x + 1, sy);
          }
        }
      } else {
        for (let x = r.x + 2; x <= x2 - 2; x += 2) stand(x, y2 - 1);
      }
      break;
    }
    case 'entrance': {
      const cx = r.x + Math.floor(r.w / 2);
      soft('mat', cx - 1, y2, 2, 1);
      block('reception-desk', r.x + 1, r.y, Math.max(1, Math.min(3, r.w - 2)), 1);
      sit(r.x + 1, r.y + 1);
      soft('plant', r.x, r.y);
      soft('plant', x2, r.y);
      // Benches (M8 8n) fill the floor by density instead of a fixed stand-grid - blocking, like a
      // real bench, with standing room on the outward (walkway) side of each row/stack.
      const positions = fillRows({ x: r.x, y: r.y + 2, w: r.w, h: r.h - 3 }, 2, 1, aisle, density);
      for (const p of positions) {
        if (p.x + 1 > x2) continue;
        block('bench', p.x, p.y, 2, 1);
        const sy = seatOutward(p, 1);
        if (sy !== null) {
          stand(p.x, sy);
          stand(p.x + 1, sy);
        }
      }
      break;
    }
    // 'stairs' and 'hall' have no furniture recipe: stairs get stairs-up/down in generate.ts (and
    // stay clear so the landing is never blocked), and hall is corridor/open floor with decor only.
    default:
      break;
  }

  // De-duplicate by tile (M8 8n): adjacent stacks sharing a single-tile aisle can each try to seat
  // their outward side into that same one row (the previous stack's "after" seat and the next one's
  // "before" seat land on the same tile when `aisle` is 1), which would otherwise hand the allocator
  // two Seat entries for one walkable tile.
  const seenSeatKeys = new Set<string>();
  const dedupedSeats = seats.filter((s) => {
    const k = `${s.x},${s.y}`;
    if (seenSeatKeys.has(k)) return false;
    seenSeatKeys.add(k);
    return true;
  });

  let seatsShortfall: RecipeResult['seatsShortfall'];
  if (opts.seatsTarget !== undefined && dedupedSeats.length < opts.seatsTarget) {
    seatsShortfall = { wanted: opts.seatsTarget, fit: dedupedSeats.length };
  }
  return { furniture, seats: dedupedSeats, seatsShortfall };
}

/**
 * Decoration pass (M8 8n): plants/rugs/lamps/crates/banners/wall-art/bins along walls and corners,
 * scaled by `decor` (0..1). Never blocking, and only on cells the caller says are free (not already
 * furniture, a seat, or a door apron). Called after the main recipe and after the reachability retry,
 * so it can never be the thing that seals off a seat.
 */
const DECOR_KINDS: FurnitureKind[] = ['plant', 'rug', 'lamp', 'crate', 'banner', 'wall-art', 'bin'];

export function decorateRoom(
  r: Rect,
  freeCells: readonly { x: number; y: number }[],
  decor: number,
  rand: () => number,
): RecipeItem[] {
  if (decor <= 0 || freeCells.length === 0) return [];
  const perimeter = 2 * (r.w + r.h);
  const count = Math.min(freeCells.length, Math.round(perimeter * decor * 0.25));
  const pool = [...freeCells];
  const out: RecipeItem[] = [];
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(rand() * pool.length);
    const cell = pool.splice(idx, 1)[0]!;
    const kind = DECOR_KINDS[Math.floor(rand() * DECOR_KINDS.length)]!;
    out.push({ kind, x: cell.x, y: cell.y, w: 1, h: 1, blocking: false, variant: Math.floor(rand() * 4) });
  }
  return out;
}
