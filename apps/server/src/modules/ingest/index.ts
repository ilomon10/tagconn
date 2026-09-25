import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { ingestRoutes } from './ingest.routes.js';
import { IngestService } from './ingest.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    ingestService: IngestService;
  }
}

/** POST /api/hooks → validated, filtered, redacted 'hook.received' on the bus. */
export const ingestModule = fp(
  async (app) => {
    app.diContainer.register({ ingestService: asClass(IngestService).singleton() });
    await app.register(ingestRoutes);
  },
  { name: 'ingest', dependencies: ['core-di', 'core-http'] },
);
