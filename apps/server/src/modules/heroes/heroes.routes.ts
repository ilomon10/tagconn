import { HeroCreateSchema, HeroListRequestSchema, HeroPatchSchema, type HeroCreate, type HeroPatch } from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HeroParamsSchema } from './heroes.schema.js';

export const heroesRoutes: FastifyPluginAsyncZod = async (app) => {
  const { heroesService } = app.diContainer.cradle;

  app.get(
    '/api/heroes',
    { config: { access: 'public' }, schema: { querystring: HeroListRequestSchema } },
    async (req) => heroesService.list(req.query.projectId),
  );

  app.post('/api/heroes', { config: { access: 'admin' }, schema: { body: HeroCreateSchema } }, async (req, reply) => {
    const hero = heroesService.create(req.body as HeroCreate);
    reply.code(201);
    return hero;
  });

  app.patch(
    '/api/heroes/:id',
    { config: { access: 'admin' }, schema: { params: HeroParamsSchema, body: HeroPatchSchema } },
    async (req) => heroesService.patch(req.params.id, req.body as HeroPatch),
  );

  app.post(
    '/api/heroes/:id/reset',
    { config: { access: 'admin' }, schema: { params: HeroParamsSchema } },
    async (req) => heroesService.reset(req.params.id),
  );

  app.delete('/api/heroes/:id', { config: { access: 'admin' }, schema: { params: HeroParamsSchema } }, async (req, reply) => {
    heroesService.delete(req.params.id);
    return reply.code(204).send();
  });
};
