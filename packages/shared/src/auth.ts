import { z } from 'zod';
import type { Ack } from './socket.js';

/**
 * M8 GUI admin auth (8m, decision 12 revisited). Opaque bearer session tokens, issued to a browser
 * after pairing (default) or same-origin bootstrap (opt-in). Separate from the hook token
 * (`x-office-token`, ingest only) and the runner token (namespace /runner only).
 * See docs/design/runner-and-helpdesk.md ("Admin auth").
 */

export const AUTH_MODES = ['pairing', 'same-origin'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const AUTH_PROTECT_LEVELS = ['execution', 'all-writes'] as const;
export type AuthProtectLevel = (typeof AUTH_PROTECT_LEVELS)[number];

/** `tca_` + 32 random bytes base64url (43 chars). Stored server-side only as sha256. */
export const ADMIN_TOKEN_PREFIX = 'tca_';
export const ADMIN_TOKEN_RE = /^tca_[A-Za-z0-9_-]{43}$/;

/** Crockford base32 (no I, L, O, U), 2 x 4 chars, displayed as "ABCD-EFGH"; input is case-insensitive. */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/;
export const normalizePairingCode = (raw: string): string => raw.trim().toUpperCase().replace(/-/g, '');

/** The UI reads `#pair=<code>` from the URL fragment (never sent to servers or in Referer), then clears it. */
export const PAIRING_FRAGMENT_KEY = 'pair';

/** socket.io room that receives admin-only broadcasts (runs, runner status, receptionist, pending imports). */
export const ADMIN_ROOM = 'admin';

/** Browser storage key for the admin token (localStorage; see XSS notes in the design doc). */
export const ADMIN_TOKEN_STORAGE_KEY = 'tagconn.adminToken';

export const PairRequestSchema = z.strictObject({
  code: z
    .string()
    .max(16)
    .transform(normalizePairingCode)
    .pipe(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/)),
  /** Free-text label shown in the session list, e.g. "Firefox on laptop". */
  label: z.string().trim().max(80).optional(),
});
export type PairRequest = z.input<typeof PairRequestSchema>;

export const BootstrapRequestSchema = z.strictObject({
  label: z.string().trim().max(80).optional(),
});
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;

export interface AuthTokenResponse {
  token: string;
  sessionId: string;
  /** Epoch ms; sliding (idle) expiry, capped by the absolute max age. */
  expiresAt: number;
}

export interface AuthStatus {
  mode: AuthMode;
  /** Whether the presented token (if any) is a valid admin session. */
  admin: boolean;
  sessionId?: string;
  expiresAt?: number;
  /** Which admin-gated surface is protected: code execution only, or every write. */
  protect: AuthProtectLevel;
}

export interface PairingCodeResponse {
  code: string;
  /** e.g. http://localhost:4318/#pair=ABCD-EFGH (first entry of server.corsOrigins). */
  url: string;
  expiresAt: number;
}

export interface AdminSessionInfo {
  id: string;
  label?: string;
  /** Truncated User-Agent at pairing time. */
  userAgent?: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
}

/** socket.io `auth` payload for namespace /office. Unauthenticated sockets stay read-only observers. */
export interface OfficeHandshakeAuth {
  adminToken?: string;
}

/**
 * Socket events that require an admin session (namespace /office), whatever settings.auth.protect is.
 * Security regression tests iterate these lists, so every new privileged event MUST be added here.
 */
export const ADMIN_SOCKET_EVENTS_EXECUTION = [
  'runs:list',
  'runs:get',
  'runs:start',
  'runs:followUp',
  'runs:stop',
  'runner:getStatus',
  'receptionist:list',
  'receptionist:get',
  'receptionist:create',
  'receptionist:send',
  'receptionist:stop',
  'receptionist:delete',
  'attribution:pendingList',
  'attribution:save',
  'attribution:resolve',
  'auth:sessions',
  'auth:revoke',
] as const;

/** Additionally gated when settings.auth.protect = "all-writes" (the default). */
export const ADMIN_SOCKET_EVENTS_WRITES = [
  'settings:update',
  'settings:reset',
  'roles:save',
  'roles:delete',
  'roles:sync',
  'layouts:save',
  'layouts:delete',
  'layouts:assign',
] as const;

export interface AuthServerToClientEvents {
  /** Sent to one socket after its session expires or is revoked (the client drops the token). */
  'auth:changed': (s: AuthStatus) => void;
}

export interface AuthClientToServerEvents {
  'auth:status': (ack: Ack<AuthStatus>) => void;
  'auth:sessions': (ack: Ack<AdminSessionInfo[]>) => void;
  /** Revoke one session, or "*" for all (including the caller's). */
  'auth:revoke': (sessionId: string, ack: Ack<true>) => void;
}
