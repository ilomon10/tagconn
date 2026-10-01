import { create } from 'zustand';

/** The panels that used to be top-bar tabs and now open as overlays above the always-mounted office canvas. */
export type OverlayId = 'board' | 'log' | 'quests' | 'roles' | 'settings';

export const OVERLAYS: { id: OverlayId; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'log', label: 'Log' },
  { id: 'quests', label: 'Quests' },
  { id: 'roles', label: 'Roles' },
  { id: 'settings', label: 'Settings' },
];

/** Pure: `#board` → `'board'`; anything else (`''`, `#office`, `#pair=…`) → null (no overlay). */
export function overlayFromHash(hash: string): OverlayId | null {
  const id = hash.replace(/^#/, '');
  return OVERLAYS.find((o) => o.id === id)?.id ?? null;
}

const setHash = (hash: string) => window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);

/**
 * The open overlay, mirrored into `location.hash` so `#board` deep links keep working (`App` listens
 * for `hashchange`, e.g. the overflow banner's `location.hash = 'settings'`). Closing goes back to
 * `#office`. Only one overlay is open at a time; opening another replaces it.
 */
export interface OverlayState {
  open: OverlayId | null;
  openOverlay(id: OverlayId): void;
  close(): void;
  syncFromHash(): void;
}

export const useOverlayStore = create<OverlayState>()((set) => ({
  open: typeof window === 'undefined' ? null : overlayFromHash(window.location.hash),
  openOverlay: (id) => {
    setHash(`#${id}`);
    set({ open: id });
  },
  close: () => {
    setHash('#office');
    set({ open: null });
  },
  syncFromHash: () => set({ open: overlayFromHash(window.location.hash) }),
}));
