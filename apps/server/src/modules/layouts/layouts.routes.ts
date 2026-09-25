import { OfficeLayoutInputSchema, type OfficeLayoutInput } from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { LayoutParamsSchema, LayoutPutParamsSchema } from './layouts.schema.js';

export const layoutsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { layoutsService } = app.diContainer.cradle;

  app.get('/api/layouts', async () => layoutsService.list());

  app.get('/api/layouts/:id', { schema: { params: LayoutParamsSchema } }, async (req) => layoutsService.get(req.params.id));

  app.post('/api/layouts', { schema: { body: OfficeLayoutInputSchema } }, async (req, reply) => {
    const layout = layoutsService.create(req.body as OfficeLayoutInput);
    reply.code(201);
    return layout;
  });

  app.put('/api/layouts/:id', { schema: { params: LayoutPutParamsSchema, body: OfficeLayoutInputSchema } }, async (req) =>
    layoutsService.replace(req.params.id, req.body as OfficeLayoutInput),
  );

  app.delete('/api/layouts/:id', { schema: { params: LayoutParamsSchema } }, async (req, reply) => {
    layoutsService.delete(req.params.id);
    return reply.code(204).send();
  });
};
