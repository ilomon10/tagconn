import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SnapshotQuerySchema } from './snapshot.schema.js';

export const snapshotRoutes: FastifyPluginAsyncZod = async (app) => {
  const { snapshotService } = app.diContainer.cradle;
  app.get(
    '/api/snapshot',
    { config: { access: 'public' }, schema: { querystring: SnapshotQuerySchema } },
    async (req) => snapshotService.build(req.query.projectId),
  );
};
