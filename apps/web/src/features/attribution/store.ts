import { create } from 'zustand';
import type { AttributionResolve, PendingProfileImport } from '@tagconn/shared';
import { useAuthStore } from '../../stores/authStore';
import { useOfficeStore } from '../../stores/officeStore';
import { AckTimeoutError, getSocket } from '../../lib/socket';
import { PAIR_TO_CHANGE_MESSAGE } from '../../lib/auth';
import { listPendingImports, resolvePendingImport } from './api';
import { removePending, upsertPending } from './reducer';

/**
 * Pending tagconn profile imports (M8 8j), shared by the floating toast host and the Settings →
 * Attribution list. The server only ever pushes `attribution:pending`/`attribution:pendingCleared` to
 * the admin room (docs/design/runner-and-helpdesk.md section 6.3), so any socket that receives one is
 * already a verified admin session — no extra client-side gating is needed for the push handlers, only
 * for the initial fetch (`hydrate`), which is itself an always-admin-gated event.
 */
export interface AttributionState {
  pending: PendingProfileImport[];
  loaded: boolean;
  /** projectId -> true while an Import/Dismiss is in flight, so buttons can disable themselves. */
  busy: Record<string, boolean>;
  hydrate(): Promise<void>;
  resolve(projectId: string, action: AttributionResolve['action']): Promise<void>;
}

export const useAttributionStore = create<AttributionState>()((set, get) => ({
  pending: [],
  loaded: false,
  busy: {},

  hydrate: async () => {
    if (useOfficeStore.getState().connection === 'demo') {
      set({ loaded: true });
      return;
    }
    if (!useAuthStore.getState().status.admin) return;
    try {
      const pending = await listPendingImports();
      set({ pending, loaded: true });
    } catch {
      // Not authorized (session dropped between the admin check above and the call) or offline —
      // leave the list as-is; the toast host / settings panel just show nothing extra.
      set({ loaded: true });
    }
  },

  resolve: async (projectId, action) => {
    set((s) => ({ busy: { ...s.busy, [projectId]: true } }));
    try {
      await resolvePendingImport(projectId, action);
      set((s) => ({ pending: removePending(s.pending, projectId), busy: { ...s.busy, [projectId]: false } }));
    } catch (err) {
      set((s) => ({ busy: { ...s.busy, [projectId]: false } }));
      if (err instanceof AckTimeoutError) useAuthStore.getState().showToast(PAIR_TO_CHANGE_MESSAGE);
      throw err;
    }
  },
}));

getSocket().on('attribution:pending', (item) => {
  useAttributionStore.setState((s) => ({ pending: upsertPending(s.pending, item) }));
});
getSocket().on('attribution:pendingCleared', (projectId) => {
  useAttributionStore.setState((s) => ({ pending: removePending(s.pending, projectId) }));
});

// Re-hydrate the moment this browser gains an admin session (pairing, bootstrap, or a remembered
// token confirmed on load); drop the list the moment it's lost so a locked browser never keeps
// showing someone else's pending imports.
useAuthStore.subscribe((state, prev) => {
  if (state.status.admin && !prev.status.admin) void useAttributionStore.getState().hydrate();
  else if (!state.status.admin && prev.status.admin) useAttributionStore.setState({ pending: [], loaded: false });
});
