// apps/web/src/game/procgen/pins.ts  (M12 G4, docs/design/game-office.md section 5.2)
//
// Pure helpers for `LayoutRoom.furniture` (items the user locked in place in the Hall Planner):
// which kinds may be pinned, whether a kind blocks walking, and the absolute-coordinate pins one room
// contributes to `generate.ts`'s room loop. Pins are placed before the procedural recipe and are never
// removed by the reachability retry.
import type { Facing, LayoutIssue, LayoutRoom } from '@tagconn/shared';
import { facingSupported } from './facingSpec';
import { cellKeys, isHalfAligned, overlapsAny } from './geometry';
import type { RecipeItem } from './recipes';
import type { FurnitureKind, Rect } from './types';

/** Whether a kind blocks walking, matching what `recipes.ts` / `backWall.ts` / `triggers.ts` place it as. Exhaustive. */
export const KIND_BLOCKING: Record<FurnitureKind, boolean> = {
  'work-desk': true,
  'lead-desk': true,
  table: true,
  board: true,
  workbench: true,
  booth: true,
  rack: true,
  shelf: true,
  sofa: false,
  armchair: false,
  rug: false,
  mat: false,
  counter: true,
  plant: false,
  centerpiece: true,
  pedestal: true,
  sigil: false,
  'stairs-up': true,
  'stairs-down': true,
  'rack-row': true,
  console: true,
  'lab-bench': true,
  equipment: true,
  'shelf-stack': true,
  'reading-table': true,
  'standing-table': true,
  'reception-desk': true,
  bench: true,
  lamp: false,
  crate: false,
  'wall-art': false,
  bin: false,
  cabinet: true,
  chair: false,
  banner: false,
  printer: true,
  fridge: true,
  'water-cooler': true,
  'filing-cabinet': true,
  'coffee-machine': true,
  bookcase: true,
  fireplace: true,
  'coat-rack': true,
  'supply-stack': true,
  cage: true,
  'notice-board': true,
  'roster-board': true,
  arcade: true,
  'ping-pong': true,
  foosball: true,
  'board-game-table': true,
};

/** Every kind except the stairs (their landing is owned by `generate.ts`). */
export function isPinnableKind(kind: string): kind is FurnitureKind {
  return Object.prototype.hasOwnProperty.call(KIND_BLOCKING, kind) && kind !== 'stairs-up' && kind !== 'stairs-down';
}

export interface ResolvedPins {
  items: (RecipeItem & { pinned: true })[];
  /** M16: every `fromSlot` the room's pins name (suppressed ghosts included): the recipe must not place those slots again. */
  consumed: Set<string>;
  issues: LayoutIssue[];
}

/**
 * Absolute-coord pins for one room. `interior` is the room's absolute interior rect and `aprons` the
 * "x,y" keys of its door aprons. Skips (with a `pinned-invalid` WARNING) unknown kinds, items off the
 * half-tile grid (the schema already enforces it; this is the defensive path for hand-edited files), items
 * outside the interior, and items overlapping an earlier pin (exact rect overlap, so two half-offset pins may
 * share a tile without overlapping). A blocking pin covering a door apron (explicit or automatic) is skipped
 * with a `pinned-blocks` warning, so locked furniture can never seal a room; conservative with half tiles (any
 * covered apron tile seals). Emitted items keep their fractional `x`/`y` and whole `w`/`h`. Never throws.
 *
 * M16 (furnishing.md 3.4): a blocking pin over an apron is KEPT and reported `pinned-blocks` (the reachability report
 * shows what it seals) instead of skipped. `fromSlot` is collected into `consumed`; a `suppressed` pin is validated for kind
 * only, consumes its slot and is never placed. An unsupported `facing` falls back silently (no issue).
 */
export function resolvePins(
  room: Pick<LayoutRoom, 'id' | 'name' | 'type' | 'furniture'>,
  interior: Rect,
  aprons: ReadonlySet<string>,
): ResolvedPins {
  const items: ResolvedPins['items'] = [];
  const issues: LayoutIssue[] = [];
  const consumed = new Set<string>();
  const pins = room.furniture;
  if (!pins?.length) return { items, consumed, issues };
  const name = room.name ?? room.type;
  const taken: Rect[] = [];
  for (const f of pins) {
    if (!isPinnableKind(f.kind)) {
      issues.push({ severity: 'warning', code: 'pinned-invalid', message: `${name}: a locked ${f.kind} is not a known furniture kind and was skipped.`, roomIds: [room.id] });
      continue;
    }
    if (f.suppressed) {
      if (f.fromSlot) consumed.add(f.fromSlot);
      continue;
    }
    if (!isHalfAligned(f) || f.w < 1 || f.h < 1) {
      issues.push({ severity: 'warning', code: 'pinned-invalid', message: `${name}: a locked ${f.kind} is off the half-tile grid and was skipped.`, roomIds: [room.id] });
      continue;
    }
    const abs: Rect = { x: interior.x + f.x, y: interior.y + f.y, w: f.w, h: f.h };
    if (f.x < 0 || f.y < 0 || f.x + f.w > interior.w || f.y + f.h > interior.h) {
      issues.push({ severity: 'warning', code: 'pinned-invalid', message: `${name}: a locked ${f.kind} sits outside the room and was skipped.`, roomIds: [room.id] });
      continue;
    }
    if (overlapsAny(abs, taken)) {
      issues.push({ severity: 'warning', code: 'pinned-invalid', message: `${name}: a locked ${f.kind} overlaps another locked item and was skipped.`, roomIds: [room.id] });
      continue;
    }
    // A blocking pin on a door apron (explicit OR automatic door) may seal the room: it is kept (the user placed it) and
    // reported; the global verify then flags any room it cuts off. Covered tiles, so a half-offset pin touching the apron counts.
    if (KIND_BLOCKING[f.kind] && cellKeys(abs).some((c) => aprons.has(c))) {
      issues.push({ severity: 'warning', code: 'pinned-blocks', message: `${name}: a locked ${f.kind} covers a door.`, roomIds: [room.id] });
    }
    taken.push(abs);
    if (f.fromSlot) consumed.add(f.fromSlot);
    const facing: Facing | undefined = f.facing && f.facing !== 's' && facingSupported(f.kind, f.facing) ? f.facing : undefined;
    items.push({ kind: f.kind, ...abs, blocking: KIND_BLOCKING[f.kind], variant: f.variant ?? 0, ...(facing && { facing }), pinned: true });
  }
  return { items, consumed, issues };
}

/** One pin issue per room + code (a bad pin is otherwise reported by both `validateLayout` and `resolvePins`); other issues pass through. */
export function dedupePinIssues(issues: readonly LayoutIssue[]): LayoutIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    if (!i.code.startsWith('pinned-')) return true;
    const k = `${i.code}|${(i.roomIds ?? []).join(',')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
