import {
  ADMIN_ROOM,
  ADMIN_ROOM_SWEEP_MS,
  socketEventNeedsAdmin,
  type AuthStatus,
  type OfficeHandshakeAuth,
} from '@tagconn/shared';
import type { FastifyInstance } from 'fastify';
import type { AdminSessionCheck } from '../http/index.js';
import type { OfficeNamespace } from './index.js';

/**
 * M1: implemented by `modules/auth`'s `AuthService` (registered under this DI key alongside
 * `adminVerifier`, both `aliasTo('authService')`), and used ONLY by the two passive checks below
 * (the `/office` handshake's initial join, and the periodic ADMIN_ROOM sweep). Unlike
 * `AdminVerifier.verify`, `check` never slides the idle expiry: a socket reconnecting, or a timer
 * firing, is not "the user did something" — only a REST request or a gated packet that actually runs a
 * handler counts as activity (see the per-packet guard below, which still calls `adminVerifier.verify`).
 * Without this split, an idle-but-connected tab would never expire: the handshake and/or the 60s sweep
 * would keep re-touching the session forever just by existing.
 */
export interface AdminSessionChecker {
  check(token: string | undefined): AdminSessionCheck;
}

declare module '@fastify/awilix' {
  interface Cradle {
    adminChecker: AdminSessionChecker;
  }
}

/** Read lazily off `app.diContainer.cradle` (never destructured at registration time): `core-realtime`
 * is registered before `auth` in app.ts, so `adminVerifier`/`adminChecker` and `settings.auth.*` must
 * only be read inside connection/packet/sweep callbacks, which all run after the whole app has booted.
 * `touch: true` slides the idle expiry (real activity); `touch: false` (M1) never does. */
function authStatusOf(
  app: FastifyInstance,
  token: string | undefined,
  touch: boolean,
): { admin: boolean; sessionId?: string; expiresAt?: number } {
  const check = touch ? app.diContainer.cradle.adminVerifier.verify(token) : app.diContainer.cradle.adminChecker.check(token);
  return check.ok ? { admin: true, sessionId: check.sessionId, expiresAt: check.expiresAt } : { admin: false };
}

function fullAuthStatus(app: FastifyInstance, admin: boolean): AuthStatus {
  const { mode, protect } = app.diContainer.cradle.settings.get().auth;
  return { mode, protect, admin };
}

export interface AdminGuardHandle {
  /** Runs one sweep immediately (used by `auth:revoke`/logout for an instant effect, and by tests). */
  sweepNow(): Promise<void>;
  stop(): void;
}

declare module '@fastify/awilix' {
  interface Cradle {
    adminGuard: AdminGuardHandle;
  }
}

/**
 * Fail-closed socket gating for the /office namespace (docs/design/runner-and-helpdesk.md §5.3):
 * - Handshake (`office.use`): verifies `auth.adminToken` if present, joins ADMIN_ROOM on success, but
 *   NEVER rejects the connection — unauthenticated sockets stay read-only observers.
 * - Per-packet (`socket.use`): PUBLIC_SOCKET_EVENTS always pass; ADMIN_SOCKET_EVENTS_WRITES need an
 *   admin session only when `settings.auth.protect === 'all-writes'`; every other event (including one
 *   added later and forgotten in both lists) always needs a currently-valid admin session. The session
 *   is re-verified from the store on every gated packet, so a revoked/expired token is refused within
 *   one packet, not just at connect time.
 * - 60s sweep: evicts any socket in ADMIN_ROOM whose token no longer verifies (idle sockets that never
 *   send another gated packet).
 */
export function registerAdminGuard(app: FastifyInstance, office: OfficeNamespace): AdminGuardHandle {
  office.use((socket, next) => {
    const auth = socket.handshake.auth as OfficeHandshakeAuth | undefined;
    const token = auth?.adminToken;
    // M1: passive (a connect/reconnect is not itself user activity) — never slides the idle expiry.
    const status = authStatusOf(app, token, false);
    socket.data.admin = status.admin;
    socket.data.adminToken = status.admin ? token : undefined;
    if (status.admin) void socket.join(ADMIN_ROOM);
    next();
  });

  office.on('connection', (socket) => {
    socket.use((packet, next) => {
      const [event] = packet;
      if (!socketEventNeedsAdmin(String(event), app.diContainer.cradle.settings.get().auth.protect)) return next();

      // M1: this packet is the actual gated action the user just took — real activity, so it touches.
      const status = authStatusOf(app, socket.data.adminToken as string | undefined, true);
      socket.data.admin = status.admin;
      if (!status.admin) {
        void socket.leave(ADMIN_ROOM);
        return next(new Error('admin session required'));
      }
      return next();
    });
  });

  const sweep = async () => {
    const sockets = await office.in(ADMIN_ROOM).fetchSockets();
    for (const s of sockets) {
      // M1: a background timer, not the user doing anything — never slides the idle expiry.
      const status = authStatusOf(app, s.data.adminToken as string | undefined, false);
      if (!status.admin) {
        s.data.admin = false;
        void s.leave(ADMIN_ROOM);
        s.emit('auth:changed', fullAuthStatus(app, false));
      }
    }
  };

  const timer = setInterval(() => void sweep(), ADMIN_ROOM_SWEEP_MS);
  timer.unref();

  return { sweepNow: sweep, stop: () => clearInterval(timer) };
}
