import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAudioPrefs, useAudioPrefsStore } from './audioPrefsStore';

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
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

const KEY = 'tagconn.audio';

describe('readAudioPrefs', () => {
  let local: Storage;
  beforeEach(() => {
    local = memoryStorage();
    vi.stubGlobal('localStorage', local);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to follow-the-server', () => {
    expect(readAudioPrefs()).toEqual({ muted: null, volume: null });
  });
  it('reads valid values and clamps volume', () => {
    local.setItem(KEY, JSON.stringify({ muted: true, volume: 3 }));
    expect(readAudioPrefs()).toEqual({ muted: true, volume: 1 });
  });
  it('ignores wrong types and bad JSON', () => {
    local.setItem(KEY, JSON.stringify({ muted: 'yes', volume: 'loud' }));
    expect(readAudioPrefs()).toEqual({ muted: null, volume: null });
    local.setItem(KEY, '{nope');
    expect(readAudioPrefs()).toEqual({ muted: null, volume: null });
    local.setItem(KEY, 'null');
    expect(readAudioPrefs()).toEqual({ muted: null, volume: null });
  });
  it('never throws on blocked storage', () => {
    vi.stubGlobal('localStorage', throwingStorage);
    expect(readAudioPrefs()).toEqual({ muted: null, volume: null });
    expect(() => useAudioPrefsStore.getState().setMuted(true)).not.toThrow();
  });
});

describe('useAudioPrefsStore', () => {
  let local: Storage;
  beforeEach(() => {
    local = memoryStorage();
    vi.stubGlobal('localStorage', local);
    useAudioPrefsStore.getState().reset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('persists mute and clamped volume', () => {
    const s = useAudioPrefsStore.getState();
    s.setMuted(true);
    s.setVolume(1.7);
    expect(useAudioPrefsStore.getState().volume).toBe(1);
    expect(JSON.parse(local.getItem(KEY) as string)).toEqual({ muted: true, volume: 1 });
    s.setVolume(-2);
    expect(useAudioPrefsStore.getState().volume).toBe(0);
  });
  it('reset clears both', () => {
    const s = useAudioPrefsStore.getState();
    s.setMuted(false);
    s.setVolume(0.2);
    s.reset();
    expect(useAudioPrefsStore.getState().muted).toBeNull();
    expect(useAudioPrefsStore.getState().volume).toBeNull();
    expect(JSON.parse(local.getItem(KEY) as string)).toEqual({ muted: null, volume: null });
  });
});
