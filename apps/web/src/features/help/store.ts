import { create } from 'zustand';

/**
 * Whether the hotkey help overlay is open. A plain zustand store (mirroring `features/heroes/store.ts`)
 * because it's opened from two places that share no closer parent than `App`: the `?` hotkey
 * registered in `app/TopBar.tsx` (alongside its `H`/`V` listeners) and the "?" button next to
 * "Hall Planner" there. `TopBar` mounts `<HelpOverlay />` once, gated on `open`.
 */
export interface HelpOverlayState {
  open: boolean;
  openHelp(): void;
  close(): void;
}

export const useHelpOverlayStore = create<HelpOverlayState>()((set) => ({
  open: false,
  openHelp: () => set({ open: true }),
  close: () => set({ open: false }),
}));
