// UI feedback sounds: one helper for explicit semantic calls plus a delegated document listener for generic controls.
import { SFX_IDS, sfxBus, type SfxId } from '../../game/sfxBus';

/** A generic click within this window of an explicit `uiSound` call is the same interaction: it stays silent. */
export const SEMANTIC_WINDOW_MS = 60;

let lastSemanticAt = -Infinity;

/** Plays a UI sound (a no-op until audio is unlocked and enabled; the bridge and engine do the gating). */
export function uiSound(id: SfxId): void {
  lastSemanticAt = performance.now();
  sfxBus.emit({ id });
}

/** Pure: the sound for a selection change, or null. A new non-null id selects; clearing goes back. */
export function selectionSound(prev: string | null, next: string | null): SfxId | null {
  if (next === prev) return null;
  return next === null ? 'ui-back' : 'ui-select';
}

const CLICKABLE = 'button, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], input[type="checkbox"], input[type="radio"]';

/**
 * Pure: the sound a click on `el` should make. `data-sfx="none"` on the control or an ancestor opts out,
 * `data-sfx="<id>"` overrides; otherwise switches/checkboxes/radios toggle, tabs tab, everything else clicks.
 */
export function clickSoundFor(el: Pick<Element, 'closest'> | null | undefined): SfxId | null {
  const target = el?.closest(CLICKABLE);
  if (!target) return null;
  if (target.matches(':disabled, [aria-disabled="true"]')) return null;
  const tag = target.closest('[data-sfx]')?.getAttribute('data-sfx');
  if (tag === 'none') return null;
  if (tag && (SFX_IDS as readonly string[]).includes(tag)) return tag as SfxId;
  const role = target.getAttribute('role');
  if (role === 'tab') return 'ui-tab';
  if (role === 'switch' || role === 'checkbox' || role === 'radio' || target.matches('input[type="checkbox"], input[type="radio"]')) return 'ui-toggle';
  return 'ui-click';
}

/**
 * Installs the delegated click and hover listeners. Hover sounds are only for mouse pointers over elements marked
 * `data-sfx-hover` (never the canvas). Returns the uninstall function.
 */
export function installUiSoundDelegate(doc: Pick<Document, 'addEventListener' | 'removeEventListener'> = document, now: () => number = () => performance.now()): () => void {
  const onClick = (e: Event): void => {
    if (now() - lastSemanticAt < SEMANTIC_WINDOW_MS) return;
    const id = clickSoundFor(e.target as Element | null);
    if (id) sfxBus.emit({ id });
  };
  const onOver = (e: Event): void => {
    if ((e as PointerEvent).pointerType !== 'mouse') return;
    const t = (e.target as Element | null)?.closest?.('[data-sfx-hover]');
    const from = (e as PointerEvent).relatedTarget as Node | null;
    if (!t || (from && t.contains(from))) return;
    if (t.matches(':disabled, [aria-disabled="true"]')) return;
    sfxBus.emit({ id: 'ui-hover' });
  };
  doc.addEventListener('click', onClick);
  doc.addEventListener('pointerover', onOver);
  return () => {
    doc.removeEventListener('click', onClick);
    doc.removeEventListener('pointerover', onOver);
  };
}
