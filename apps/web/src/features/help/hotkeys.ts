import { isModalOpen, isTypingTarget } from '../../lib/floors';

/**
 * One shortcut row: `combos` are alternative key combinations that all do the same thing (rendered
 * "or"-joined, each combo's own parts "+"-joined into <kbd> chips — see `HelpOverlay`), and
 * `description` is the plain-English effect.
 */
export interface HotkeyEntry {
  combos: string[];
  description: string;
}

export interface HotkeyGroup {
  title: string;
  entries: HotkeyEntry[];
}

/**
 * Every hotkey in the app, grouped by area (M9 8f). Each entry below was checked against the
 * handler that implements it, not copied from docs:
 *   - Office: `features/office/OfficeView.tsx`'s two global `keydown` listeners (floor nav + `F`,
 *     and `[`/`]` roster cycling — `lib/floors.ts`'s `cycleIndex`), `app/TopBar.tsx`'s `H` (Heroes)
 *     and `V` (screen effect) listeners, and this feature's own `?`.
 *   - Hall Planner: `features/editor/shortcuts.ts`'s `resolveShortcut`.
 * Keep this in sync when a hotkey changes — there's no single source of truth to derive it from.
 */
export const HOTKEY_GROUPS: HotkeyGroup[] = [
  {
    title: 'Office',
    entries: [
      { combos: ['PageUp'], description: 'Floor up' },
      { combos: ['PageDown'], description: 'Floor down' },
      { combos: ['Home'], description: 'Ground floor' },
      { combos: ['End'], description: 'Top floor' },
      { combos: ['F'], description: 'Manage floors' },
      { combos: ['H'], description: 'Heroes' },
      { combos: ['V'], description: 'Screen effect' },
      { combos: ['['], description: 'Previous character' },
      { combos: [']'], description: 'Next character' },
      { combos: ['Esc'], description: 'Close panel' },
      { combos: ['?'], description: 'Keyboard shortcuts (this dialog)' },
    ],
  },
  {
    title: 'Hall Planner',
    entries: [
      { combos: ['V'], description: 'Select tool' },
      { combos: ['R'], description: 'Room tool' },
      { combos: ['S'], description: 'Stairs tool' },
      { combos: ['D'], description: 'Doors tool' },
      { combos: ['H', 'Space'], description: 'Hand tool' },
      { combos: ['1..9', '0'], description: 'Pick a room type from the popover' },
      { combos: ['Arrows'], description: 'Nudge the selection by 1 tile' },
      { combos: ['Shift+Arrows'], description: 'Nudge the selection by 5 tiles' },
      { combos: ['Alt+Arrows'], description: 'Resize the selection by 1 tile' },
      { combos: ['Delete', 'Backspace'], description: 'Delete the selection' },
      { combos: ['Ctrl/Cmd+D'], description: 'Duplicate the selection' },
      { combos: ['Ctrl/Cmd+Z'], description: 'Undo' },
      { combos: ['Ctrl/Cmd+Shift+Z', 'Ctrl+Y'], description: 'Redo' },
      { combos: ['Ctrl/Cmd+S'], description: 'Save' },
      { combos: ['Ctrl/Cmd+G'], description: 'Surprise me (random layout)' },
      { combos: ['P'], description: 'Toggle the styled preview' },
      { combos: ['Esc'], description: 'Cancel, then clear the selection, then close' },
      { combos: ['?'], description: 'Hall Planner shortcuts' },
    ],
  },
];

/** Structural shape of the bit of a keydown event this module cares about — a real `KeyboardEvent`
 *  satisfies it directly, and a plain object satisfies it in tests with no DOM involved. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target?: EventTarget | null;
}

/**
 * True when a keydown should open this help overlay: `?` (Shift+/ on most layouts — some report
 * `key: '?'` directly, others `key: '/'` with `shiftKey`), with no other modifier, outside a typing
 * target, and while no other modal already covers the screen (so it can't stack on top of, say, the
 * Hall Planner — that dialog has its own `?` via `shortcuts.ts`'s `resolveShortcut`).
 */
export function shouldOpenHelp(e: KeyLike, doc: Document = document): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const isHelpKey = e.key === '?' || (e.key === '/' && e.shiftKey);
  if (!isHelpKey) return false;
  if (isTypingTarget(e.target ?? null)) return false;
  if (isModalOpen(doc)) return false;
  return true;
}
