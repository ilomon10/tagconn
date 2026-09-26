import { useRef } from 'react';
import { useModalFocus } from '../../lib/useModalFocus';
import { HOTKEY_GROUPS } from './hotkeys';
import { useHelpOverlayStore } from './store';
import { Button, Panel, cx } from '../../components/ui';

const TITLE_ID = 'help-overlay-title';

/** A key combo as `<kbd>` chips — "Ctrl/Cmd+Shift+Z" renders as three chips joined by "+". */
function ComboChips({ combo }: { combo: string }) {
  const parts = combo.split('+');
  return (
    <span className="inline-flex items-center gap-1">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden="true" className="text-ink-400">+</span>}
          <kbd className="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-pixel text-[10px] text-ink-100">
            {part}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * The hotkey help overlay (M9 8f): every hotkey in the app, grouped by area, opened by `?` (ignored
 * while typing or another modal is open — `shouldOpenHelp`) or the "?" button in `TopBar` next to
 * "Hall Planner". Same dialog pattern as `FloorManager`/`PairingDialog` (backdrop click-away,
 * `data-modal`/`aria-modal` so other hotkeys stay quiet while it's open), plus the initial-focus and
 * focus-return this one is the first to add — see `HOTKEY_GROUPS`' comment for how the list here was
 * checked against the actual handlers rather than assumed.
 */
export function HelpOverlay() {
  const open = useHelpOverlayStore((s) => s.open);
  const close = useHelpOverlayStore((s) => s.close);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Shared dialog focus management (M9 8f, `lib/useModalFocus.ts`): the close button is the first
  // (and, short of scrolling into the shortcut list, only) focusable element in the dialog, so it
  // gets initial focus with no explicit `initialFocusRef` needed; focus returns to whatever had it
  // before the overlay opened, and Tab/Shift+Tab stay trapped inside while it's open.
  // Esc closes it (and stops there, so the character drawer underneath stays open).
  useModalFocus(open, dialogRef, { trap: true, onEscape: close });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20"
      onClick={close}
      data-modal="help"
      aria-modal="true"
      role="dialog"
      aria-labelledby={TITLE_ID}
    >
      <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <Panel
          title={<span id={TITLE_ID}>Keyboard shortcuts</span>}
          actions={
            <Button variant="ghost" onClick={close} aria-label="Close">
              ✕
            </Button>
          }
        >
          <div className="grid max-h-[70vh] gap-4 overflow-y-auto p-3 sm:grid-cols-2">
            {HOTKEY_GROUPS.map((group) => (
              <section key={group.title}>
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-300">{group.title}</h3>
                <ul className="space-y-1">
                  {group.entries.map((entry, i) => (
                    <li key={i} className={cx('flex items-center justify-between gap-3 rounded px-1.5 py-1', i % 2 === 0 && 'bg-ink-800/40')}>
                      <span className="flex flex-wrap items-center gap-1">
                        {entry.combos.map((combo, j) => (
                          <span key={combo} className="inline-flex items-center gap-1">
                            {j > 0 && <span className="text-[10px] text-ink-400">or</span>}
                            <ComboChips combo={combo} />
                          </span>
                        ))}
                      </span>
                      <span className="text-right text-[11px] text-ink-300">{entry.description}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
