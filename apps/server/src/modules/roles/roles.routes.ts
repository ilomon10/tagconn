import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { RoleBodySchema, RoleParamsSchema } from './roles.schema.js';

export const rolesRoutes: FastifyPluginAsyncZod = async (app) => {
  const { rolesService } = app.diContainer.cradle;

  app.get('/api/roles', async () => rolesService.list());

  app.put('/api/roles/:name', { schema: { params: RoleParamsSchema, body: RoleBodySchema } }, async (req) =>
    rolesService.save(req.params.name, req.body),
  );

  app.delete('/api/roles/:name', { schema: { params: RoleParamsSchema } }, async (req, reply) => {
    rolesService.delete(req.params.name);
    return reply.code(204).send();
  });

  app.post('/api/roles/sync', async () => rolesService.sync());
};
