import {
  BootstrapRequestSchema,
  PairingChallengeRequestSchema,
  PairingCodeRequestSchema,
  PairRequestSchema,
} from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerToken } from '../../core/http/index.js';

const SessionIdParamsSchema = z.object({ id: z.string().min(1).max(80) });

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { authService } = app.diContainer.cradle;

  app.get('/api/auth/status', { config: { access: 'public' } }, async (req) => authService.status(bearerToken(req)));

  app.post(
    '/api/auth/pair',
    { config: { access: 'public' }, schema: { body: PairRequestSchema } },
    async (req) => authService.pair(req.body, req.headers['user-agent']),
  );

  app.post(
    '/api/auth/bootstrap',
    { config: { access: 'public' }, schema: { body: BootstrapRequestSchema } },
    async (req) =>
      authService.bootstrap(req.body, {
        origin: req.headers.origin,
        secFetchSite: req.headers['sec-fetch-site'],
        userAgent: req.headers['user-agent'],
      }),
  );

  // 'runner' access: refuses any Origin header (docs §5.3); no admin token needed either, since this
  // IS how the pnpm office:pair script proves it holds settings.runner.token.
  app.post(
    '/api/auth/pairing-challenge',
    { config: { access: 'runner' }, schema: { body: PairingChallengeRequestSchema } },
    async (req) => authService.pairingChallenge(req.body.nonce),
  );

  app.post(
    '/api/auth/pairing-codes',
    { config: { access: 'runner' }, schema: { body: PairingCodeRequestSchema } },
    async (req) => authService.pairingCode(req.body.challengeId, req.body.proof),
  );

  app.get('/api/auth/sessions', { config: { access: 'admin' } }, async (req) => {
    const check = authService.verify(bearerToken(req));
    return authService.listSessions(check.ok ? check.sessionId : undefined);
  });

  app.post(
    '/api/auth/sessions/:id/revoke',
    { config: { access: 'admin' }, schema: { params: SessionIdParamsSchema } },
    async (req) => {
      authService.revoke(req.params.id);
      return { ok: true as const };
    },
  );

  app.post('/api/auth/logout', { config: { access: 'admin' } }, async (req) => {
    const check = authService.verify(bearerToken(req));
    if (check.ok && check.sessionId) authService.revoke(check.sessionId);
    return { ok: true as const };
  });
};
