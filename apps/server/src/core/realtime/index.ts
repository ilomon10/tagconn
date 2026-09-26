import { type ClientToServerEvents, OFFICE_NAMESPACE, rooms, type ServerToClientEvents } from '@tagconn/shared';
import { asValue } from 'awilix';
import fp from 'fastify-plugin';
import { type Namespace, Server, type Socket } from 'socket.io';
export type { AdminSessionChecker } from './admin-guard.js';
import { registerAdminGuard } from './admin-guard.js';
import { hostnameFromHostHeader } from '../http/host.js';
// Deliberate module → module import: the settings module owns the hookToken masking policy, and
// every place Settings leaves the server (REST, socket acks, and this broadcast) must use it.
import { toPublicSettings } from '../../modules/settings/settings.public.js';

export type OfficeServer = Server<ClientToServerEvents, ServerToClientEvents>;
export type OfficeNamespace = Namespace<ClientToServerEvents, ServerToClientEvents>;
export type OfficeSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

declare module '@fastify/awilix' {
  interface Cradle {
    io: OfficeServer;
    office: OfficeNamespace;
  }
}

/** Wraps a socket handler so thrown errors become `{ ok: false }` acks instead of crashing. */
export function ackify<A extends unknown[], T>(
  fn: (...args: A) => T,
): (...args: [...A, (res: { ok: true; data: T } | { ok: false; error: string }) => void]) => void {
  return (...args) => {
    const ack = args.pop() as unknown;
    if (typeof ack !== 'function') return;
    const reply = ack as (res: { ok: true; data: T } | { ok: false; error: string }) => void;
    try {
      reply({ ok: true, data: fn(...(args as unknown as A)) });
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * socket.io on the Fastify HTTP server, namespace OFFICE_NAMESPACE. Rooms: `rooms.project(id)` per
 * floor and `rooms.all` for the '*' subscription. Bus upserts are broadcast here; request/response
 * handlers live in each module's *.socket.ts.
 */
export const realtimePlugin = fp(
  async (app) => {
    const { settings, bus } = app.diContainer.cradle;
    const origins = settings.get().server.corsOrigins;
    const io: OfficeServer = new Server(app.server, {
      cors: { origin: origins.includes('*') ? true : origins },
      serveClient: false,
      // `cors` above only covers the polling transport; allowRequest runs for every engine.io
      // request (polling AND the websocket upgrade), which is what actually stops cross-site
      // WebSocket hijacking. Settings are read live so config/GUI changes apply immediately.
      allowRequest: (req, callback) => {
        const { corsOrigins, allowedHosts } = settings.get().server;
        const origin = req.headers.origin;
        // No Origin header means a non-browser client (tests, curl, the future host runner): allow it.
        if (origin && !corsOrigins.includes('*') && !corsOrigins.includes(origin)) {
          return callback('origin not allowed', false);
        }
        const hostHeader = req.headers.host;
        const hostname = hostHeader ? hostnameFromHostHeader(hostHeader) : undefined;
        if (!hostname || !allowedHosts.includes(hostname)) {
          return callback('host not allowed', false);
        }
        callback(null, true);
      },
    });
    const office: OfficeNamespace = io.of(OFFICE_NAMESPACE);
    // Every feature module adds its own 'connection' listener to this shared namespace (10+ by M8);
    // raise the cap so Node doesn't report a false memory-leak warning on every boot.
    office.setMaxListeners(32);
    app.diContainer.register({ io: asValue(io), office: asValue(office) });

    // Admin auth gating (M8 8m): handshake + per-packet guard + 60s ADMIN_ROOM sweep. Reads
    // `adminVerifier`/`settings` lazily off the container, so registration order versus the `auth`
    // module (which registers `adminVerifier`) doesn't matter. See core/realtime/admin-guard.ts.
    const adminGuard = registerAdminGuard(app, office);
    app.diContainer.register({ adminGuard: asValue(adminGuard) });
    app.addHook('onClose', async () => adminGuard.stop());

    const toProject = (projectId: string) => office.to([rooms.all, rooms.project(projectId)]);
    bus.on('project.upserted', (p) => toProject(p.id).emit('project:upsert', p));
    bus.on('session.upserted', (s) => toProject(s.projectId).emit('session:upsert', s));
    bus.on('agent.upserted', (a) => toProject(a.projectId).emit('agent:upsert', a));
    bus.on('agent.removed', ({ id, projectId }) => toProject(projectId).emit('agent:remove', id));
    bus.on('task.upserted', (t) => toProject(t.projectId).emit('task:upsert', t));
    bus.on('event.created', (e) => toProject(e.projectId).emit('event:new', e));
    bus.on('settings.changed', ({ settings: s }) => office.emit('settings:changed', toPublicSettings(s)));
    bus.on('roles.changed', (r) => office.emit('roles:changed', r));
    // Layouts are global (not per floor), so these go to every client, not a project room.
    bus.on('layout.upserted', (l) => office.emit('layout:upsert', l));
    bus.on('layout.removed', (id) => office.emit('layout:remove', id));
    bus.on('hero.upserted', (h) => toProject(h.projectId).emit('hero:upsert', h));
    bus.on('hero.removed', ({ id, projectId }) => toProject(projectId).emit('hero:remove', id));

    app.addHook('preClose', async () => {
      office.disconnectSockets(true);
    });
    app.addHook('onClose', async () => {
      await new Promise<void>((resolve) => {
        // io.close() also closes the HTTP server; Fastify may already have done so.
        io.close(() => resolve());
      });
    });
  },
  { name: 'core-realtime', dependencies: ['core-di'] },
);
