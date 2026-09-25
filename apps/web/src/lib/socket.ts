import { io, type Socket } from 'socket.io-client';
import {
  OFFICE_NAMESPACE,
  type ClientToServerEvents,
  type HeroCreate,
  type HeroListRequest,
  type HeroPatch,
  type LayoutAssign,
  type OfficeHandshakeAuth,
  type OfficeLayoutInput,
  type ServerToClientEvents,
} from '@tagconn/shared';
import { readStoredToken } from './auth';

export type OfficeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: OfficeSocket | null = null;

/**
 * Lazily created singleton; same origin (vite/nginx proxy `/socket.io`). Not connected until
 * `.connect()`. `auth` is a function (rather than a plain object) so socket.io re-reads the current
 * token from storage on every (re)connect attempt — see `reconnectSocketAuth` for the "a new token
 * needs a new handshake" half of that (M8 8m, docs/design/runner-and-helpdesk.md section 5.3).
 */
export function getSocket(): OfficeSocket {
  if (!socket) {
    socket = io(OFFICE_NAMESPACE, {
      path: '/socket.io',
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket', 'polling'],
      auth: (cb) => cb({ adminToken: readStoredToken() ?? undefined } satisfies OfficeHandshakeAuth),
    });
  }
  return socket;
}

/** Re-handshakes with whatever token is currently stored. socket.io only calls the `auth` function
 *  above when it (re)connects, not mid-session, so pairing, logging out, and a revoke-all all need to
 *  force one of these to actually pick up the change. A no-op if the socket was never connected. */
export function reconnectSocketAuth(): void {
  const s = getSocket();
  if (s.connected || s.active) {
    s.disconnect();
    s.connect();
  }
}

type C2S = ClientToServerEvents;
type AckPayload<F> = F extends (...args: [...infer _A, infer Cb]) => void
  ? Cb extends (res: infer R) => void
    ? R extends { ok: true; data: infer D }
      ? D
      : never
    : never
  : never;
type AckArgs<F> = F extends (...args: [...infer A, infer _Cb]) => void ? A : never;

export class AckError extends Error {}

/** A gated socket event that was denied never acks at all (fail closed — see
 *  docs/design/runner-and-helpdesk.md section 5.3), so a timeout here is the client's only signal
 *  that the current session isn't authorized, rather than a slow network. Callers that care about the
 *  distinction (the auth store, `useRequireAdmin`) treat this differently from a `{ok:false}` server
 *  error or a mid-flight disconnect (which stays a plain `AckError` — the connection banner already
 *  covers that case). */
export class AckTimeoutError extends AckError {}

const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/**
 * Same as `emitWithAck`, but with an explicit ack timeout. Deliberately a plain `setTimeout` (rather
 * than socket.io's own `.timeout()`/ack-timeout option) plus a one-shot `disconnect` listener, instead
 * of relying on the client library's built-in ack-timeout machinery, which was found to fire spuriously
 * fast for a still-open, still-answering connection when proxied through vite/nginx — this is the same
 * timer-based approach the rest of this file always used, just parameterized by `ms` and split into
 * `AckTimeoutError` vs a plain `AckError` on disconnect.
 */
export function emitWithAckTimeout<E extends keyof C2S>(ms: number, event: E, ...args: AckArgs<C2S[E]>): Promise<AckPayload<C2S[E]>> {
  const s = getSocket();
  if (!s.connected) return Promise.reject(new AckError('Not connected to the office server'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onDisconnect = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AckError(`Disconnected while waiting for ${String(event)}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      s.off('disconnect', onDisconnect);
      reject(new AckTimeoutError(`Timed out waiting for ${String(event)}`));
    }, ms);
    s.once('disconnect', onDisconnect);
    const cb = (res: { ok: true; data: unknown } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.off('disconnect', onDisconnect);
      if (res && res.ok) resolve(res.data as AckPayload<C2S[E]>);
      else reject(new AckError(res?.error ?? 'Unknown server error'));
    };
    // socket.io's typed emit cannot express "args + trailing ack" generically; the public signature
    // above is typed.
    (s.emit as unknown as (ev: string, ...rest: unknown[]) => void)(event, ...args, cb);
  });
}

/** Emit a client→server event and resolve with the ack's `data` (rejects on `{ok:false}` or timeout). */
export function emitWithAck<E extends keyof C2S>(event: E, ...args: AckArgs<C2S[E]>): Promise<AckPayload<C2S[E]>> {
  return emitWithAckTimeout(DEFAULT_ACK_TIMEOUT_MS, event, ...args);
}

/** M7 office editor: typed wrappers around the `layouts:*` acked events (guild-hall.md section 2). */
export const layoutSocket = {
  list: () => emitWithAck('layouts:list'),
  get: (id: string) => emitWithAck('layouts:get', id),
  save: (layout: OfficeLayoutInput) => emitWithAck('layouts:save', layout),
  delete: (id: string) => emitWithAck('layouts:delete', id),
  assign: (req: LayoutAssign) => emitWithAck('layouts:assign', req),
};

/** M8 8i heroes: typed wrappers around the `heroes:*` acked events (living-office.md section 2.2/3.3). */
export const heroSocket = {
  list: (req: HeroListRequest = {}) => emitWithAck('heroes:list', req),
  create: (req: HeroCreate) => emitWithAck('heroes:create', req),
  update: (id: string, patch: HeroPatch) => emitWithAck('heroes:update', { id, patch }),
  reset: (id: string) => emitWithAck('heroes:reset', id),
  delete: (id: string) => emitWithAck('heroes:delete', id),
};

/** M8 8m admin auth: typed wrappers around the `auth:*` acked events (runner-and-helpdesk.md section
 *  5.3). `auth:status` is public and always acks; `sessions`/`revoke` are always-gated, so a timeout
 *  here (`AckTimeoutError`) means "not authorized", handled by `stores/authStore.ts`. A short custom
 *  timeout keeps that gentle prompt responsive instead of making the user wait 10s for it. */
const AUTH_ACK_TIMEOUT_MS = 4_000;

export const authSocket = {
  status: () => emitWithAckTimeout(AUTH_ACK_TIMEOUT_MS, 'auth:status'),
  sessions: () => emitWithAckTimeout(AUTH_ACK_TIMEOUT_MS, 'auth:sessions'),
  revoke: (sessionId: string) => emitWithAckTimeout(AUTH_ACK_TIMEOUT_MS, 'auth:revoke', sessionId),
};
