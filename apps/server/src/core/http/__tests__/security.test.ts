import type { ClientToServerEvents, ServerToClientEvents } from '@tagconn/shared';
import { DEFAULT_LAYOUT, OFFICE_NAMESPACE } from '@tagconn/shared';
import Fastify from 'fastify';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { adminHeaders, buildTestApp } from '../../../../test/helpers.js';
import { registerAdminAccess } from '../admin.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe('request gating (DNS rebinding / CSRF)', () => {
  let app: App | undefined;
  let socket: ClientSocket | undefined;
  afterEach(async () => {
    socket?.disconnect();
    await app?.close();
    app = socket = undefined;
  });

  it('accepts the default injected Host (localhost:80, matches settings.server.allowedHosts)', async () => {
    app = await buildTestApp();
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
  });

  it('rejects a foreign Host header with 403', async () => {
    app = await buildTestApp();
    const res = await app.inject({ url: '/api/health', headers: { host: 'evil.example.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/host/i);
  });

  it('rejects an IPv6 Host that is not in allowedHosts, accepts [::1]', async () => {
    app = await buildTestApp();
    expect((await app.inject({ url: '/api/health', headers: { host: '[::1]:4317' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/health', headers: { host: '[::2]:4317' } })).statusCode).toBe(403);
  });

  it('rejects a mutating request with a foreign Origin, accepts a configured one', async () => {
    app = await buildTestApp();
    const origins = app.diContainer.cradle.settings.get().server.corsOrigins;
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { office: { zoom: 2 } },
      headers: { origin: 'http://evil.example.com' },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toMatch(/origin/i);

    const good = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { office: { zoom: 2 } },
      headers: { origin: origins[0], ...adminHeaders(app) },
    });
    expect(good.statusCode).toBe(200);
  });

  it('rejects a layout POST or PUT with a foreign Origin, accepts a configured one', async () => {
    app = await buildTestApp();
    const origins = app.diContainer.cradle.settings.get().server.corsOrigins;
    // A geometry known to validate with 0 issues (DEFAULT_LAYOUT), minus the server-owned fields.
    const { id: _id, builtin: _builtin, createdAt: _createdAt, updatedAt: _updatedAt, ...layout } = DEFAULT_LAYOUT;

    const badPost = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      payload: layout,
      headers: { origin: 'http://evil.example.com' },
    });
    expect(badPost.statusCode).toBe(403);
    expect(badPost.json().error).toMatch(/origin/i);

    const badPut = await app.inject({
      method: 'PUT',
      url: '/api/layouts/test-hall',
      payload: layout,
      headers: { origin: 'http://evil.example.com' },
    });
    expect(badPut.statusCode).toBe(403);
    expect(badPut.json().error).toMatch(/origin/i);

    const goodPost = await app.inject({ method: 'POST', url: '/api/layouts', payload: layout, headers: { origin: origins[0], ...adminHeaders(app) } });
    expect(goodPost.statusCode).toBe(201);
  });

  it('rejects a layout DELETE with a foreign Origin (M7 hardening)', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/layouts/some-layout',
      headers: { origin: 'http://evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/origin/i);
  });

  it('rejects a PATCH /api/projects/:id { layoutId } with a foreign Origin (M7 hardening)', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/some-project',
      payload: { layoutId: 'default' },
      headers: { origin: 'http://evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/origin/i);
  });

  it('rejects a foreign Host on /api/layouts (M7 hardening)', async () => {
    app = await buildTestApp();
    const res = await app.inject({ url: '/api/layouts', headers: { host: 'evil.example.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/host/i);
  });

  it('rejects a hero POST, PATCH or DELETE with a foreign Origin, accepts a configured one (M8 hardening)', async () => {
    app = await buildTestApp();
    const origins = app.diContainer.cradle.settings.get().server.corsOrigins;

    const badPost = await app.inject({
      method: 'POST',
      url: '/api/heroes',
      payload: { projectId: 'p1', role: 'developer' },
      headers: { origin: 'http://evil.example.com' },
    });
    expect(badPost.statusCode).toBe(403);
    expect(badPost.json().error).toMatch(/origin/i);

    const badPatch = await app.inject({
      method: 'PATCH',
      url: '/api/heroes/h-00000000',
      payload: { name: 'Evil' },
      headers: { origin: 'http://evil.example.com' },
    });
    expect(badPatch.statusCode).toBe(403);
    expect(badPatch.json().error).toMatch(/origin/i);

    const badDelete = await app.inject({
      method: 'DELETE',
      url: '/api/heroes/h-00000000',
      headers: { origin: 'http://evil.example.com' },
    });
    expect(badDelete.statusCode).toBe(403);
    expect(badDelete.json().error).toMatch(/origin/i);

    // A known project must exist for the create to get past the Origin gate and 404 on the project.
    const goodPost = await app.inject({
      method: 'POST',
      url: '/api/heroes',
      payload: { projectId: 'p1', role: 'developer' },
      headers: { origin: origins[0], ...adminHeaders(app) },
    });
    expect(goodPost.statusCode).toBe(404); // Origin accepted; project unknown is the next gate down.
  });

  it('rejects a malformed hero id with 400, before any DB access (M8 hardening)', async () => {
    app = await buildTestApp();
    expect((await app.inject({ url: '/api/heroes' })).statusCode).toBe(200);
    const headers = adminHeaders(app);

    const badPatch = await app.inject({ method: 'PATCH', url: '/api/heroes/not-a-hero-id', payload: { name: 'X' }, headers });
    expect(badPatch.statusCode).toBe(400);

    const badReset = await app.inject({
      method: 'POST',
      url: '/api/heroes/not-a-hero-id/reset',
      headers: { 'content-type': 'application/json', ...headers },
    });
    expect(badReset.statusCode).toBe(400);

    const badDelete = await app.inject({ method: 'DELETE', url: '/api/heroes/not-a-hero-id', headers });
    expect(badDelete.statusCode).toBe(400);
  });

  it('rejects a text/plain POST /api/layouts (415, M7 hardening)', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(415);
  });

  it('allows GET requests regardless of a foreign Origin (only mutating requests are gated)', async () => {
    app = await buildTestApp();
    const res = await app.inject({ url: '/api/health', headers: { origin: 'http://evil.example.com' } });
    expect(res.statusCode).toBe(200);
  });

  it('allows requests with no Origin header at all (non-browser clients, e.g. the hook)', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { office: { zoom: 2 } }, headers: adminHeaders(app) });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a text/plain body on a mutating request (415)', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/reset',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(415);
  });

  it('accepts an empty body as long as content-type is application/json (no-payload POSTs)', async () => {
    app = await buildTestApp();
    const reset = await app.inject({
      method: 'POST',
      url: '/api/settings/reset',
      headers: { 'content-type': 'application/json', ...adminHeaders(app) },
    });
    expect(reset.statusCode).toBe(200);
  });

  it('rejects a socket.io handshake from a foreign Origin, accepts a configured one', async () => {
    app = await buildTestApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`;
    const origins = app.diContainer.cradle.settings.get().server.corsOrigins;

    const bad: ClientSocket = connect(base, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: { Origin: 'http://evil.example.com' },
    });
    const badOutcome = await new Promise<string>((resolve) => {
      bad.on('connect', () => resolve('connect'));
      bad.on('connect_error', () => resolve('connect_error'));
    });
    bad.disconnect();
    expect(badOutcome).toBe('connect_error');

    socket = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: { Origin: origins[0] ?? '' } });
    const goodOutcome = await new Promise<string>((resolve) => {
      socket?.on('connect', () => resolve('connect'));
      socket?.on('connect_error', () => resolve('connect_error'));
    });
    expect(goodOutcome).toBe('connect');
  });

  it('rejects a foreign-Origin socket.io handshake even with a valid admin token (M8 8m §5.4 #2)', async () => {
    app = await buildTestApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`;

    socket = connect(base, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: { Origin: 'http://evil.example.com' },
      auth: { adminToken: 'tca_does-not-matter-the-origin-check-runs-first' },
    });
    const outcome = await new Promise<string>((resolve) => {
      socket?.on('connect', () => resolve('connect'));
      socket?.on('connect_error', () => resolve('connect_error'));
    });
    expect(outcome).toBe('connect_error');
  });

  // M8 8m (docs/design/runner-and-helpdesk.md §5.3/§5.4 #1): every /api/* route must declare
  // `config.access`, or the server refuses to boot. A bare Fastify instance (no DI needed: the
  // onRoute hook never touches the container) keeps this test fast and isolated from the real app.
  it('fails to boot when a route is registered without config.access', async () => {
    const bare = Fastify();
    registerAdminAccess(bare);
    // The onRoute hook throws synchronously, right when the route is added (not deferred to .ready()).
    expect(() => bare.get('/api/broken', async () => ({ ok: true }))).toThrow(/missing config\.access/);
    await bare.close();
  });

  it('boots fine when every /api/* route declares a valid config.access', async () => {
    const bare = Fastify();
    registerAdminAccess(bare);
    bare.get('/api/fine', { config: { access: 'public' } }, async () => ({ ok: true }));
    await bare.ready();
    await bare.close();
  });

  it('never caches /api/auth/* responses (Cache-Control: no-store)', async () => {
    app = await buildTestApp();
    const res = await app.inject({ url: '/api/auth/status' });
    expect(res.headers['cache-control']).toBe('no-store');
    // Sanity: an ordinary public route is unaffected.
    expect((await app.inject({ url: '/api/health' })).headers['cache-control']).toBeUndefined();
  });
});
