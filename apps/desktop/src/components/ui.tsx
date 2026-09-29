import { useEffect, useRef, type ComponentPropsWithRef, type ReactNode } from 'react';
import type { CheckStatus } from '@tagconn/shared';
import type { AppState, Light } from '../lib/state';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';
const variants: Record<Variant, string> = {
  primary: 'bg-cozy text-ink-950 hover:brightness-110 font-semibold',
  subtle: 'bg-ink-700 text-ink-100 hover:bg-ink-600',
  ghost: 'text-ink-300 hover:text-ink-100 hover:bg-ink-800',
  danger: 'bg-red-900 text-red-50 hover:bg-red-800',
};

export function Button({ variant = 'subtle', className, ...rest }: ComponentPropsWithRef<'button'> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40', variants[variant], className)}
      {...rest}
    />
  );
}

const lightClass: Record<Light, string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-400 light-starting',
  red: 'bg-red-400',
  grey: 'bg-ink-400',
  striped: 'light-unavailable',
};
const lightLabel: Record<Light, string> = { green: 'running', amber: 'in transition', red: 'crashed', grey: 'stopped', striped: 'unavailable' };

/** Status light. Colour is never the only signal: the label is in the DOM and unavailable is striped. */
export function StatusLight({ light, label }: { light: Light; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span aria-hidden className={cx('inline-block size-3 rounded-full ring-1 ring-ink-100/20', lightClass[light])} />
      <span>{label ?? lightLabel[light]}</span>
    </span>
  );
}

const checkGlyph: Record<CheckStatus, { icon: string; text: string; cls: string }> = {
  ok: { icon: '✓', text: 'OK', cls: 'text-emerald-300' },
  warn: { icon: '!', text: 'Warning', cls: 'text-amber-300' },
  fail: { icon: '✕', text: 'Failed', cls: 'text-red-300' },
  skip: { icon: '–', text: 'Skipped', cls: 'text-ink-300' },
};

export function CheckIcon({ status }: { status: CheckStatus }) {
  const g = checkGlyph[status];
  return (
    <span className={cx('inline-flex w-16 shrink-0 items-center gap-1.5 font-semibold text-xs', g.cls)}>
      <span aria-hidden className="inline-flex size-5 items-center justify-center rounded-full border border-current">
        {g.icon}
      </span>
      {g.text}
    </span>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start gap-3 py-1.5 text-sm', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input type="checkbox" className="mt-0.5 size-4 accent-[#f5c07a]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-xs text-ink-300">{hint}</span>}
      </span>
    </label>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: focuses inside on open, traps Tab, closes on Escape (unless `blocking`) and returns
 * focus to whatever opened it.
 */
export function Dialog({ title, onClose, children, blocking, side, wide }: { title: string; onClose?: () => void; children: ReactNode; blocking?: boolean; side?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    (node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>(FOCUSABLE) ?? node)?.focus();
    return () => opener?.focus?.();
  }, []);
  // Focus can be lost while the dialog is open (e.g. the focused button just became disabled), so keydown
  // never reaches the dialog. Escape then closes the topmost dialog from the document instead.
  useEffect(() => {
    if (blocking || !onClose) return;
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const node = ref.current;
      if (!node || node.contains(document.activeElement)) return; // the dialog's own handler takes it
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals[modals.length - 1] !== node) return;
      onClose();
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [blocking, onClose]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !blocking) {
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return e.preventDefault();
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className={cx('fixed inset-0 z-50 flex bg-ink-950/80', side ? 'justify-end' : 'items-center justify-center p-4')}>
      <div
        ref={ref}
        role={blocking ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cx('flex flex-col border border-ink-600 bg-ink-850 shadow-xl', side ? 'h-full w-[min(44rem,100%)]' : cx('max-h-full w-full overflow-auto rounded-lg', wide ? 'max-w-3xl' : 'max-w-lg'))}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink-700 px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          {!blocking && onClose && (
            <Button variant="ghost" onClick={onClose} aria-label={`Close ${title}`}>
              Close
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export interface Notice {
  kind: 'error' | 'info';
  message: string;
  hint?: string;
  /** Clears the notice as soon as this holds for the app state (the condition it reports has resolved). */
  until?: (s: AppState) => boolean;
  /** Removes the notice by itself after this many ms (confirmations). */
  dismissAfterMs?: number;
  action?: { label: string; run: () => void };
}

/** Errors say what failed and one next step (design doc, error handling principles). Overlays the page so it never shifts the layout. */
export function NoticeBar({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-40 px-4 pt-3" aria-live="polite">
      {notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} className={cx('pointer-events-auto mx-auto flex max-w-3xl items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm shadow-lg', notice.kind === 'error' ? 'border-red-500/60 bg-red-950 text-red-50' : 'border-ink-600 bg-ink-800 text-ink-100')}>
          <div>
            <p>{notice.message}</p>
            {notice.hint && <p className="mt-0.5 text-xs opacity-90">{notice.hint}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            {notice.action && (
              <Button
                variant="primary"
                onClick={() => {
                  notice.action?.run();
                  onDismiss();
                }}
              >
                {notice.action.label}
              </Button>
            )}
            <Button variant="ghost" onClick={onDismiss} aria-label="Dismiss message">
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
