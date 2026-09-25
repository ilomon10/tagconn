import { ATTRIBUTION_MAX_PROFILE_BYTES, ATTRIBUTION_SESSION_HEADER, AttributionResolveSchema } from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { hookTokenAuth } from '../../core/http/index.js';
import { projectIdFor } from '../projects/index.js';
import { AttributionExportQuerySchema } from './attribution.schema.js';

export const attributionRoutes: FastifyPluginAsyncZod = async (app) => {
  const { settings, attributionService } = app.diContainer.cradle;
  const checkToken = hookTokenAuth(settings);

  app.post(
    '/api/attribution/import',
    {
      config: { access: 'hook' },
      // No zod body schema on purpose (SC4): a Fastify/zod validation failure would echo the parsed
      // body/issues back in the response. The body is validated (and never echoed) inside the service.
      logLevel: 'warn',
      bodyLimit: ATTRIBUTION_MAX_PROFILE_BYTES,
      onRequest: [
        checkToken,
        async (req, reply) => {
          const len = Number(req.headers['content-length'] ?? 0);
          if (len > settings.get().attribution.maxProfileBytes) {
            return reply.code(413).send({ error: 'Payload Too Large: profile exceeds attribution.maxProfileBytes', statusCode: 413 });
          }
        },
      ],
    },
    async (req, reply) => {
      const sessionIdHeader = req.headers[ATTRIBUTION_SESSION_HEADER];
      const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;
      const result = attributionService.importProfile(sessionId, req.body);
      return reply.code(200).send(result);
    },
  );

  app.get('/api/attribution/pending', { config: { access: 'admin' } }, async () => attributionService.pendingList());

  app.post(
    '/api/attribution/resolve',
    { config: { access: 'admin' }, schema: { body: AttributionResolveSchema } },
    async (req) => attributionService.resolve(req.body.projectId, req.body.action),
  );

  app.get(
    '/api/attribution/export',
    { config: { access: 'public' }, schema: { querystring: AttributionExportQuerySchema } },
    async (req) => attributionService.export(req.query.cwd, projectIdFor),
  );
};
