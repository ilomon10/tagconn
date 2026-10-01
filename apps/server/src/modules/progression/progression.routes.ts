import { EmptyBodySchema, ProgressListQuerySchema, SkillAllocationSchema, TitleEquipSchema } from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HeroParamsSchema } from '../heroes/heroes.schema.js';
import { BODY_LIMIT } from './progression.schema.js';

/** docs/design/battles.md 2.4. Progress rows are public to read; changes are admin-only with a small body limit. */
export const progressionRoutes: FastifyPluginAsyncZod = async (app) => {
  const { progressionService } = app.diContainer.cradle;
  const write = { config: { access: 'admin' as const }, bodyLimit: BODY_LIMIT.default };

  app.get('/api/progress', { config: { access: 'public' }, schema: { querystring: ProgressListQuerySchema } }, async (req) =>
    progressionService.list(req.query.projectId),
  );

  app.get('/api/heroes/:id/progress', { config: { access: 'public' }, schema: { params: HeroParamsSchema } }, async (req) =>
    progressionService.get(req.params.id),
  );

  app.post(
    '/api/heroes/:id/skills',
    {
      ...write,
      schema: { params: HeroParamsSchema, body: SkillAllocationSchema },
    },
    async (req) => progressionService.setSkills(req.params.id, req.body),
  );

  app.post('/api/heroes/:id/title', { ...write, schema: { params: HeroParamsSchema, body: TitleEquipSchema } }, async (req) =>
    progressionService.equipTitle(req.params.id, req.body.title),
  );

  app.post('/api/heroes/:id/heal', { ...write, schema: { params: HeroParamsSchema, body: EmptyBodySchema } }, async (req) =>
    progressionService.heal(req.params.id),
  );
};
