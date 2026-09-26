import { create } from 'zustand';
import { socketEventNeedsAdmin, type AdminSessionInfo, type AuthStatus } from '@tagconn/shared';
import { api, ApiError } from '../lib/api';
import { isDemo } from '../lib/connection';
import { clearStoredToken, consumePairingFragment, onAuthEvent, PAIR_TO_CHANGE_MESSAGE, tokenIsRemembered, writeStoredToken } from '../lib/auth';
import { AckTimeoutError, authSocket, getSocket, reconnectSocketAuth, setSocketAuthGate } from '../lib/socket';

/**
 * M8 8m admin auth, browser side. Holds the *result* of an admin session (`status`, the sessions
 * list), never the token itself — the token lives only in storage (`lib/auth.ts`) and travels via the
 * REST Authorization header / socket handshake, both wired centrally in `lib/api.ts`/`lib/socket.ts`.
 * See docs/design/runner-and-helpdesk.md section 5 for the protocol this mirrors.
 */

const initialStatus: AuthStatus = { mode: 'pairing', protect: 'all-writes', admin: false };

export interface AuthState {
  status: AuthStatus;
  statusLoaded: boolean;
  sessions: AdminSessionInfo[];
  sessionsLoaded: boolean;
  sessionsBusy: boolean;
  pairingOpen: boolean;
  prefilledCode: string;
  /** "Remember on this device" checkbox state, defaulting to whatever the current token used. */
  remember: boolean;
  toast: string | null;
  pairError: string | null;

  setRemember(v: boolean): void;
  openPairing(prefill?: string): void;
  closePairing(): void;
  showToast(message: string): void;
  clearToast(): void;

  /** Reads `#pair=<code>` off the URL (if present) and opens the dialog prefilled. Safe to call more
   *  than once — the fragment is gone from the URL after the first call. */
  consumeFragment(): void;
  refreshStatus(): Promise<void>;
  pair(code: string, label?: string): Promise<void>;
  bootstrap(label?: string): Promise<void>;
  logout(): Promise<void>;
  loadSessions(): Promise<void>;
  revoke(sessionId: string): Promise<void>;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  status: initialStatus,
  statusLoaded: false,
  sessions: [],
  sessionsLoaded: false,
  sessionsBusy: false,
  pairingOpen: false,
  prefilledCode: '',
  remember: tokenIsRemembered(),
  toast: null,
  pairError: null,

  setRemember: (remember) => set({ remember }),
  openPairing: (prefill = '') => set({ pairingOpen: true, prefilledCode: prefill, pairError: null }),
  closePairing: () => set({ pairingOpen: false, prefilledCode: '', pairError: null }),
  showToast: (message) => set({ toast: message }),
  clearToast: () => set({ toast: null }),

  consumeFragment: () => {
    const code = consumePairingFragment();
    if (code) get().openPairing(code);
  },

  refreshStatus: async () => {
    // Demo mode has no real server to ask, and is unaffected by auth entirely (see `useRequireAdmin`).
    if (isDemo()) {
      set({ statusLoaded: true });
      return;
    }
    try {
      const status = await api.authStatus();
      set({ status, statusLoaded: true });
    } catch {
      // Offline / unreachable — `ConnectionBadge` already surfaces that; keep the last known status.
      set({ statusLoaded: true });
    }
  },

  pair: async (code, label) => {
    set({ pairError: null });
    try {
      const res = await api.pair({ code, label });
      writeStoredToken(res.token, get().remember);
      reconnectSocketAuth();
      // Paired now: flip admin right away so a write fired before the status round-trip isn't
      // precheck-denied (refreshStatus confirms or corrects it).
      set((s) => ({ pairingOpen: false, prefilledCode: '', status: { ...s.status, admin: true } }));
      await get().refreshStatus();
    } catch (err) {
      set({ pairError: err instanceof ApiError ? err.message : 'Could not pair — check the code and try again.' });
      throw err;
    }
  },

