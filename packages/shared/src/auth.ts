import { z } from 'zod';
import type { Ack } from './socket.js';

/**
 * M8 GUI admin auth (8m, decision 12 revisited) + the HMAC challenge-response used by the host
 * runner and `pnpm office:pair`. See docs/design/runner-and-helpdesk.md ("Admin auth").
 *
 * Three independent credentials:
 *   - hook token   (`x-office-token`): ingest only (/api/hooks, /api/attribution/import)
 *   - runner token (never on the wire): proves possession via HMAC; /runner namespace + pairing codes
 *   - admin token  (`tca_...` bearer): browser admin session; "an admin session = code execution as the host user"
 *
 * This file is shared with the browser, so it only defines message FORMATS; the HMAC itself is
 * computed with node:crypto on the server / runner / scripts (HMAC-SHA256, key = UTF-8 bytes of the
 * token, output base64url without padding), compared with timingSafeEqual.
 */

// ------------------------------------------------------------------ HMAC challenge-response

/** 32 random bytes, base64url, no padding. Also the shape of an HMAC-SHA256 proof. */
export const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
export const PROOF_RE = NONCE_RE;

export const HMAC_CONTEXTS = {
  runner: 'tagconn-runner-v1',
  pairing: 'tagconn-pair-v1',
} as const;
export type HmacContext = (typeof HMAC_CONTEXTS)[keyof typeof HMAC_CONTEXTS];

/**
 * Canonical HMAC input: `<context>|<role>|<part1>|<part2>...`. Parts never contain `|` (nonces,
 * proofs and instance ids are base64url / uuid). Role separation ("server" vs "runner"/"client")
 * prevents reflecting one side's proof back as the other's.
 *
 * Runner namespace (all three steps must succeed before ANY other event is processed either side):
 *   1. runner -> server  handshake auth {runnerId, protocol, nonce: Nr}
 *   2. server -> runner  'runner:challenge' {nonce: Ns, proof: HMAC(token, msg(runner,'server',Nr,Ns))}
 *      runner verifies; on mismatch it disconnects and never acts on anything from that socket
 *   3. runner -> server  'runner:prove' {proof: HMAC(token, msg(runner,'runner',Ns,Nr))}
 *      server verifies; on mismatch or after RUNNER_PROOF_TIMEOUT_MS it disconnects
 * Pairing (`pnpm office:pair`, plain HTTP to the server port):
 *   1. POST /api/auth/pairing-challenge {nonce: Nc}
 *      -> {challengeId, nonce: Ns, instanceId, proof: HMAC(token, msg(pairing,'server',Nc,Ns,instanceId))}
 *   2. client verifies, then POST /api/auth/pairing-codes {challengeId, proof: HMAC(token, msg(pairing,'client',Ns,Nc))}
 */
export const proofMessage = (context: HmacContext, role: 'server' | 'runner' | 'client', ...parts: string[]): string =>
  [context, role, ...parts].join('|');

export const RUNNER_PROOF_TIMEOUT_MS = 5_000;
export const PAIRING_CHALLENGE_TTL_MS = 30_000;

export const PairingChallengeRequestSchema = z.strictObject({ nonce: z.string().regex(NONCE_RE) });
export type PairingChallengeRequest = z.infer<typeof PairingChallengeRequestSchema>;

export interface PairingChallengeResponse {
  /** Single use, expires after PAIRING_CHALLENGE_TTL_MS. */
  challengeId: string;
  nonce: string;
  /** Random per server boot; also returned by GET /api/health so `office:pair`/doctor can compare it through the web proxy. */
  instanceId: string;
  proof: string;
}

export const PairingCodeRequestSchema = z.strictObject({
  challengeId: z.string().min(1).max(64),
  proof: z.string().regex(PROOF_RE),
});
export type PairingCodeRequest = z.infer<typeof PairingCodeRequestSchema>;

// ------------------------------------------------------------------ admin sessions

export const AUTH_MODES = ['pairing', 'same-origin'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const AUTH_PROTECT_LEVELS = ['execution', 'all-writes'] as const;
export type AuthProtectLevel = (typeof AUTH_PROTECT_LEVELS)[number];

/** `tca_` + 32 random bytes base64url (43 chars). Stored server-side only as sha256. */
export const ADMIN_TOKEN_PREFIX = 'tca_';
export const ADMIN_TOKEN_RE = /^tca_[A-Za-z0-9_-]{43}$/;

/**
 * Crockford base32 (no I, L, O, U), 3 x 4 chars = 60 bits, displayed "ABCD-EFGH-JKMN"; case-insensitive.
 * 60 bits + the global attempt rate limit make brute force infeasible, so there is NO per-code
 * lockout (a lockout would let anyone burn the user's code: a cheap DoS).
 */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 12;
export const PAIRING_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/;
export const normalizePairingCode = (raw: string): string => raw.trim().toUpperCase().replace(/-/g, '');

/** The UI reads `#pair=<code>` from the URL fragment (never sent to servers or in Referer), then clears it. */
export const PAIRING_FRAGMENT_KEY = 'pair';

/** socket.io room that receives admin-only broadcasts (runs, runner status, receptionist, pending imports). */
export const ADMIN_ROOM = 'admin';
/** Interval of the sweep that evicts expired/revoked sockets from ADMIN_ROOM (in addition to per-packet checks). */
export const ADMIN_ROOM_SWEEP_MS = 60_000;

/** Browser storage key for the admin token (localStorage; see XSS notes in the design doc). */
export const ADMIN_TOKEN_STORAGE_KEY = 'tagconn.adminToken';

export const PairRequestSchema = z.strictObject({
  code: z
    .string()
    .max(20)
    .transform(normalizePairingCode)
    .pipe(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{12}$/)),
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
  protect: AuthProtectLevel;
}

export interface PairingCodeResponse {
  code: string;
  /** e.g. http://localhost:4318/#pair=ABCD-EFGH-JKMN (first entry of server.corsOrigins). */
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

// ------------------------------------------------------------------ fail-closed gating

/**
 * REST: every `/api/*` route MUST declare `config.access`; the server refuses to boot otherwise
 * (onRoute check). `admin-write` = admin only when settings.auth.protect = "all-writes";
 * `admin` = always admin (execution, ~/.claude writes, auth management).
 */
export const REST_ACCESS_LEVELS = ['public', 'admin-write', 'admin', 'hook', 'runner'] as const;
export type RestAccessLevel = (typeof REST_ACCESS_LEVELS)[number];

/**
 * Socket (/office): FAIL CLOSED. An event in PUBLIC_SOCKET_EVENTS is open; an event in
 * ADMIN_SOCKET_EVENTS_WRITES needs an admin session when protect = "all-writes"; EVERY OTHER event
 * (including ones added later and forgotten here) always needs an admin session, re-checked per packet.
 * Living-office (heroes/multiverse) read events must be added to the public list by that design.
 */
export const PUBLIC_SOCKET_EVENTS = [
  'office:subscribe',
  'settings:get',
  'roles:list',
  'layouts:list',
  'layouts:get',
  'auth:status',
] as const;

/** Cosmetic writes: gated only when protect = "all-writes" (the default). */
export const ADMIN_SOCKET_EVENTS_WRITES = [
  'settings:update',
  'settings:reset',
  'layouts:save',
  'layouts:delete',
  'layouts:assign',
] as const;

/**
 * Known always-gated events (documentation + test fixture; the server gates anything outside the two
 * lists above anyway). roles:* are here because they write into ~/.claude/agents.
 */
export const ADMIN_SOCKET_EVENTS_EXECUTION = [
  'roles:save',
  'roles:delete',
  'roles:sync',
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
