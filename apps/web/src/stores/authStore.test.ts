import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSessionInfo, AuthStatus } from '@tagconn/shared';

// `vi.mock` factories are hoisted above every import (including this file's own top-level `const`s),
// so anything a factory closes over must itself be created inside `vi.hoisted` — otherwise it's read
// in its temporal dead zone the moment `authStore.ts` (imported below) pulls in the mocked module.
const { apiMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return {
    apiMock: { authStatus: vi.fn(), pair: vi.fn(), bootstrap: vi.fn(), logout: vi.fn() },
    ApiErrorMock,
  };
});

vi.mock('../lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }));

const { authSocketMock, reconnectSocketAuthMock, AckTimeoutErrorMock, gateRef } = vi.hoisted(() => ({
  authSocketMock: { status: vi.fn(), sessions: vi.fn(), revoke: vi.fn() },
  reconnectSocketAuthMock: vi.fn(),
  AckTimeoutErrorMock: class AckTimeoutErrorMock extends Error {},
  gateRef: { current: null as null | { isGated(e: string): boolean; isAdmin(): boolean; onDenied(e: string, r: 'precheck' | 'timeout'): void } },
}));

vi.mock('../lib/socket', () => ({
  getSocket: () => ({ on: vi.fn() }),
  reconnectSocketAuth: reconnectSocketAuthMock,
  authSocket: authSocketMock,
  AckTimeoutError: AckTimeoutErrorMock,
  setSocketAuthGate: (g: typeof gateRef.current) => {
    gateRef.current = g;
  },
}));

const demoState = vi.hoisted(() => ({ demo: false }));
vi.mock('../lib/connection', () => ({ isDemo: () => demoState.demo }));

// Imported after the mocks above so `authStore.ts` picks them up; `lib/auth.ts` is left un-mocked so
// the storage/fragment/event-bus tests below exercise the real implementation.
import { useAuthStore } from './authStore';
import { emitAuthEvent, PAIR_TO_CHANGE_MESSAGE } from '../lib/auth';

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const status = (over: Partial<AuthStatus> = {}): AuthStatus => ({ mode: 'pairing', protect: 'all-writes', admin: false, ...over });
const TOKEN_KEY = 'tagconn.adminToken';

const initialState = useAuthStore.getState();

describe('authStore', () => {
  let session: Storage;
  let local: Storage;

  beforeEach(() => {
    vi.clearAllMocks();
    demoState.demo = false;
    session = memoryStorage();
    local = memoryStorage();
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', local);
    useAuthStore.setState(initialState, true);
  });

  afterEach(() => vi.unstubAllGlobals());

  describe('token lifecycle', () => {
    it('pair() stores the token, reconnects the socket, and refreshes status', async () => {
      apiMock.pair.mockResolvedValue({ token: 'tca_abc', sessionId: 's1', expiresAt: 111 });
      apiMock.authStatus.mockResolvedValue(status({ admin: true, sessionId: 's1', expiresAt: 111 }));

      await useAuthStore.getState().pair('ABCD-EFGH-JKMN', 'laptop');

      expect(apiMock.pair).toHaveBeenCalledWith({ code: 'ABCD-EFGH-JKMN', label: 'laptop' });
      expect(session.getItem(TOKEN_KEY)).toBe('tca_abc');
      expect(reconnectSocketAuthMock).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().status.admin).toBe(true);
      expect(useAuthStore.getState().pairingOpen).toBe(false);
    });

    it('pair() failure records a message and leaves storage untouched', async () => {
      apiMock.pair.mockRejectedValue(new ApiErrorMock('Invalid, expired or already-used pairing code', 401));

      await expect(useAuthStore.getState().pair('0000-0000-0000')).rejects.toBeInstanceOf(ApiErrorMock);

      expect(useAuthStore.getState().pairError).toMatch(/Invalid/);
      expect(session.getItem(TOKEN_KEY)).toBeNull();
      expect(reconnectSocketAuthMock).not.toHaveBeenCalled();
    });

    it('bootstrap() stores the token the same way pair() does', async () => {
      apiMock.bootstrap.mockResolvedValue({ token: 'tca_boot', sessionId: 's2', expiresAt: 222 });
      apiMock.authStatus.mockResolvedValue(status({ admin: true }));

      await useAuthStore.getState().bootstrap('this browser');

      expect(session.getItem(TOKEN_KEY)).toBe('tca_boot');
      expect(useAuthStore.getState().status.admin).toBe(true);
    });

    it('logout() clears the token, reconnects, and drops admin even if the request 401s', async () => {
      session.setItem(TOKEN_KEY, 'tca_stale');
      apiMock.logout.mockRejectedValue(new ApiErrorMock('unauthorized', 401));
      useAuthStore.setState({ status: status({ admin: true, sessionId: 's1', expiresAt: 1 }) });

      await useAuthStore.getState().logout();

      expect(session.getItem(TOKEN_KEY)).toBeNull();
      expect(local.getItem(TOKEN_KEY)).toBeNull();
      expect(reconnectSocketAuthMock).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().status.admin).toBe(false);
    });
  });

  describe('remember vs session storage', () => {
    it('defaults to sessionStorage (remember=false)', async () => {
      apiMock.pair.mockResolvedValue({ token: 'tca_session', sessionId: 's1', expiresAt: 1 });
      apiMock.authStatus.mockResolvedValue(status());

      await useAuthStore.getState().pair('ABCD-EFGH-JKMN');

      expect(session.getItem(TOKEN_KEY)).toBe('tca_session');
      expect(local.getItem(TOKEN_KEY)).toBeNull();
    });

    it('writes to localStorage once "Remember on this device" is set', async () => {
      apiMock.pair.mockResolvedValue({ token: 'tca_remember', sessionId: 's1', expiresAt: 1 });
      apiMock.authStatus.mockResolvedValue(status());
      useAuthStore.setState({ remember: true });

      await useAuthStore.getState().pair('ABCD-EFGH-JKMN');

      expect(local.getItem(TOKEN_KEY)).toBe('tca_remember');
      expect(session.getItem(TOKEN_KEY)).toBeNull();
    });
  });

  describe('fragment parsing / clearing', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('consumeFragment opens the pairing dialog prefilled, and clears the URL', () => {
      const replaceState = vi.fn();
      vi.stubGlobal('window', { location: { hash: '#pair=ABCD-EFGH-JKMN', pathname: '/', search: '' }, history: { replaceState } });

      useAuthStore.getState().consumeFragment();

      expect(useAuthStore.getState().pairingOpen).toBe(true);
      expect(useAuthStore.getState().prefilledCode).toBe('ABCDEFGHJKMN');
      expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    });

    it('is a no-op without a #pair fragment', () => {
      const replaceState = vi.fn();
      vi.stubGlobal('window', { location: { hash: '#office', pathname: '/', search: '' }, history: { replaceState } });

      useAuthStore.getState().consumeFragment();

      expect(useAuthStore.getState().pairingOpen).toBe(false);
      expect(replaceState).not.toHaveBeenCalled();
    });
  });

  describe('demo mode', () => {
    it('refreshStatus never calls the server (demo has no server enforcing auth)', async () => {
      demoState.demo = true;
      await useAuthStore.getState().refreshStatus();
      expect(apiMock.authStatus).not.toHaveBeenCalled();
      expect(useAuthStore.getState().statusLoaded).toBe(true);
    });
  });

  describe('central 401 / timeout handling', () => {
    it('a 401 from lib/api.ts drops admin and shows the gentle prompt', () => {
      useAuthStore.setState({ status: status({ admin: true }) });
      emitAuthEvent({ reason: 'unauthenticated', message: PAIR_TO_CHANGE_MESSAGE });
      expect(useAuthStore.getState().status.admin).toBe(false);
      expect(useAuthStore.getState().toast).toBe(PAIR_TO_CHANGE_MESSAGE);
    });

    it('loadSessions() treats an ack timeout as "not authorized", not a network error', async () => {
      authSocketMock.sessions.mockRejectedValue(new AckTimeoutErrorMock('timed out'));

      await expect(useAuthStore.getState().loadSessions()).rejects.toBeInstanceOf(AckTimeoutErrorMock);

      expect(useAuthStore.getState().toast).toBe(PAIR_TO_CHANGE_MESSAGE);
      expect(useAuthStore.getState().sessionsBusy).toBe(false);
    });
  });

  describe('revoke', () => {
    const session1: AdminSessionInfo = { id: 's1', createdAt: 1, lastUsedAt: 1, expiresAt: 1, current: true };

    it("revoke('*') clears the token locally rather than waiting for the next sweep", async () => {
      session.setItem(TOKEN_KEY, 'tca_abc');
      authSocketMock.revoke.mockResolvedValue(true);
      useAuthStore.setState({ status: status({ admin: true, sessionId: 's1' }), sessions: [session1] });

      await useAuthStore.getState().revoke('*');

      expect(session.getItem(TOKEN_KEY)).toBeNull();
      expect(useAuthStore.getState().status.admin).toBe(false);
      expect(useAuthStore.getState().sessions).toEqual([]);
      expect(authSocketMock.sessions).not.toHaveBeenCalled();
    });

    it('revoking this browser\'s own session id also clears it locally', async () => {
      authSocketMock.revoke.mockResolvedValue(true);
      useAuthStore.setState({ status: status({ admin: true, sessionId: 's1' }) });

      await useAuthStore.getState().revoke('s1');

      expect(useAuthStore.getState().status.admin).toBe(false);
      expect(authSocketMock.sessions).not.toHaveBeenCalled();
    });

    it('revoking a different session reloads the sessions list instead', async () => {
      authSocketMock.revoke.mockResolvedValue(true);
      authSocketMock.sessions.mockResolvedValue([session1]);
      useAuthStore.setState({ status: status({ admin: true, sessionId: 's1' }) });

      await useAuthStore.getState().revoke('s2');

      expect(authSocketMock.sessions).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().status.admin).toBe(true);
    });
  });

  describe('socket auth gate', () => {
    it('is registered and reflects protect + admin status', () => {
      const gate = gateRef.current!;
      expect(gate).toBeTruthy();
      useAuthStore.setState({ statusLoaded: true, status: status({ protect: 'all-writes' }) });
      expect(gate.isGated('settings:update')).toBe(true);
      expect(gate.isGated('settings:get')).toBe(false);
      expect(gate.isAdmin()).toBe(false);
      useAuthStore.setState({ status: status({ protect: 'execution' }) });
      expect(gate.isGated('settings:update')).toBe(false);
      expect(gate.isGated('runs:start')).toBe(true);
      useAuthStore.setState({ status: status({ admin: true }) });
      expect(gate.isAdmin()).toBe(true);
    });

    it('lets the emit through while the status is still unknown', () => {
      useAuthStore.setState({ statusLoaded: false, status: status() });
      expect(gateRef.current!.isAdmin()).toBe(true);
    });

    it('precheck denial drops admin, shows the pair prompt and opens the pairing dialog', () => {
      useAuthStore.setState({ statusLoaded: true, status: status() });
      gateRef.current!.onDenied('settings:update', 'precheck');
      const st = useAuthStore.getState();
      expect(st.status.admin).toBe(false);
      expect(st.toast).toBe(PAIR_TO_CHANGE_MESSAGE);
      expect(st.pairingOpen).toBe(true);
    });

    it('a timeout on a still-valid session (slow server) does not log out or prompt', async () => {
      useAuthStore.setState({ statusLoaded: true, status: status({ admin: true }) });
      apiMock.authStatus.mockResolvedValue(status({ admin: true }));
      gateRef.current!.onDenied('settings:update', 'timeout');
      await vi.waitFor(() => expect(apiMock.authStatus).toHaveBeenCalled());
      await Promise.resolve();
      const st = useAuthStore.getState();
      expect(st.status.admin).toBe(true);
      expect(st.pairingOpen).toBe(false);
      expect(st.toast).toBeNull();
    });

    it('a timeout on an expired session asks to pair once the server confirms it', async () => {
      useAuthStore.setState({ statusLoaded: true, status: status({ admin: true }) });
      apiMock.authStatus.mockResolvedValue(status({ admin: false }));
      gateRef.current!.onDenied('settings:update', 'timeout');
      await vi.waitFor(() => expect(useAuthStore.getState().pairingOpen).toBe(true));
      expect(useAuthStore.getState().toast).toBe(PAIR_TO_CHANGE_MESSAGE);
    });
  });
});
