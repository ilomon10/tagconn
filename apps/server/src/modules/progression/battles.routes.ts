import { BattleCreateSchema, BattleResolveSchema, EmptyBodySchema, type BattleCreate, type BattleResolve } from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { BODY_LIMIT, BattleParamsSchema } from './progression.schema.js';

export const battlesRoutes: FastifyPluginAsyncZod = async (app) => {
  const { battlesService } = app.diContainer.cradle;

  app.post(
    '/api/battles',
    { config: { access: 'admin' }, bodyLimit: BODY_LIMIT.default, schema: { body: BattleCreateSchema } },
    async (req, reply) => {
      const start = battlesService.create(req.body as BattleCreate);
      reply.code(201);
      return start;
    },
  );

  app.post(
    '/api/battles/:id/resolve',
    { config: { access: 'admin' }, bodyLimit: BODY_LIMIT.resolve, schema: { params: BattleParamsSchema, body: BattleResolveSchema } },
    async (req) => battlesService.resolve(req.params.id, req.body as BattleResolve),
  );

  app.post(
    '/api/battles/:id/abandon',
    { config: { access: 'admin' }, bodyLimit: BODY_LIMIT.default, schema: { params: BattleParamsSchema, body: EmptyBodySchema } },
    async (req) => battlesService.abandon(req.params.id),
  );

  app.get('/api/battles/:id', { config: { access: 'admin' }, schema: { params: BattleParamsSchema } }, async (req) =>
    battlesService.get(req.params.id),
  );
};
