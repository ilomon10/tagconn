import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import { ASSET_CACHE_CONTROL, INDEX_CACHE_CONTROL, SECURITY_HEADERS } from '@tagconn/shared';
import fp from 'fastify-plugin';

/** Paths owned by the API and the realtime layer: never touched by the web plugin. */
const isBackendPath = (path: string): boolean => path === '/api' || path.startsWith('/api/') || path === '/socket.io' || path.startsWith('/socket.io/');

const pathnameOf = (url: string): string => url.split('?', 1)[0] ?? '';

/** True for a path that tries to leave the web dir (`..` segments, backslashes, NUL), raw or percent-decoded. */
function isTraversal(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true; // malformed escape: never a file we serve
  }
  return [pathname, decoded].some((p) => p.includes('\0') || p.includes('\\') || p.split('/').includes('..'));
}

/**
 * Serves the built web app (`apps/web/dist`) itself when `settings.server.webDir` is set (restart-required; desktop mode = webDir set + host 127.0.0.1, where the supervisor passes OFFICE_SERVER__ALLOWED_HOSTS='["localhost","127.0.0.1","[::1]"]', i.e. without the Docker-only `server`;
 * unset under Docker/nginx and Vite dev). Same behaviour as `docker/nginx.conf`: `/assets/*` immutable, index.html
 * `no-store`, SPA fallback to index.html for unknown GET paths, and the shared security headers on every web response.
 * `/api` and `/socket.io` are left alone (the Host allowlist in core/http still runs first for every route, web included;
 * static/fallback routes declare no `config.access`, which the `/api`-only onRoute check and onRequest gate treat as public).
 */
export const webPlugin = fp(
  async (app) => {
    const webDir = app.diContainer.cradle.settings.get().server.webDir;
    if (!webDir) return;
    const root = resolve(webDir);
    if (!existsSync(resolve(root, 'index.html'))) {
      app.log.warn({ webDir: root }, 'server.webDir has no index.html; not serving the web app');
      return;
    }

    // @fastify/static follows symlinks; refuse any existing file whose realpath leaves the web dir. N13: a directory
    // request is served as its index.html, so that resolved file is checked too (a symlinked index.html or a
    // symlinked sub-directory must not expose a file outside the dir), as is the root index.html the SPA fallback uses.
    const realRoot = realpathSync(root);
    const inside = (real: string): boolean => real === realRoot || real.startsWith(realRoot + sep);
    const resolvesInside = (file: string): boolean => {
      let real: string;
      try {
        real = realpathSync(file);
      } catch {
        return true; // does not exist: static/SPA fallback handles it
      }
      if (!inside(real)) return false;
      try {
        if (statSync(real).isDirectory()) {
          const index = join(real, 'index.html');
          return !existsSync(index) || inside(realpathSync(index));
        }
      } catch {
        /* vanished meanwhile: nothing to serve */
      }
      return true;
    };
    if (!resolvesInside(join(root, 'index.html'))) {
      app.log.warn({ webDir: root }, 'server.webDir/index.html is a symlink leaving the web dir; not serving the web app');
      return;
    }
    app.addHook('onRequest', async (req, reply) => {
      const path = pathnameOf(req.url);
      if ((req.method !== 'GET' && req.method !== 'HEAD') || isBackendPath(path) || isTraversal(path)) return;
      if (!resolvesInside(join(root, decodeURIComponent(path)))) return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
    });

    await app.register(fastifyStatic, { root, wildcard: true, index: 'index.html', dotfiles: 'ignore', cacheControl: false });

    // One hook covers static files, the SPA fallback and error responses alike.
    app.addHook('onSend', async (req, reply, payload) => {
      const path = pathnameOf(req.url);
      if (isBackendPath(path)) return payload;
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
      const type = String(reply.getHeader('content-type') ?? '');
      if (path.startsWith('/assets/') && reply.statusCode < 300) reply.header('cache-control', ASSET_CACHE_CONTROL);
      else if (type.startsWith('text/html') || path === '/index.html' || path === '/') reply.header('cache-control', INDEX_CACHE_CONTROL);
      return payload;
    });

    app.setNotFoundHandler(async (req, reply) => {
      const path = pathnameOf(req.url);
      const spa = (req.method === 'GET' || req.method === 'HEAD') && !isBackendPath(path) && !path.startsWith('/assets/') && !isTraversal(path);
      if (!spa) return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    });
  },
  { name: 'core-web', dependencies: ['core-di', 'core-http'] },
);
