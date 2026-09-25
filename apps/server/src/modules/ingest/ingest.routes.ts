import { HookPayloadSchema } from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { hookTokenAuth } from '../../core/http/index.js';

export const ingestRoutes: FastifyPluginAsyncZod = async (app) => {
  const { settings, ingestService } = app.diContainer.cradle;
  const checkToken = hookTokenAuth(settings);

  app.post(
    '/api/hooks',
    {
      config: { access: 'hook' },
      schema: { body: HookPayloadSchema },
      // Hooks are high-volume; skip per-request info logs.
      logLevel: 'warn',
      // Hard ceiling fixed at boot; the live setting is enforced in onRequest below.
      bodyLimit: Math.max(settings.get().ingest.maxPayloadBytes, 1024),
      // Runs before the body is parsed: an invalid/missing token is rejected without ever touching it.
      onRequest: [
        checkToken,
        async (req, reply) => {
          const len = Number(req.headers['content-length'] ?? 0);
          if (len > settings.get().ingest.maxPayloadBytes) {
            return reply.code(413).send({ error: 'Payload Too Large: hook payload exceeds ingest.maxPayloadBytes', statusCode: 413 });
          }
        },
      ],
    },
    async (req, reply) => {
      const result = ingestService.ingest(req.body);
      return reply.code(202).send(result.accepted ? { ok: true } : { ok: true, ignored: result.reason });
    },
  );
};
