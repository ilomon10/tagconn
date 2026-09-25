import { ADMIN_TOKEN_STORAGE_KEY, normalizePairingCode, PAIRING_FRAGMENT_KEY } from '@tagconn/shared';

/**
 * M8 8m admin auth, browser side (docs/design/runner-and-helpdesk.md section 5). This module owns the
 * two pieces of state that live outside React/zustand: where the token is stored, and the one-shot
 * `#pair=<code>` URL fragment. `stores/authStore.ts` is the only thing that calls into it besides
 * `lib/api.ts`/`lib/socket.ts` (which attach the token to requests) — everything else should go
 * through the store.
 *
 * Storage is sessionStorage by default; only an explicit "Remember on this device" choice promotes it
 * to localStorage (T7 in the design doc: localStorage is the more valuable XSS target, so it's opt-in).
 * Every access is wrapped in try/catch — storage can throw (private browsing, blocked cookies, quota)
 * or simply not exist (SSR, this file's own tests), and either way the right fallback is "no token"
 * rather than a crash.
 */

export function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Whether a stored token (if any) was "remembered" — the pairing dialog's checkbox reopens with this
 *  as its default, so re-pairing doesn't silently downgrade an already-persistent session. */
export function tokenIsRemembered(): boolean {
  try {
    return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function writeStoredToken(token: string, remember: boolean): void {
  try {
    if (remember) {
      localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
      sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    } else {
      sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable — the token simply won't survive a reload; better than throwing mid-pair.
  }
}

export function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ------------------------------------------------------------------ pairing fragment

const PAIR_HASH_RE = new RegExp(`^#${PAIRING_FRAGMENT_KEY}=(.+)$`, 'i');

/** Pure parse of a `location.hash`-shaped string, e.g. `#pair=ABCD-EFGH-JKMN`. Split out from
 *  `consumePairingFragment` so it's testable without touching `window`. */
export function parsePairingFragment(hash: string): string | null {
  const m = PAIR_HASH_RE.exec(hash);
  if (!m?.[1]) return null;
  try {
    return normalizePairingCode(decodeURIComponent(m[1])) || null;
  } catch {
    return null; // malformed percent-encoding
  }
}

/**
 * Reads `#pair=<code>` off the current URL (the format `pnpm office:pair` prints) and removes it from
 * history immediately via `replaceState`, so it never lingers in the address bar, browser history, or
 * a `Referer` header (T8). Returns the normalized code, or null if there was none.
 */
export function consumePairingFragment(): string | null {
  try {
    const code = parsePairingFragment(window.location.hash);
    if (!code) return null;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return code;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ centralized 401 / ack-timeout handling

/** Why an in-flight admin action was dropped. `unauthenticated` = a REST 401. `timeout` = a gated
 *  socket event that never acked (see `lib/socket.ts`'s `AckTimeoutError`) — a denied gated event
 *  never acks at all, so a timeout there means "not authorized", not "slow network". `revoked` = the
 *  server pushed `auth:changed` with `admin: false` (session revoked or expired elsewhere). */
export type AuthEventReason = 'unauthenticated' | 'timeout' | 'revoked';

export interface AuthEvent {
  reason: AuthEventReason;
  message: string;
}

type AuthEventListener = (e: AuthEvent) => void;

const authEventListeners = new Set<AuthEventListener>();

/** `stores/authStore.ts` subscribes once at module load to turn these into store state (clearing the
 *  token, dropping `admin` to false, showing the toast) — kept as a tiny pub/sub here instead of a
 *  direct import so `lib/api.ts`/`lib/socket.ts` don't need to import the store back. */
export function onAuthEvent(cb: AuthEventListener): () => void {
  authEventListeners.add(cb);
  return () => authEventListeners.delete(cb);
}

export function emitAuthEvent(e: AuthEvent): void {
  for (const l of authEventListeners) l(e);
}

/** The gentle prompt shown wherever a write was blocked instead of failing silently (design doc
 *  section 5.3, "Web" bullet). */
export const PAIR_TO_CHANGE_MESSAGE = 'Pair this browser to make changes';
