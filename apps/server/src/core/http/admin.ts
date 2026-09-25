import { REST_ACCESS_LEVELS, type RestAccessLevel } from '@tagconn/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Every `/api/*` route MUST declare this (REST_ACCESS_LEVELS), or the server refuses to boot
     * (see `registerAdminAccess`'s `onRoute` hook below). docs/design/runner-and-helpdesk.md §5.3.
     */
    access?: RestAccessLevel;
  }
}

export const ADMIN_AUTH_HEADER = 'authorization';
export const BEARER_PREFIX = 'Bearer ';

/** Parses `Authorization: Bearer <token>`; returns undefined for anything else (missing, wrong scheme, empty). */
export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers[ADMIN_AUTH_HEADER];
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return undefined;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token || undefined;
}

export interface AdminSessionCheck {
  ok: boolean;
  sessionId?: string;
  expiresAt?: number;
}

/**
 * Implemented and registered in DI by `modules/auth` (`authService`, under the `adminVerifier` key)
 * so this core file never imports a module. Every gated REST request and every gated socket packet
 * calls `verify` fresh (no caching): a revoked or expired session is refused within one request/packet.
 */
export interface AdminVerifier {
  verify(token: string | undefined): AdminSessionCheck;
}

declare module '@fastify/awilix' {
  interface Cradle {
    adminVerifier: AdminVerifier;
  }
}

/**
 * Fail-closed REST gating (docs/design/runner-and-helpdesk.md §5.3):
 * - `onRoute`: every `/api/*` route must declare `config.access` from REST_ACCESS_LEVELS, or the
 *   plugin registration throws synchronously, which fails the whole `buildApp()` promise (boot fails).
 *   Not encapsulated by Fastify, so it is registered once here and catches every route, from every
 *   module, regardless of registration order.
 * - `onRequest`: enforces the level live (settings.auth.protect and admin sessions can change without
 *   a restart). `public` and `hook` routes pass through (hook routes gate themselves with their own
 *   `x-office-token` check). `runner` routes refuse any `Origin` header and need no admin token.
 *   `admin-write` needs a token only when `settings.auth.protect === 'all-writes'` (the default);
 *   `admin` always needs one.
 * - `onSend`: `Cache-Control: no-store` on every `/api/auth/*` response (tokens must never be cached).
 *
 * Call this from `core/http/index.ts`'s `httpPlugin`, after its own onRequest hook (Host/Origin/
 * content-type), so those checks still run first regardless of the access level.
 */
export function registerAdminAccess(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const access = route.config?.access;
    if (!access || !(REST_ACCESS_LEVELS as readonly string[]).includes(access)) {
      throw new Error(
        `Fail-closed boot check: route ${route.method} ${route.url} is missing config.access (one of ${REST_ACCESS_LEVELS.join(', ')})`,
      );
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    const access = req.routeOptions.config?.access;
    if (access === undefined || access === 'public' || access === 'hook') return;

    if (access === 'runner') {
      if (req.headers.origin) {
        return reply.code(403).send({ error: 'Forbidden: Origin not allowed on this endpoint', statusCode: 403 });
      }
      return;
    }

    const { settings, adminVerifier } = app.diContainer.cradle;
    if (access === 'admin-write' && settings.get().auth.protect !== 'all-writes') return;

    const check = adminVerifier.verify(bearerToken(req));
    if (!check.ok) {
      reply.header('www-authenticate', 'Bearer');
      return reply.code(401).send({ error: 'Unauthorized: admin session required', statusCode: 401 });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/auth/')) reply.header('cache-control', 'no-store');
    return payload;
  });
}
