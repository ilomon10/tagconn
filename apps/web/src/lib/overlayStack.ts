import { useEffect, useRef } from 'react';

/**
 * The open overlays, bottom first. One document-level Esc listener closes only the TOP one, so Esc
 * never depends on where focus happens to be (a button that disables itself, a panel that never took
 * focus) and a dialog over a panel closes before the panel under it. Anything that handles Esc on its
 * own (the Hall Planner's capture-phase shortcuts, a rename field) runs first and stops it reaching here.
 */
export interface OverlayEntry {
  close: () => void;
}

const stack: OverlayEntry[] = [];

/** Pure: the overlay an Esc keydown should close, or null (not Esc, already handled, typing, nothing open). */
export function escapeTarget<T>(entries: readonly T[], e: { key: string; defaultPrevented?: boolean; target?: EventTarget | null }): T | null {
  if (e.key !== 'Escape' || e.defaultPrevented || entries.length === 0) return null;
  if (escapeIgnoresTarget(e.target ?? null)) return null;
  return entries[entries.length - 1] ?? null;
}

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** A field where Esc belongs to the field (cancel a rename, clear a text box): text-like inputs, textareas, contenteditable. A select or a checkbox has no text to lose. */
export function escapeIgnoresTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable === true || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((el.type ?? 'text').toLowerCase());
}

let listening = false;
function onKeyDown(e: KeyboardEvent) {
  const top = escapeTarget(stack, e);
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.close();
}

/** Registers `entry` as the new top overlay; returns the function that removes it. */
export function pushOverlay(entry: OverlayEntry): () => void {
  stack.push(entry);
  if (!listening && typeof document !== 'undefined') {
    // Capture, so it runs before any bubble-phase Esc handler on the page (the character drawer's).
    document.addEventListener('keydown', onKeyDown, true);
    listening = true;
  }
  return () => {
    const i = stack.lastIndexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Test seam. */
export const overlayCount = () => stack.length;

/** While `open`, `onEscape` is called when Esc is pressed and this is the top-most open overlay. */
export function useOverlayEscape(open: boolean, onEscape: (() => void) | undefined): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  const has = !!onEscape;
  useEffect(() => {
    if (!open || !has) return;
    return pushOverlay({ close: () => ref.current?.() });
  }, [open, has]);
}
