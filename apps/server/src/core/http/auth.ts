import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SettingsService } from '../config/index.js';

export const HOOK_TOKEN_HEADER = 'x-office-token';

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/**
 * `onRequest` hook enforcing `x-office-token` against settings.server.hookToken (read live; empty =
 * open). Runs as `onRequest` (not `preHandler`) so an invalid token is rejected before the body is
 * parsed at all.
 */
export function hookTokenAuth(settings: SettingsService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = settings.get().server.hookToken;
    if (!expected) return;
    const got = req.headers[HOOK_TOKEN_HEADER];
    if (typeof got !== 'string' || !safeEqual(got, expected)) {
      return reply.code(401).send({ error: `missing or invalid ${HOOK_TOKEN_HEADER}`, statusCode: 401 });
    }
  };
}
