/**
 * Hotkeys for the top bar's menu entries (one letter each, no modifiers). Kept as plain data so
 * `help/hotkeys.ts`, the menu sheet's `<kbd>` hints and the single global listener in `TopBar` can't
 * drift apart. Existing keys this must not collide with: PageUp/PageDown/Home/End/F (floors), `[`/`]`
 * (cycle characters), `?` (help) — see `features/office/OfficeView.tsx`.
 */
export type MenuActionId = 'menu' | 'board' | 'log' | 'quests' | 'roles' | 'heroes' | 'settings' | 'planner' | 'receptionist' | 'screen' | 'floors';

export const MENU_HOTKEYS: Record<MenuActionId, string> = {
  menu: 'M',
  board: 'B',
  log: 'L',
  quests: 'Q',
  roles: 'R',
  heroes: 'H',
  settings: 'S',
  planner: 'P',
  receptionist: 'D',
  screen: 'V',
  floors: 'F',
};

/** Pure: which menu action a key press maps to, or null. `floors` (F) is handled by `OfficeView`, so it is skipped here. */
export function menuActionForKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey?: boolean }): MenuActionId | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key.length !== 1) return null;
  const key = e.key.toUpperCase();
  for (const [id, k] of Object.entries(MENU_HOTKEYS) as [MenuActionId, string][]) {
    if (id !== 'floors' && k === key) return id;
  }
  return null;
}
