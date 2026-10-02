import { create } from 'zustand';
import type { ScreenEffect } from '@tagconn/shared';
import type { LightingOverride } from '../game/lighting/clock';

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
  /** M16: `null` = follow the office clock; otherwise the host-local decimal hour this browser pins the sun to. */
  lightingHour: number | null;
}

const EMPTY_PREFS: StoredDisplayPrefs = { screenOn: null, screenEffect: null, lightingHour: null };

/** A usable override hour: finite and within [0, 24]. NaN, 25 and strings all mean "follow the server". */
function validHour(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 24 ? v : null;
}

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
      lightingHour: validHour(p.lightingHour),
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
  lightingHour: number | null;
  setScreenOn(on: boolean | null): void;
  setScreenEffect(effect: ScreenEffectPref | null): void;
  /** Pins the sun to a host-local hour for this browser; `null` (or an invalid hour) follows the server. */
  setLightingHour(hour: number | null): void;
  /** Back to "follow the server default" for both fields (the top bar's "Use server default"). */
  reset(): void;
}

const initial = readDisplayPrefs();

export const useDisplayPrefsStore = create<DisplayPrefsState>()((set, get) => ({
  screenOn: initial.screenOn,
  screenEffect: initial.screenEffect,
  lightingHour: initial.lightingHour,

  setScreenOn: (on) => {
    set({ screenOn: on });
    writeDisplayPrefs({ screenOn: on, screenEffect: get().screenEffect, lightingHour: get().lightingHour });
  },

  setScreenEffect: (effect) => {
    set({ screenEffect: effect });
    writeDisplayPrefs({ screenOn: get().screenOn, screenEffect: effect, lightingHour: get().lightingHour });
  },

  setLightingHour: (hour) => {
    const lightingHour = validHour(hour);
    set({ lightingHour });
    writeDisplayPrefs({ screenOn: get().screenOn, screenEffect: get().screenEffect, lightingHour });
  },

  // The screen-effect "Use server default": the time-of-day row has its own Default button.
  reset: () => {
    set({ screenOn: null, screenEffect: null });
    writeDisplayPrefs({ ...EMPTY_PREFS, lightingHour: get().lightingHour });
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

/** The per-browser sun override for `OfficeState.lightingOverride`; `undefined` = follow the server. */
export function resolveLightingOverride(prefs: Pick<DisplayPrefsState, 'lightingHour'>): LightingOverride | undefined {
  const hour = validHour(prefs.lightingHour);
  return hour === null ? undefined : { hour };
}
