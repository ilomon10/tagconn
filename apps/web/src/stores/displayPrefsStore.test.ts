import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDisplayPrefs, resolveScreenFx, useDisplayPrefsStore } from './displayPrefsStore';

/** Minimal in-memory `Storage`, so tests exercise the real read/write/remove paths rather than a mock
 *  (same helper as `lib/auth.test.ts`/`stores/authStore.test.ts`). */
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
} as unknown as Storage;

const STORAGE_KEY = 'tagconn.display';
const initialState = useDisplayPrefsStore.getState();

describe('readDisplayPrefs', () => {
  let local: Storage;

  beforeEach(() => {
    local = memoryStorage();
    vi.stubGlobal('localStorage', local);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is "no preference" (both null) when nothing is stored', () => {
    expect(readDisplayPrefs()).toEqual({ screenOn: null, screenEffect: null });
  });

  it('round-trips a valid stored value', () => {
    local.setItem(STORAGE_KEY, JSON.stringify({ screenOn: true, screenEffect: 'crt' }));
    expect(readDisplayPrefs()).toEqual({ screenOn: true, screenEffect: 'crt' });
  });

  it('falls back to null fields for a corrupt (non-JSON) value instead of throwing', () => {
    local.setItem(STORAGE_KEY, '{not json');
    expect(readDisplayPrefs()).toEqual({ screenOn: null, screenEffect: null });
  });

  it('falls back to null fields for a value of the wrong shape', () => {
    local.setItem(STORAGE_KEY, JSON.stringify('just a string'));
    expect(readDisplayPrefs()).toEqual({ screenOn: null, screenEffect: null });

    local.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(readDisplayPrefs()).toEqual({ screenOn: null, screenEffect: null });
  });

  it('drops an invalid screenEffect (not one of crt/lcd/vhs) but keeps a valid screenOn', () => {
    local.setItem(STORAGE_KEY, JSON.stringify({ screenOn: false, screenEffect: 'plasma' }));
    expect(readDisplayPrefs()).toEqual({ screenOn: false, screenEffect: null });
  });

  it('drops a wrong-typed screenOn but keeps a valid screenEffect', () => {
    local.setItem(STORAGE_KEY, JSON.stringify({ screenOn: 'yes', screenEffect: 'vhs' }));
    expect(readDisplayPrefs()).toEqual({ screenOn: null, screenEffect: 'vhs' });
  });

  it('degrades to "no preference" when storage itself throws, instead of crashing', () => {
    vi.stubGlobal('localStorage', throwingStorage);
    expect(readDisplayPrefs()).toEqual({ screenOn: null, screenEffect: null });
  });
});

describe('useDisplayPrefsStore', () => {
  let local: Storage;

  beforeEach(() => {
    local = memoryStorage();
    vi.stubGlobal('localStorage', local);
    useDisplayPrefsStore.setState(initialState, true);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('setScreenOn updates state and persists alongside the current screenEffect', () => {
    useDisplayPrefsStore.getState().setScreenEffect('lcd');
    useDisplayPrefsStore.getState().setScreenOn(true);
    expect(useDisplayPrefsStore.getState().screenOn).toBe(true);
    expect(JSON.parse(local.getItem(STORAGE_KEY) ?? '{}')).toEqual({ screenOn: true, screenEffect: 'lcd' });
  });

  it('setScreenEffect updates state and persists alongside the current screenOn', () => {
    useDisplayPrefsStore.getState().setScreenOn(false);
    useDisplayPrefsStore.getState().setScreenEffect('vhs');
    expect(useDisplayPrefsStore.getState().screenEffect).toBe('vhs');
    expect(JSON.parse(local.getItem(STORAGE_KEY) ?? '{}')).toEqual({ screenOn: false, screenEffect: 'vhs' });
  });

  it('reset() clears both fields back to null (follow the server default) and persists that', () => {
    useDisplayPrefsStore.getState().setScreenOn(true);
    useDisplayPrefsStore.getState().setScreenEffect('crt');
    useDisplayPrefsStore.getState().reset();
    expect(useDisplayPrefsStore.getState()).toMatchObject({ screenOn: null, screenEffect: null });
    expect(JSON.parse(local.getItem(STORAGE_KEY) ?? '{}')).toEqual({ screenOn: null, screenEffect: null });
  });

  it('a setter still updates in-memory state even if storage throws on write', () => {
    vi.stubGlobal('localStorage', throwingStorage);
    expect(() => useDisplayPrefsStore.getState().setScreenOn(true)).not.toThrow();
    expect(useDisplayPrefsStore.getState().screenOn).toBe(true);
  });
});

describe('resolveScreenFx', () => {
  it('follows the server when both prefs are null', () => {
    expect(resolveScreenFx('off', { screenOn: null, screenEffect: null })).toEqual({ on: false, effect: 'crt' });
    expect(resolveScreenFx('lcd', { screenOn: null, screenEffect: null })).toEqual({ on: true, effect: 'lcd' });
  });

  it('an explicit screenOn overrides the server default, keeping the server effect', () => {
    expect(resolveScreenFx('off', { screenOn: true, screenEffect: null })).toEqual({ on: true, effect: 'crt' });
    expect(resolveScreenFx('vhs', { screenOn: false, screenEffect: null })).toEqual({ on: false, effect: 'vhs' });
  });

  it('an explicit screenEffect overrides the server effect, keeping the server on/off', () => {
    expect(resolveScreenFx('crt', { screenOn: null, screenEffect: 'lcd' })).toEqual({ on: true, effect: 'lcd' });
    expect(resolveScreenFx('off', { screenOn: null, screenEffect: 'vhs' })).toEqual({ on: false, effect: 'vhs' });
  });

  it('both prefs set wins outright, regardless of the server', () => {
    expect(resolveScreenFx('off', { screenOn: true, screenEffect: 'lcd' })).toEqual({ on: true, effect: 'lcd' });
  });
});
