import { HALF_TILE } from '@tagconn/shared';
import type { EditorTool } from '../../stores/editorStore';

/**
 * Hall Planner keyboard shortcuts (docs/design/guild-hall.md section 5). Pure functions over a
 * minimal, structural key-event shape (not the real `KeyboardEvent` class) so they're unit-testable
 * under vitest's `node` environment, with no DOM/jsdom dependency — a real `KeyboardEvent` from the
 * browser satisfies `KeyLike` structurally, so the caller just passes it straight through.
 */

export type ShortcutAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'delete' }
  // `rotate` is R: the Furniture pick rotates; with none selected the caller falls back to the Room tool.
  | { type: 'rotate' }
  | { type: 'escape' }
  | { type: 'duplicate' }
  | { type: 'save' }
  | { type: 'surprise' }
  | { type: 'preview-toggle' }
  | { type: 'help' }
  | { type: 'tool'; tool: EditorTool }
  | { type: 'room-type'; index: number } // 1..9 -> 0..8, 0 -> 9 (the picker's own hotkey list)
  // `resize` is Alt: rooms resize, a locked furniture pin steps by half a tile instead (`pinNudgeDelta`).
  | { type: 'nudge'; dx: number; dy: number; resize: boolean };

/** Structural shape of the bit of `e.target` we care about — matches a real DOM element. */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** Structural shape of the bits of `KeyboardEvent` we care about. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target?: TargetLike | null;
}

/**
 * True when the event's target is a place the user is typing (input, textarea, select, or
 * contenteditable) — shortcuts must be ignored there so e.g. Delete still deletes text.
 */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

const isMod = (e: Pick<KeyLike, 'ctrlKey' | 'metaKey'>) => e.ctrlKey || e.metaKey;

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** Resolves a keydown to an editor action, or null if it's not a shortcut (or the user is typing). */
export function resolveShortcut(e: KeyLike): ShortcutAction | null {
  if (isTypingTarget(e.target)) return null;
  const key = e.key;
  const lower = key.toLowerCase();

  if (isMod(e) && lower === 'z') return e.shiftKey ? { type: 'redo' } : { type: 'undo' };
  if (isMod(e) && lower === 'y') return { type: 'redo' };
  if (isMod(e) && lower === 's') return { type: 'save' };
  if (isMod(e) && lower === 'd') return { type: 'duplicate' };
  if (isMod(e) && lower === 'g') return { type: 'surprise' };
  if (isMod(e)) return null; // an unhandled modifier combo (e.g. Ctrl+R) is never a plan shortcut

  if (key === 'Delete' || key === 'Backspace') return { type: 'delete' };
  if (key === 'Escape') return { type: 'escape' };
  if (key === '?') return { type: 'help' };
  if (lower === 'p') return { type: 'preview-toggle' };
  if (lower === 'v') return { type: 'tool', tool: 'select' };
  if (lower === 'r') return { type: 'rotate' };
  if (lower === 's') return { type: 'tool', tool: 'stairs' };
  if (lower === 'd') return { type: 'tool', tool: 'doors' };
  if (lower === 'f') return { type: 'tool', tool: 'furniture' };
  if (lower === 'h' || key === ' ') return { type: 'tool', tool: 'hand' };

  if (/^[0-9]$/.test(key)) {
    const n = Number(key);
    return { type: 'room-type', index: n === 0 ? 9 : n - 1 };
  }

  const arrow = ARROWS[key];
  if (arrow) {
    const magnitude = e.shiftKey ? 5 : 1;
    return { type: 'nudge', dx: arrow[0] * magnitude, dy: arrow[1] * magnitude, resize: e.altKey };
  }

  return null;
}

/**
 * The tile delta a `nudge` action applies to a locked furniture pin (M15, docs/design/navigation.md
 * section 3.2): Alt (`resize`) means a half-tile step, Shift still x5, so Shift+Alt moves 2.5.
 */
export function pinNudgeDelta(action: Extract<ShortcutAction, { type: 'nudge' }>): { dx: number; dy: number } {
  const step = action.resize ? HALF_TILE : 1;
  return { dx: action.dx * step, dy: action.dy * step };
}
