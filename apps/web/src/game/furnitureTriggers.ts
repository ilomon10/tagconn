import type { FurnitureAction, FurnitureKind, GeneratedMap, PlacedFurniture } from './procgen/types';
import type { ThemeDefinition } from './themes/types';

/** M12 G3 (docs/design/game-office.md section 4): which placed furniture opens which panel. Pure, no Phaser. */

type StyleId = ThemeDefinition['id'];

/** Kinds that qualify as the trigger for each action (style-agnostic, D2). */
export const TRIGGER_KINDS: Record<FurnitureAction, readonly FurnitureKind[]> = {
  board: ['board'],
  log: ['bookcase', 'shelf-stack'],
  quests: ['notice-board'],
  settings: ['console'],
  heroes: ['roster-board'],
  receptionist: ['reception-desk'],
  infirmary: ['coffee-machine', 'water-cooler'],
};

/** The item procgen places when a floor has none of the qualifying kinds (the receptionist desk and the infirmary are never placed). */
export const TRIGGER_PLACE: Record<Exclude<FurnitureAction, 'receptionist' | 'infirmary'>, { kind: FurnitureKind; w: 1 | 2 }> = {
  board: { kind: 'board', w: 2 },
  log: { kind: 'bookcase', w: 2 },
  quests: { kind: 'notice-board', w: 1 },
  settings: { kind: 'console', w: 1 },
  heroes: { kind: 'roster-board', w: 1 },
};

export const TRIGGER_ORDER: readonly FurnitureAction[] = ['receptionist', 'board', 'log', 'quests', 'settings', 'heroes', 'infirmary'];

/** The panel each action opens and the menu hotkey that also opens it (a test pins these to `MENU_HOTKEYS`). */
export const TRIGGER_PANEL: Record<FurnitureAction, { panel: string; hotkey: string }> = {
  board: { panel: 'Board', hotkey: 'B' },
  log: { panel: 'Log', hotkey: 'L' },
  quests: { panel: 'Quests', hotkey: 'Q' },
  settings: { panel: 'Settings', hotkey: 'S' },
  heroes: { panel: 'Heroes', hotkey: 'H' },
  receptionist: { panel: 'Receptionist', hotkey: 'D' },
  // M14 T1: no panel and no hotkey; a click heals the floor's KO'd heroes (useFurnitureTriggers).
  infirmary: { panel: 'Coffee break', hotkey: '' },
};

const LABELS: Record<StyleId, Record<FurnitureAction, string>> = {
  modern: { board: 'Kanban board', log: 'Bookcase', quests: 'Notice board', settings: 'Server console', heroes: 'Team roster', receptionist: 'Reception desk', infirmary: 'Coffee machine' },
  guild: { board: 'War map', log: 'Guild ledger', quests: 'Quest board', settings: 'Arcane terminal', heroes: 'Hall of Heroes', receptionist: "Gatekeeper's desk", infirmary: 'Healing fountain' },
  rift: { board: 'Star chart', log: 'Archive crystal', quests: 'Bounty shard', settings: 'Rift console', heroes: 'Hero constellation', receptionist: 'Nexus gate desk', infirmary: 'Med-bay' },
};

export function triggerLabel(styleId: StyleId, action: FurnitureAction): string {
  return LABELS[styleId][action];
}

/** "Quest board · Open Quests (Q)" */
export function triggerTooltip(styleId: StyleId, action: FurnitureAction): string {
  const { panel, hotkey } = TRIGGER_PANEL[action];
  if (!hotkey) return `${triggerLabel(styleId, action)} · ${panel}`;
  return `${triggerLabel(styleId, action)} · Open ${panel} (${hotkey})`;
}

/** Furniture marked as a trigger, in `TRIGGER_ORDER` (items with an unknown action are dropped). */
export function triggersOf(map: Pick<GeneratedMap, 'furniture'>): PlacedFurniture[] {
  const rank = (a: FurnitureAction) => TRIGGER_ORDER.indexOf(a);
  return map.furniture.filter((f) => f.trigger !== undefined && rank(f.trigger) >= 0).sort((a, b) => rank(a.trigger!) - rank(b.trigger!));
}

export const SEEN_STORAGE_KEY = 'tagconn.furnitureSeen.v1';

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** First-seen pulse memory. Falls back to memory only when storage is missing or throws. */
export function createSeenStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage()): { has(a: FurnitureAction): boolean; mark(a: FurnitureAction): void } {
  const seen = new Set<FurnitureAction>();
  try {
    const raw = storage?.getItem(SEEN_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) for (const a of parsed) if (typeof a === 'string' && Object.hasOwn(TRIGGER_PANEL, a)) seen.add(a as FurnitureAction);
  } catch {
    /* unreadable storage: start empty */
  }
  return {
    has: (a) => seen.has(a),
    mark(a) {
      seen.add(a);
      try {
        storage?.setItem(SEEN_STORAGE_KEY, JSON.stringify([...seen]));
      } catch {
        /* storage full or blocked: the in-memory set still holds */
      }
    },
  };
}
