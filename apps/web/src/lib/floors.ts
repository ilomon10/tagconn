import { MULTIVERSE_FLOOR_ID, type Project } from '@tagconn/shared';

/** How the stairs order floors (`settings.office.floorOrder`). */
export type FloorOrder = 'created' | 'name' | 'recent';

/** Distinct icon for the Multiverse floor entry (docs/design/living-office.md section 6.3: "an '∞'
 *  icon"), used by the floor picker and (once wired) the TopBar floor select. */
export const MULTIVERSE_ICON = '∞';

/**
 * The Multiverse (M8 8h) as a `Project`-shaped floor entry: it isn't a real project (nothing to
 * archive, rename or edit — no `cwd`), but every floor-list helper below works on `Project[]`, so
 * representing it this way lets `floorsInOrder`/stairs/hotkeys treat it like any other floor with
 * zero special-casing beyond checking `id === MULTIVERSE_FLOOR_ID` (`isMultiverseFloor`).
 */
export const MULTIVERSE_FLOOR: Project = {
  id: MULTIVERSE_FLOOR_ID,
  name: 'The Multiverse',
  cwd: '',
  archived: false,
  createdAt: 0,
  lastActivityAt: 0,
};

export const isMultiverseFloor = (id: string): boolean => id === MULTIVERSE_FLOOR_ID;

/**
 * Floors in stairs order (docs/design/guild-hall.md section 6), with the Multiverse always appended
 * last — "above the top floor" (docs/design/living-office.md section 6.3), regardless of
 * `floorOrder`, so the stairs' *up* direction from the top real floor always reaches it and its own
 * *down* stairs always return to that same top floor. Archived projects are hidden, except the one
 * currently selected — so archiving the floor you're standing on never strands the viewer mid-climb.
 * Index 0 is the ground floor.
 */
export function floorsInOrder(projects: Project[], order: FloorOrder, selectedId?: string): Project[] {
  const visible = projects.filter((p) => !p.archived || p.id === selectedId);
  const sorted = [...visible];
  switch (order) {
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'recent':
      sorted.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      break;
    case 'created':
    default:
      sorted.sort((a, b) => a.createdAt - b.createdAt);
      break;
  }
  sorted.push(MULTIVERSE_FLOOR);
  return sorted;
}

export const floorIndexOf = (floors: Project[], id: string): number => floors.findIndex((p) => p.id === id);

export interface FloorNeighbors {
  /** 0-based position of `id` in `floors`. */
  index: number;
  count: number;
  /** One floor up the stairs (a higher index), if any. */
  above?: Project;
  /** One floor down the stairs (a lower index), if any. */
  below?: Project;
}

/** Where `id` sits among `floors`, and its immediate stairs neighbors. Null if `id` isn't listed. */
export function floorNeighbors(floors: Project[], id: string): FloorNeighbors | null {
  const index = floorIndexOf(floors, id);
  if (index < 0) return null;
  return { index, count: floors.length, above: floors[index + 1], below: floors[index - 1] };
}

/** The floor reached by taking the stairs `dir`, or undefined at the ends (or if `id` isn't listed). */
export function neighborFloor(floors: Project[], id: string, dir: 'up' | 'down'): Project | undefined {
  const n = floorNeighbors(floors, id);
  return dir === 'up' ? n?.above : n?.below;
}

export const firstFloor = (floors: Project[]): Project | undefined => floors[0];
export const lastFloor = (floors: Project[]): Project | undefined => floors[floors.length - 1];

/**
 * The last *real* project floor, skipping the synthetic Multiverse entry `floorsInOrder` always
 * appends at the end. Design section 6.3: "End goes to the top project floor" — deliberately not
 * the Multiverse itself, unlike `lastFloor`. Undefined when there are no real floors yet.
 */
export function topProjectFloor(floors: Project[]): Project | undefined {
  for (let i = floors.length - 1; i >= 0; i--) {
    const f = floors[i];
    if (f && !isMultiverseFloor(f.id)) return f;
  }
  return undefined;
}

/**
 * True when a global hotkey (PageUp/PageDown/Home/End/F, ...) should be ignored because the event
 * target is mid-typing: a text-ish input, a textarea, a select, or a contenteditable element.
 * docs/design/guild-hall.md section 6: "ignored when focus is in an input, textarea, select, or
 * contenteditable ... or while the editor is open" — the editor's own keydown handler is
 * responsible for that last clause (it stops propagation while it's open).
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * True while a full-screen modal — the Hall Planner editor (`data-modal="hall-planner"`), or any
 * future dialog carrying `aria-modal="true"` or a `data-modal` attribute — covers the screen.
 * Global floor hotkeys and stairs clicks must no-op while one is open (docs/design/guild-hall.md
 * section 6). Checked via a DOM query rather than importing the editor's own store, so this stays
 * decoupled from files owned by that feature.
 */
export function isModalOpen(doc: Document = document): boolean {
  return !!doc.querySelector('[aria-modal="true"], [data-modal]');
}

/**
 * The next (`dir = 1`, `]`) or previous (`dir = -1`, `[`) index when cycling through `count` items,
 * wrapping at the ends — the M9 8f roster-cycling hotkeys in `OfficeView` (`useFloorAgents()`'s
 * order, the same array `Roster` renders). `current` outside `[0, count)` — nothing selected yet, or
 * a stale index for an agent that left — starts at the first item going forward or the last item
 * going backward. Returns -1 when `count` is 0 (nothing to select).
 */
export function cycleIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}
