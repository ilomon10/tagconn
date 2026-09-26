import { create } from 'zustand';

/**
 * Whether the Receptionist chat panel is open, and which conversation it's showing. A plain zustand
 * store (not component state) for the same reason `features/heroes/store.ts` is: the "Receptionist"
 * button lives in `app/TopBar.tsx`, but the panel itself is mounted once from `app/App.tsx` (see that
 * file) — they don't share state any closer than here.
 */

export interface ReceptionistUiState {
  open: boolean;
  activeConversationId: string | null;
  openPanel(): void;
  closePanel(): void;
  setActiveConversationId(id: string | null): void;
}

export const useReceptionistUiStore = create<ReceptionistUiState>()((set) => ({
  open: false,
  activeConversationId: null,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  setActiveConversationId: (id) => set({ activeConversationId: id }),
}));
