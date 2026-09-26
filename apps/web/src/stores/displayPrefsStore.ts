import { create } from 'zustand';
import type { ScreenEffect } from '@tagconn/shared';

/**
 * Per-browser display preferences (M9, docs/decisions.md #25): the monitor screen effect
 * (CRT/LCD/VHS) is a display preference layered over the server's `office.shaders.screen` default,
 * not an admin-gated settings write — every browser picks its own, with no pairing needed. Persisted
 * under localStorage key `tagconn.display`; every access is wrapped in try/catch (storage can throw
 * or simply not exist — private browsing, blocked cookies, quota, SSR, this file's own tests) and
 * falls back to "no preference" (follow the server default) rather than crashing, same convention as
 * `lib/auth.ts`'s token storage.
 */

export const SCREEN_EFFECT_PREFS = ['crt', 'lcd', 'vhs'] as const;
export type ScreenEffectPref = (typeof SCREEN_EFFECT_PREFS)[number];

const STORAGE_KEY = 'tagconn.display';

interface StoredDisplayPrefs {
  /** `null` = follow the server's `office.shaders.screen !== 'off'`. */
  screenOn: boolean | null;
  /** `null` = follow the server's `office.shaders.screen` (falling back to `'crt'` if the server
   *  itself is off — see `OfficeView`'s `push()`). */
  screenEffect: ScreenEffectPref | null;
}

const EMPTY_PREFS: StoredDisplayPrefs = { screenOn: null, screenEffect: null };

function isScreenEffectPref(v: unknown): v is ScreenEffectPref {
  return typeof v === 'string' && (SCREEN_EFFECT_PREFS as readonly string[]).includes(v);
}

/** Reads and validates `localStorage['tagconn.display']`. A missing key, unavailable storage, invalid
 *  JSON, or a value of the wrong shape/type all fall back to `EMPTY_PREFS` (never throws). */
export function readDisplayPrefs(): StoredDisplayPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_PREFS;
    const p = parsed as Record<string, unknown>;
    return {
      screenOn: typeof p.screenOn === 'boolean' ? p.screenOn : null,
      screenEffect: isScreenEffectPref(p.screenEffect) ? p.screenEffect : null,
    };
  } catch {
    return EMPTY_PREFS;
  }
}

function writeDisplayPrefs(prefs: StoredDisplayPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable — the preference just won't survive a reload; better than throwing mid-toggle.
  }
}

export interface DisplayPrefsState {
  screenOn: boolean | null;
  screenEffect: ScreenEffectPref | null;
  setScreenOn(on: boolean | null): void;
  setScreenEffect(effect: ScreenEffectPref | null): void;
  /** Back to "follow the server default" for both fields (the top bar's "Use server default"). */
  reset(): void;
}

const initial = readDisplayPrefs();

export const useDisplayPrefsStore = create<DisplayPrefsState>()((set, get) => ({
  screenOn: initial.screenOn,
  screenEffect: initial.screenEffect,

  setScreenOn: (on) => {
    set({ screenOn: on });
    writeDisplayPrefs({ screenOn: on, screenEffect: get().screenEffect });
  },

  setScreenEffect: (effect) => {
    set({ screenEffect: effect });
    writeDisplayPrefs({ screenOn: get().screenOn, screenEffect: effect });
  },

  reset: () => {
    set({ screenOn: null, screenEffect: null });
    writeDisplayPrefs(EMPTY_PREFS);
  },
}));

/**
 * Folds this browser's preference over the server default (`office.shaders.screen`) into a concrete
 * `{ on, effect }` — the shape `OfficeState.screenFx` and the top bar's button both want. `null`
 * fields "follow the server": `on` defaults to whether the server itself has an effect selected, and
 * `effect` defaults to the server's own choice, falling back to `'crt'` if the server is off too (so
 * turning the browser's toggle on always shows *something* rather than nothing).
 */
export function resolveScreenFx(serverScreen: ScreenEffect, prefs: Pick<DisplayPrefsState, 'screenOn' | 'screenEffect'>): { on: boolean; effect: ScreenEffectPref } {
  const on = prefs.screenOn ?? serverScreen !== 'off';
  const effect = prefs.screenEffect ?? (serverScreen !== 'off' ? serverScreen : 'crt');
  return { on, effect };
}
