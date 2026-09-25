import cors from '@fastify/cors';
import type { FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { HttpError } from './errors.js';
import { hostnameFromHostHeader } from './host.js';

export * from './auth.js';
export * from './errors.js';
export * from './host.js';

/** Methods Fastify parses a body for; these must arrive as `application/json`. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Zod type provider, uniform `{ error }` JSON errors, CORS, and defense-in-depth request gating
 * (settings are read live, so config/GUI changes apply without a restart):
 * - Host header must resolve (port stripped) to settings.server.allowedHosts → blocks DNS rebinding.
 * - A non-GET/HEAD/OPTIONS request carrying an Origin header must match settings.server.corsOrigins.
 * - POST/PUT/PATCH bodies must be `application/json` → blocks text/plain CSRF "simple requests".
 */
export const httpPlugin = fp(
  async (app) => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const { settings } = app.diContainer.cradle;
    const origins = settings.get().server.corsOrigins;
    await app.register(cors, {
      origin: origins.includes('*') ? true : origins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    });

    // text/plain is a CSRF-friendly "simple request" content type; require JSON everywhere instead.
    app.removeContentTypeParser('text/plain');
    // A genuinely empty JSON body (e.g. `POST /api/settings/reset` with no payload) parses to `{}`
    // instead of erroring, so no-payload POSTs work as long as content-type is application/json.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      const text = (body as string).trim();
      if (!text) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        done(err as Error, undefined);
      }
    });

    app.addHook('onRequest', async (req, reply) => {
      const { allowedHosts, corsOrigins } = app.diContainer.cradle.settings.get().server;
      const hostHeader = req.headers.host;
      const hostname = hostHeader ? hostnameFromHostHeader(hostHeader) : undefined;
      if (!hostname || !allowedHosts.includes(hostname)) {
        return reply.code(403).send({ error: 'Forbidden: untrusted Host header', statusCode: 403 });
      }

      const method = req.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const origin = req.headers.origin;
        if (origin && !corsOrigins.includes('*') && !corsOrigins.includes(origin)) {
          return reply.code(403).send({ error: 'Forbidden: untrusted Origin header', statusCode: 403 });
        }
      }

      if (BODY_METHODS.has(method)) {
        const contentType = req.headers['content-type'];
        const base = contentType?.split(';')[0]?.trim().toLowerCase();
        if (base !== 'application/json') {
          return reply.code(415).send({ error: 'Unsupported Media Type: expected application/json', statusCode: 415 });
        }
      }
    });

    app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
      if (hasZodFastifySchemaValidationErrors(err)) {
        return reply.code(400).send({ error: err.message, statusCode: 400, details: err.validation });
      }
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send({ error: err.message, statusCode: err.statusCode, details: err.details });
      }
      const status = err.statusCode ?? 500;
      if (status >= 500) req.log.error({ err }, 'request failed');
      return reply.code(status).send({ error: status >= 500 ? 'Internal Server Error' : err.message, statusCode: status });
    });
  },
  { name: 'core-http', dependencies: ['core-di'] },
);
