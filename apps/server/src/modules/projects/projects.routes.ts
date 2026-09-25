import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ProjectParamsSchema, ProjectPatchSchema } from './projects.schema.js';

export const projectsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { projectsService } = app.diContainer.cradle;

  app.get('/api/projects', { config: { access: 'public' } }, async () => projectsService.list());

  app.patch(
    '/api/projects/:id',
    { config: { access: 'admin-write' }, schema: { params: ProjectParamsSchema, body: ProjectPatchSchema } },
    async (req) => projectsService.update(req.params.id, req.body),
  );
};
