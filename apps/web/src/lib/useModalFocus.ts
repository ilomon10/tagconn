import { useEffect, useRef, type RefObject } from 'react';

/** Selects the elements a keyboard user can land on with Tab — the same rough list every focus-trap
 * implementation uses, since there's no single DOM API that returns it. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableElements(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Pure: which element should get focus when a modal or drawer opens — the explicit
 * `initialFocusRef` target if the caller gave one, else the first focusable descendant, else
 * nothing to focus. Kept separate from `useModalFocus` (which needs a React render and a real DOM
 * to exercise) so the decision itself is testable with plain values.
 */
export function initialFocusTarget<T>(initial: T | null | undefined, focusables: readonly T[]): T | null {
  return initial ?? focusables[0] ?? null;
}

/**
 * Pure: the whole Tab-trap decision for one keydown. Given the container's focusable elements (in
 * DOM order), whatever currently has focus, whether that's inside the container, and whether Tab is
 * moving backward (`shiftKey`), returns the element focus should jump to — or `null` to leave the
 * browser's default Tab handling alone (focus is already inside, away from both edges).
 */
export function trapFocusTarget<T>(focusables: readonly T[], active: T | null, activeIsInside: boolean, shiftKey: boolean): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (shiftKey) return !activeIsInside || active === first ? last : null;
  return !activeIsInside || active === last ? first : null;
}

export interface UseModalFocusOptions {
  /** Focused first when the modal opens, instead of the container's first focusable element
   * (e.g. a drawer's heading rather than whatever happens to be first in the DOM). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Keep Tab / Shift+Tab cycling within the container instead of leaving it — only meaningful for
   * true modals (backdrop, `aria-modal`); a docked panel like `AgentDrawer` leaves this off. */
  trap?: boolean;
  /** Esc inside the container closes it (ignored while typing in a field, which handles its own Esc). */
  onEscape?: () => void;
}

/**
 * Shared focus management for the office's dialogs and drawers (M9 8f): on open, remembers whatever
 * had focus and moves focus into `containerRef` (`initialFocusRef` if given, else the first
 * focusable descendant); on close (or unmount), restores focus to what was remembered, if it's
 * still attached to the document. With `trap: true`, Tab and Shift+Tab are kept cycling inside the
 * container so a modal dialog can't be tabbed out of onto the page behind it.
 *
 * `containerRef`/`initialFocusRef` are refs, so they're intentionally left out of the effect deps —
 * their identity is stable and what they point to can only be read once the DOM has committed.
 */
export function useModalFocus(open: boolean, containerRef: RefObject<HTMLElement | null>, options: UseModalFocusOptions = {}): void {
  const { initialFocusRef, trap = false, onEscape } = options;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const restoreToRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // `document.body` is what's "focused" when nothing really is — not worth restoring to.
    const active = document.activeElement;
    restoreToRef.current = active && active !== document.body ? (active as HTMLElement) : null;

    const container = containerRef.current;
    const focusables = container ? focusableElements(container) : [];
    const target = initialFocusTarget(initialFocusRef?.current ?? null, focusables);
    target?.focus();

    return () => {
      const restoreTo = restoreToRef.current;
      restoreToRef.current = null;
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !trap) return;
    const container = containerRef.current;
    if (!container) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusables = focusableElements(container);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const activeIsInside = !!active && container.contains(active);
      const target = trapFocusTarget(focusables, active, activeIsInside, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [open, trap]);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !onEscapeRef.current || isEditableTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      onEscapeRef.current();
    };
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [open]);
}

/** A field that handles its own Esc (e.g. cancelling a rename) — Esc there must not close the dialog. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
}