  bootstrap: async (label) => {
    set({ pairError: null });
    try {
      const res = await api.bootstrap({ label });
      writeStoredToken(res.token, get().remember);
      reconnectSocketAuth();
      // Paired now: flip admin right away so a write fired before the status round-trip isn't
      // precheck-denied (refreshStatus confirms or corrects it).
      set((s) => ({ pairingOpen: false, prefilledCode: '', status: { ...s.status, admin: true } }));
      await get().refreshStatus();
    } catch (err) {
      set({ pairError: err instanceof ApiError ? err.message : 'Bootstrap is unavailable.' });
      throw err;
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      // Best-effort: an already-dead token 401s here too, and we're clearing it locally regardless.
    }
    clearStoredToken();
    reconnectSocketAuth();
    set((s) => ({ status: { ...s.status, admin: false, sessionId: undefined, expiresAt: undefined }, sessions: [], sessionsLoaded: false }));
  },

  loadSessions: async () => {
    set({ sessionsBusy: true });
    try {
      const sessions = await authSocket.sessions();
      set({ sessions, sessionsLoaded: true, sessionsBusy: false });
    } catch (err) {
      set({ sessionsBusy: false });
      if (err instanceof AckTimeoutError) get().showToast(PAIR_TO_CHANGE_MESSAGE);
      throw err;
    }
  },

  revoke: async (sessionId) => {
    try {
      await authSocket.revoke(sessionId);
      // Revoking "*" or this browser's own session invalidates the token we just used to ask, and the
      // server only pushes `auth:changed` on its next sweep (up to `ADMIN_ROOM_SWEEP_MS`) — so drop it
      // locally right away rather than leaving the UI looking paired for up to a minute.
      if (sessionId === '*' || sessionId === get().status.sessionId) {
        clearStoredToken();
        reconnectSocketAuth();
        set((s) => ({ sessions: [], sessionsLoaded: true, status: { ...s.status, admin: false, sessionId: undefined, expiresAt: undefined } }));
      } else {
        await get().loadSessions();
      }
    } catch (err) {
      if (err instanceof AckTimeoutError) get().showToast(PAIR_TO_CHANGE_MESSAGE);
      throw err;
    }
  },
}));

// Server-pushed revoke/expiry: `auth:changed` lands on any socket whose session just stopped being
// valid (docs/design/runner-and-helpdesk.md section 5.3). Registered once here (rather than requiring
// every mount point to remember to wire it) since `getSocket()` is a lazy singleton either way.
getSocket().on('auth:changed', (status) => {
  useAuthStore.setState({ status });
  if (!status.admin) clearStoredToken();
});

// Central 401 (REST) / ack-timeout (socket) handling from `lib/api.ts` / `lib/socket.ts`: drop to the
// read-only view and show the same gentle prompt everywhere, instead of each write path doing its own.
onAuthEvent((e) => {
  useAuthStore.setState((s) => ({ status: { ...s.status, admin: false }, toast: e.message }));
});

// Gated socket writes: ask for pairing up front (no 10s wait for a denied ack) and open the dialog.
// Until the first status load we can't know, so the emit goes out and the timeout path covers it.
setSocketAuthGate({
  isGated: (event) => socketEventNeedsAdmin(event, useAuthStore.getState().status.protect),
  isAdmin: () => {
    const { status, statusLoaded } = useAuthStore.getState();
    return status.admin || !statusLoaded;
  },
  onDenied: (_event, reason) => {
    const askToPair = () => {
      useAuthStore.setState((s) => ({ status: { ...s.status, admin: false }, toast: PAIR_TO_CHANGE_MESSAGE }));
      useAuthStore.getState().openPairing();
    };
    if (reason === 'precheck') return askToPair();
    // A timeout alone isn't proof the session is gone (it may just be a slow server): ask the server,
    // and only prompt for pairing if it confirms this browser isn't paired (expired or revoked).
    void useAuthStore
      .getState()
      .refreshStatus()
      .then(() => {
        if (!useAuthStore.getState().status.admin) askToPair();
      });
  },
});
