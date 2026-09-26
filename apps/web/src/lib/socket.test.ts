import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getSocket()` is a lazy module-level singleton, so each test re-imports `./socket` fresh
 * (`vi.resetModules`) after installing a fake `socket.io-client`. That lets tests drive the raw
 * `emit(event, ...args, cb)` ack callback and the `disconnect` event directly, without a real network
 * connection — see `emitWithAckTimeout`'s doc comment for why this file deliberately doesn't use
 * socket.io's own `.timeout()`/ack-timeout option.
 */

type Handler = (...args: unknown[]) => void;

interface FakeSocket {
  connected: boolean;
  active: boolean;
  auth: unknown;
  listeners: Map<string, Set<Handler>>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  fireDisconnect: () => void;
}

function makeFakeSocket(): FakeSocket {
  const listeners = new Map<string, Set<Handler>>();
  const add = (event: string, fn: Handler) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(fn);
  };
  const fake: FakeSocket = {
    connected: true,
    active: true,
    auth: undefined,
    listeners,
    on: vi.fn((event: string, fn: Handler) => add(event, fn)),
    once: vi.fn((event: string, fn: Handler) => add(event, fn)),
    off: vi.fn((event: string, fn: Handler) => listeners.get(event)?.delete(fn)),
    // Captures the trailing ack callback so tests can resolve/reject it explicitly.
    emit: vi.fn(),
    disconnect: vi.fn(function (this: FakeSocket) {
      this.connected = false;
    }),
    connect: vi.fn(function (this: FakeSocket) {
      this.connected = true;
    }),
    fireDisconnect: () => {
      fake.connected = false;
      for (const fn of listeners.get('disconnect') ?? []) fn();
    },
  };
  return fake;
}

let fakeSocket: FakeSocket;
let ioSpy: ReturnType<typeof vi.fn>;

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

/** The last argument `emit(event, ...args, cb)` was called with — the ack callback. */
function ackCallback(): (res: { ok: true; data: unknown } | { ok: false; error: string }) => void {
  const call = fakeSocket.emit.mock.calls.at(-1) as unknown[];
  return call.at(-1) as (res: { ok: true; data: unknown } | { ok: false; error: string }) => void;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  fakeSocket = makeFakeSocket();
  ioSpy = vi.fn((_ns: string, opts: { auth: unknown }) => {
    fakeSocket.auth = opts.auth;
    return fakeSocket;
  });
  vi.doMock('socket.io-client', () => ({ io: ioSpy }));
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('socket.io-client');
});

describe('getSocket / auth handshake', () => {
  it('is a stable singleton', async () => {
    const { getSocket } = await import('./socket');
    expect(getSocket()).toBe(getSocket());
    expect(ioSpy).toHaveBeenCalledTimes(1);
  });

  it('the auth function reads the current stored token on each (re)connect', async () => {
    sessionStorage.setItem('tagconn.adminToken', 'tca_live');
    const { getSocket } = await import('./socket');
    getSocket();
    const authFn = fakeSocket.auth as (cb: (data: unknown) => void) => void;
    const cb = vi.fn();
    authFn(cb);
    expect(cb).toHaveBeenCalledWith({ adminToken: 'tca_live' });
  });
});

describe('reconnectSocketAuth', () => {
  it('disconnects and reconnects a live socket so the auth fn re-runs', async () => {
    const { getSocket, reconnectSocketAuth } = await import('./socket');
    getSocket();
    reconnectSocketAuth();
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a socket that was never connected', async () => {
    const { getSocket, reconnectSocketAuth } = await import('./socket');
    getSocket();
    fakeSocket.connected = false;
    fakeSocket.active = false;
    reconnectSocketAuth();
    expect(fakeSocket.disconnect).not.toHaveBeenCalled();
    expect(fakeSocket.connect).not.toHaveBeenCalled();
  });
});

describe('emitWithAck / emitWithAckTimeout: timeout-as-unauthorized', () => {
  it('rejects with a plain AckError when there is no connection at all', async () => {
    const { getSocket, emitWithAck, AckError } = await import('./socket');
    getSocket();
    fakeSocket.connected = false;
    await expect(emitWithAck('layouts:list')).rejects.toBeInstanceOf(AckError);
    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });

  it('resolves with the ack data on {ok:true}', async () => {
    const { getSocket, emitWithAck } = await import('./socket');
    getSocket();
    const p = emitWithAck('layouts:list');
    ackCallback()({ ok: true, data: [{ id: 'a' }] });
    await expect(p).resolves.toEqual([{ id: 'a' }]);
  });

  it('rejects with AckError (not AckTimeoutError) on an explicit {ok:false}', async () => {
    const { getSocket, emitWithAck, AckError, AckTimeoutError } = await import('./socket');
    getSocket();
    const p = emitWithAck('layouts:list');
    ackCallback()({ ok: false, error: 'nope' });
    await expect(p).rejects.toThrow('nope');
    await expect(p).rejects.toBeInstanceOf(AckError);
    await expect(p).rejects.not.toBeInstanceOf(AckTimeoutError);
  });

  it("a denied gated event never acks: the client's own timer becomes AckTimeoutError while still connected", async () => {
    const { getSocket, emitWithAckTimeout, AckTimeoutError } = await import('./socket');
    getSocket();
    const p = emitWithAckTimeout(4000, 'auth:sessions');
    vi.advanceTimersByTime(4000);
    await expect(p).rejects.toBeInstanceOf(AckTimeoutError);
  });

  it('never fires late once the ack arrives first (timer is cleared)', async () => {
    const { getSocket, emitWithAckTimeout } = await import('./socket');
    getSocket();
    const p = emitWithAckTimeout(4000, 'auth:sessions');
    ackCallback()({ ok: true, data: [] });
    await expect(p).resolves.toEqual([]);
    // Advancing past the timeout afterwards must not throw an unhandled rejection.
    vi.advanceTimersByTime(10_000);
  });

  it('a disconnect while waiting is a plain AckError, not treated as unauthorized', async () => {
    const { getSocket, emitWithAckTimeout, AckError, AckTimeoutError } = await import('./socket');
    getSocket();
    const p = emitWithAckTimeout(4000, 'auth:sessions');
    fakeSocket.fireDisconnect();
    await expect(p).rejects.toBeInstanceOf(AckError);
    await expect(p).rejects.not.toBeInstanceOf(AckTimeoutError);
    // The timer must be cleared by the disconnect, not fire again later.
    vi.advanceTimersByTime(10_000);
  });
});

describe('socket auth gate (pair before a gated write)', () => {
  const gate = (admin: boolean, onDenied = vi.fn()) => ({ isGated: (e: string) => e === 'settings:update', isAdmin: () => admin, onDenied });

  it('rejects a gated write up front when not paired, without emitting, and asks for pairing', async () => {
    const { getSocket, emitWithAck, setSocketAuthGate, NotAuthorizedError, AckTimeoutError } = await import('./socket');
    getSocket();
    const onDenied = vi.fn();
    setSocketAuthGate(gate(false, onDenied));
    const p = emitWithAck('settings:update', {});
    await expect(p).rejects.toBeInstanceOf(NotAuthorizedError);
    await expect(p).rejects.toBeInstanceOf(AckTimeoutError);
    await expect(p).rejects.toThrow('Pair this browser to make changes');
    expect(onDenied).toHaveBeenCalledWith('settings:update', 'precheck');
    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });

  it('public events and paired browsers still emit', async () => {
    const { getSocket, emitWithAck, setSocketAuthGate } = await import('./socket');
    getSocket();
    setSocketAuthGate(gate(false));
    void emitWithAck('layouts:list');
    setSocketAuthGate(gate(true));
    void emitWithAck('settings:update', {});
    expect(fakeSocket.emit).toHaveBeenCalledTimes(2);
  });

  it('a gated event that times out hands the check to the gate (reason timeout) with a clear message', async () => {
    const { getSocket, emitWithAckTimeout, setSocketAuthGate } = await import('./socket');
    getSocket();
    const onDenied = vi.fn();
    setSocketAuthGate(gate(true, onDenied));
    const p = emitWithAckTimeout(4000, 'settings:update', {});
    vi.advanceTimersByTime(4000);
    await expect(p).rejects.toThrow(/No response from the server for settings:update/);
    expect(onDenied).toHaveBeenCalledWith('settings:update', 'timeout');
  });

  it('a public event that times out keeps the plain timeout message', async () => {
    const { getSocket, emitWithAckTimeout, setSocketAuthGate } = await import('./socket');
    getSocket();
    const onDenied = vi.fn();
    setSocketAuthGate(gate(true, onDenied));
    const p = emitWithAckTimeout(4000, 'layouts:list');
    vi.advanceTimersByTime(4000);
    await expect(p).rejects.toThrow('Timed out waiting for layouts:list');
    expect(onDenied).not.toHaveBeenCalled();
  });
});

describe('authSocket', () => {
  it('sends status/sessions/revoke as real emits', async () => {
    const { getSocket, authSocket } = await import('./socket');
    getSocket();
    void authSocket.status();
    void authSocket.sessions();
    void authSocket.revoke('s1');
    expect(fakeSocket.emit).toHaveBeenCalledTimes(3);
    expect(fakeSocket.emit.mock.calls[0]?.[0]).toBe('auth:status');
    expect(fakeSocket.emit.mock.calls[1]?.[0]).toBe('auth:sessions');
    expect(fakeSocket.emit.mock.calls[2]).toEqual(['auth:revoke', 's1', expect.any(Function)]);
  });

  it('uses a 4s ack timeout: no ack within 4s rejects as AckTimeoutError', async () => {
    const { getSocket, authSocket, AckTimeoutError } = await import('./socket');
    getSocket();
    const p = authSocket.sessions();
    vi.advanceTimersByTime(3999);
    const p2 = expect(p).rejects.toBeInstanceOf(AckTimeoutError);
    vi.advanceTimersByTime(1);
    await p2;
  });
});
