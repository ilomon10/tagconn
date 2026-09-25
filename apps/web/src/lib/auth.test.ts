import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStoredToken,
  consumePairingFragment,
  emitAuthEvent,
  onAuthEvent,
  parsePairingFragment,
  readStoredToken,
  tokenIsRemembered,
  writeStoredToken,
} from './auth';

/** Minimal in-memory `Storage`, so tests exercise the real read/write/remove paths rather than a mock. */
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

const throwingStorage = {
  getItem: () => {
    throw new Error('storage blocked');
  },
  setItem: () => {
    throw new Error('storage blocked');
  },
  removeItem: () => {
    throw new Error('storage blocked');
  },
} as unknown as Storage;

describe('token storage', () => {
  let session: Storage;
  let local: Storage;

  beforeEach(() => {
    session = memoryStorage();
    local = memoryStorage();
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', local);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('readStoredToken is null when nothing is stored', () => {
    expect(readStoredToken()).toBeNull();
  });

  it('writeStoredToken(remember=false) writes sessionStorage only', () => {
    writeStoredToken('tca_abc', false);
    expect(session.getItem('tagconn.adminToken')).toBe('tca_abc');
    expect(local.getItem('tagconn.adminToken')).toBeNull();
    expect(readStoredToken()).toBe('tca_abc');
    expect(tokenIsRemembered()).toBe(false);
  });

  it('writeStoredToken(remember=true) writes localStorage only', () => {
    writeStoredToken('tca_xyz', true);
    expect(local.getItem('tagconn.adminToken')).toBe('tca_xyz');
    expect(session.getItem('tagconn.adminToken')).toBeNull();
    expect(readStoredToken()).toBe('tca_xyz');
    expect(tokenIsRemembered()).toBe(true);
  });

  it('switching from remembered to session-only clears the other storage', () => {
    writeStoredToken('tca_1', true);
    writeStoredToken('tca_2', false);
    expect(local.getItem('tagconn.adminToken')).toBeNull();
    expect(session.getItem('tagconn.adminToken')).toBe('tca_2');
  });

  it('clearStoredToken removes the token from both storages', () => {
    session.setItem('tagconn.adminToken', 'a');
    local.setItem('tagconn.adminToken', 'b');
    clearStoredToken();
    expect(session.getItem('tagconn.adminToken')).toBeNull();
    expect(local.getItem('tagconn.adminToken')).toBeNull();
  });

  it('a storage that throws degrades to "no token" instead of crashing', () => {
    vi.stubGlobal('sessionStorage', throwingStorage);
    vi.stubGlobal('localStorage', throwingStorage);
    expect(readStoredToken()).toBeNull();
    expect(tokenIsRemembered()).toBe(false);
    expect(() => writeStoredToken('tca_x', true)).not.toThrow();
    expect(() => clearStoredToken()).not.toThrow();
  });

  it('readStoredToken never crashes when storage is entirely absent (no stub at all)', () => {
    vi.unstubAllGlobals();
    expect(readStoredToken()).toBeNull();
  });
});

describe('parsePairingFragment', () => {
  it('parses and normalizes a dashed, mixed-case code', () => {
    expect(parsePairingFragment('#pair=abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
  });

  it('is case-insensitive on the "pair" key itself', () => {
    expect(parsePairingFragment('#PAIR=ABCD-EFGH-JKMN')).toBe('ABCDEFGHJKMN');
  });

  it('returns null for an unrelated or empty hash', () => {
    expect(parsePairingFragment('')).toBeNull();
    expect(parsePairingFragment('#office')).toBeNull();
    expect(parsePairingFragment('#pair=')).toBeNull();
  });

  it('returns null instead of throwing on malformed percent-encoding', () => {
    expect(parsePairingFragment('#pair=%')).toBeNull();
  });
});

describe('consumePairingFragment', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the code and replaces history immediately, dropping the fragment', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { hash: '#pair=ABCD-EFGH-JKMN', pathname: '/app', search: '?x=1' },
      history: { replaceState },
    });
    expect(consumePairingFragment()).toBe('ABCDEFGHJKMN');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app?x=1');
  });

  it('is a no-op (and never touches history) when there is no #pair fragment', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', { location: { hash: '#office', pathname: '/app', search: '' }, history: { replaceState } });
    expect(consumePairingFragment()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('degrades to null if `window` is unavailable', () => {
    vi.unstubAllGlobals();
    expect(consumePairingFragment()).toBeNull();
  });
});

describe('auth event bus', () => {
  it('notifies subscribers and stops after unsubscribing', () => {
    const seen: string[] = [];
    const off = onAuthEvent((e) => seen.push(`${e.reason}:${e.message}`));
    emitAuthEvent({ reason: 'unauthenticated', message: 'nope' });
    off();
    emitAuthEvent({ reason: 'timeout', message: 'ignored after unsubscribe' });
    expect(seen).toEqual(['unauthenticated:nope']);
  });
});
