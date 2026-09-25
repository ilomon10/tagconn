import { useEffect } from 'react';
import { ROOM_TYPES, type RoomType } from '@tagconn/shared';
import type { ThemeDefinition } from '../../game/themes';
import { isTypingTarget } from './shortcuts';

/**
 * The popover shown after drawing a rectangle (guild-hall.md section 5): "Alchemy Lab (qa-lab)"
 * style, with 1-9/0 hotkeys for the first ten types. Positioned by the caller (`PlanCanvas`) at the
 * drop point, clamped to the viewport.
 */
export function RoomTypePicker({
  theme,
  x,
  y,
  onPick,
  onCancel,
}: {
  theme: ThemeDefinition;
  x: number;
  y: number;
  onPick: (type: RoomType) => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // the editor's global handler would otherwise also treat this Escape
        onCancel();
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        const n = Number(e.key);
        const idx = n === 0 ? 9 : n - 1;
        const type = ROOM_TYPES[idx];
        if (type) {
          e.preventDefault();
          e.stopPropagation();
          onPick(type);
        }
      }
    };
    // Capture phase: this popover owns digit/Escape keys while it's open, before any other handler sees them.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onPick, onCancel]);

  // Clamp so the popover never renders off-screen.
  const width = 240;
  const maxHeight = 360;
  const left = Math.min(Math.max(8, x), window.innerWidth - width - 8);
  const top = Math.min(Math.max(8, y), window.innerHeight - maxHeight - 8);

  return (
    <div
      className="fixed inset-0 z-[60]"
      onClick={onCancel}
      onContextMenu={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div
        className="absolute overflow-y-auto rounded-lg border border-ink-600 bg-ink-850 py-1 shadow-2xl"
        style={{ left, top, width, maxHeight }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
        aria-label="Room type"
      >
        {ROOM_TYPES.map((type, i) => (
          <button
            key={type}
            type="button"
            role="menuitem"
            className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-ink-100 hover:bg-ink-700"
            onClick={() => onPick(type)}
          >
            <span>
              {theme.roomNames[type]} <span className="text-ink-400">({type})</span>
            </span>
            {i < 10 && <kbd className="rounded bg-ink-700 px-1 py-0.5 font-mono text-[10px] text-ink-300">{(i + 1) % 10}</kbd>}
          </button>
        ))}
      </div>
    </div>
  );
}
