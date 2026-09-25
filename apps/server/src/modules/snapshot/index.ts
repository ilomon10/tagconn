import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { snapshotRoutes } from './snapshot.routes.js';
import { SnapshotService } from './snapshot.service.js';
import { registerSnapshotSocket } from './snapshot.socket.js';

declare module '@fastify/awilix' {
  interface Cradle {
    snapshotService: SnapshotService;
  }
}

export const snapshotModule = fp(
  async (app) => {
    app.diContainer.register({ snapshotService: asClass(SnapshotService).singleton() });
    registerSnapshotSocket(app.diContainer.cradle);
    await app.register(snapshotRoutes);
  },
  { name: 'snapshot', dependencies: ['core-di', 'core-http', 'core-realtime', 'projects', 'sessions', 'agents', 'tasks', 'events', 'layouts', 'heroes'] },
);
