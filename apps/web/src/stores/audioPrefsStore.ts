import { create } from 'zustand';
import type { AudioPrefs } from '../lib/audio/types';

/**
 * Per-browser audio preferences (M13, docs/decisions.md #25, same pattern as `displayPrefsStore`): mute and
 * volume are layered over the server's `office.sound` / `office.audio.volume`, with no admin write. Persisted under
 * localStorage key `tagconn.audio`; every access is wrapped in try/catch and falls back to "no preference"
 * (follow the server) rather than throwing.
 */

const STORAGE_KEY = 'tagconn.audio';

const EMPTY_PREFS: AudioPrefs = { muted: null, volume: null };

export function clampVolume(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Reads and validates `localStorage['tagconn.audio']`; anything missing or malformed means "follow the server". */
export function readAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_PREFS;
    const p = parsed as Record<string, unknown>;
    return {
      muted: typeof p.muted === 'boolean' ? p.muted : null,
      volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? clampVolume(p.volume) : null,
    };
  } catch {
    return EMPTY_PREFS;
  }
}

function writeAudioPrefs(prefs: AudioPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: the preference just won't survive a reload.
  }
}

export interface AudioPrefsState extends AudioPrefs {
  setMuted(muted: boolean | null): void;
  /** Clamped to 0..1; `null` follows the server. */
  setVolume(volume: number | null): void;
  /** Back to "follow the server default" for both fields. */
  reset(): void;
}

const initial = readAudioPrefs();

export const useAudioPrefsStore = create<AudioPrefsState>()((set, get) => ({
  muted: initial.muted,
  volume: initial.volume,

  setMuted: (muted) => {
    set({ muted });
    writeAudioPrefs({ muted, volume: get().volume });
  },

  setVolume: (volume) => {
    const v = volume === null || !Number.isFinite(volume) ? null : clampVolume(volume);
    set({ volume: v });
    writeAudioPrefs({ muted: get().muted, volume: v });
  },

  reset: () => {
    set({ muted: null, volume: null });
    writeAudioPrefs(EMPTY_PREFS);
  },
}));
