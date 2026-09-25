import { RunStartRequestSchema } from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { bearerToken } from '../../core/http/index.js';
import { createdByFrom } from './runs.caller.js';
import { RunFollowUpBodySchema, RunIdParamsSchema, RunsListQuerySchema } from './runs.schema.js';

/**
 * Quest board REST (docs/design/runner-and-helpdesk.md §3, §5.3: `/api/runs*` and `/api/runner/*`
 * are always `admin`). The socket equivalents (`runs:*`, `runner:getStatus`) are in `runs.socket.ts`.
 */
export const runsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { runsService, adminVerifier } = app.diContainer.cradle;
  const who = (req: Parameters<typeof bearerToken>[0]) => createdByFrom(adminVerifier, bearerToken(req));

  app.get('/api/runs', { config: { access: 'admin' }, schema: { querystring: RunsListQuerySchema } }, async (req) =>
    runsService.list(req.query),
  );

  app.get('/api/runs/:runId', { config: { access: 'admin' }, schema: { params: RunIdParamsSchema } }, async (req) =>
    runsService.getDetail(req.params.runId),
  );

  app.post('/api/runs', { config: { access: 'admin' }, schema: { body: RunStartRequestSchema } }, async (req, reply) => {
    const run = runsService.startQuest(req.body, who(req));
    reply.code(201);
    return run;
  });

  app.post(
    '/api/runs/:runId/followUp',
    { config: { access: 'admin' }, schema: { params: RunIdParamsSchema, body: RunFollowUpBodySchema } },
    async (req, reply) => {
      const run = runsService.followUp({ runId: req.params.runId, prompt: req.body.prompt }, who(req));
      reply.code(201);
      return run;
    },
  );

  app.post('/api/runs/:runId/stop', { config: { access: 'admin' }, schema: { params: RunIdParamsSchema } }, async (req) =>
    runsService.stopQuest(req.params.runId, who(req)),
  );

  app.get('/api/runner/status', { config: { access: 'admin' } }, async () => runsService.getRunnerStatus());
};
