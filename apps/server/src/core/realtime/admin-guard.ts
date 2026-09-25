import {
  ADMIN_ROOM,
  ADMIN_ROOM_SWEEP_MS,
  ADMIN_SOCKET_EVENTS_WRITES,
  PUBLIC_SOCKET_EVENTS,
  type AuthStatus,
  type OfficeHandshakeAuth,
} from '@tagconn/shared';
import type { FastifyInstance } from 'fastify';
import type { OfficeNamespace } from './index.js';

const PUBLIC = new Set<string>(PUBLIC_SOCKET_EVENTS);
const WRITES = new Set<string>(ADMIN_SOCKET_EVENTS_WRITES);

/** Read lazily off `app.diContainer.cradle` (never destructured at registration time): `core-realtime`
 * is registered before `auth` in app.ts, so `adminVerifier` and `settings.auth.*` must only be read
 * inside connection/packet/sweep callbacks, which all run after the whole app has booted. */
function authStatusOf(app: FastifyInstance, token: string | undefined): { admin: boolean; sessionId?: string; expiresAt?: number } {
  const check = app.diContainer.cradle.adminVerifier.verify(token);
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
    const status = authStatusOf(app, token);
    socket.data.admin = status.admin;
    socket.data.adminToken = status.admin ? token : undefined;
    if (status.admin) void socket.join(ADMIN_ROOM);
    next();
  });

  office.on('connection', (socket) => {
    socket.use((packet, next) => {
      const [event] = packet;
      if (PUBLIC.has(event)) return next();

      const protect = app.diContainer.cradle.settings.get().auth.protect;
      if (WRITES.has(event) && protect !== 'all-writes') return next();

      const status = authStatusOf(app, socket.data.adminToken as string | undefined);
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
      const status = authStatusOf(app, s.data.adminToken as string | undefined);
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
