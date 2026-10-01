import { useRef, type ReactNode } from 'react';
import { useModalFocus } from '../lib/useModalFocus';
import { Button, cx } from './ui';

/**
 * A modal overlay panel above the office canvas, shaped by viewport (M12): a full-screen sheet on a
 * phone in portrait, a right-hand side sheet (~60% wide) on a phone in landscape, a centred dialog on
 * tablet and desktop (the `dialog:`/`side:` variants in `index.css`). Same focus contract as every
 * other dialog here (`useModalFocus`: focus in, Tab trapped, Esc closes the top-most one, focus back
 * to the opener) and `data-modal`/`aria-modal` so the global hotkeys stay quiet while it is open.
 * The backdrop is only visible where the canvas shows around the panel.
 */
export function Sheet({ id, title, onClose, children, wide = true }: { id: string; title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(true, ref, { trap: true, onEscape: onClose });
  const titleId = `sheet-title-${id}`;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-modal={id}
      className="anim-fade fixed inset-0 z-40 flex bg-black/55 dialog:items-center dialog:justify-center dialog:p-6 side:justify-end"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className={cx(
          'anim-sheet flex min-h-0 w-full flex-col overflow-hidden border-ink-700 bg-ink-900 shadow-2xl',
          'dialog:h-[min(88dvh,820px)] dialog:rounded-xl dialog:border',
          wide ? 'dialog:max-w-6xl' : 'dialog:max-w-3xl',
          'side:w-[60vw] side:max-w-none side:border-l',
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-850 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <h1 id={titleId} className="text-sm font-semibold text-ink-100">
            {title}
          </h1>
          <Button variant="ghost" className="ml-auto" onClick={onClose} aria-label={`Close ${typeof title === 'string' ? title : 'panel'}`} title="Close (Esc)">
            ✕
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </section>
    </div>
  );
}
