import type { ClientToServerEvents, ServerToClientEvents } from '@tagconn/shared';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LAYOUT, OFFICE_NAMESPACE } from '@tagconn/shared';
import Fastify from 'fastify';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../../app.js';
import { adminHeaders, buildTestApp, loadFixture, makeTempDir } from '../../../../test/helpers.js';
import { registerAdminAccess } from '../admin.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe('web plugin gating (server.webDir)', () => {
  it('keeps the Host allowlist for web routes and leaves /api 404s as JSON', async () => {
    const webDir = makeTempDir('tagconn-secweb-');
    writeFileSync(join(webDir, 'index.html'), '<title>x</title>');
    const app = await buildTestApp({ settings: { server: { webDir } } });
    try {
      expect((await app.inject({ url: '/', headers: { host: 'evil.example.com' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/deep/link', headers: { host: 'evil.example.com' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/deep/link' })).statusCode).toBe(200);
      const api = await app.inject({ url: '/api/nope' });
      expect(api.statusCode).toBe(404);
      expect(api.json()).toEqual({ error: 'Not Found', statusCode: 404 });
    } finally {
      await app.close();
    }
  });
});

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

  it('rejects __proto__ / constructor.prototype keys at any depth with a 400 (global JSON guard)', async () => {
    app = await buildTestApp();
    const post = (payload: string, url = '/api/settings/reset') =>
      app!.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...adminHeaders(app!) }, payload });
    const bad = [
      '{"__proto__":1}',
      '{"a":{"b":{"__proto__":{"x":1}}}}',
      '{"a":[{"__proto__":1}]}',
      '[{"constructor":{"prototype":{"x":1}}}]',
      '{"a":{"constructor":{"prototype":{}}}}',
    ];
    for (const payload of bad) {
      const res = await post(payload);
      expect(res.statusCode, payload).toBe(400);
      expect(res.json()).toMatchObject({ statusCode: 400, error: expect.any(String) });
    }
    // Hook ingest is untrusted JSON too.
    const hook = await post('{"session_id":"s","hook_event_name":"SessionStart","x":{"__proto__":1}}', '/api/hooks');
    expect(hook.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('still accepts look-alike keys (proto, __proto, constructor without prototype) and real hook fixtures', async () => {
    app = await buildTestApp();
    const ok = await app.inject({
      method: 'POST',
      url: '/api/settings/reset',
      headers: { 'content-type': 'application/json', ...adminHeaders(app) },
      payload: '{"proto":1,"__proto":2,"a":{"constructor":3,"prototype":4}}',
    });
    expect(ok.statusCode).toBe(200);
    for (const payload of loadFixture()) {
      const res = await app.inject({ method: 'POST', url: '/api/hooks', payload });
      expect(res.statusCode).toBe(202);
    }
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
    const health = await app.inject({ url: '/api/health' });
    expect(health.headers['cache-control']).toBe('no-store');
    expect(health.headers['x-content-type-options']).toBe('nosniff');
  });
});

// QA: a rejected Host/Origin used to return a bare 403 (REST) / connect_error (socket.io) with
// nothing in the server log, so a misconfigured server.corsOrigins/allowedHosts looked like a
// silent, unexplained failure. core/http/index.ts and core/realtime/index.ts now each log one
// warn line, rate-limited per distinct header value.
describe('rejected Host/Origin logging (core/http + core/realtime)', () => {
  let app: App | undefined;
  let socket: ClientSocket | undefined;
  afterEach(async () => {
    socket?.disconnect();
    await app?.close();
    app = socket = undefined;
  });

  /** Replaces the real Fastify logger's `warn` with a spy. With `logger: false` (buildTestApp's
   * default), Fastify falls back to `abstract-logging`, whose `.child()` returns the very same
   * object back - so `req.log` (used in core/http) and `app.log` (used in core/realtime, which has
   * no per-request logger) are one and the same instance, and patching one catches both. */
  function spyOnWarn(target: App): unknown[][] {
    const calls: unknown[][] = [];
    (target.log as unknown as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => calls.push(a);
    return calls;
  }

  it('logs a rejected Host once, naming the header value and the setting to change, then rate-limits repeats', async () => {
    app = await buildTestApp();
    const calls = spyOnWarn(app);

    await app.inject({ url: '/api/health', headers: { host: 'evil.example.com' } });
    await app.inject({ url: '/api/health', headers: { host: 'evil.example.com' } });
    expect(calls.length).toBe(1);

    const [meta, msg] = calls[0] as [{ host?: string }, string];
    expect(meta.host).toBe('evil.example.com');
    expect(msg).toMatch(/allowedHosts/);
    expect(msg).toMatch(/OFFICE_SERVER__ALLOWED_HOSTS/);

    // A different Host value is a distinct rate-limit key, so it still gets its own log line.
    await app.inject({ url: '/api/health', headers: { host: 'other.example.com' } });
    expect(calls.length).toBe(2);
  });

  it('logs a rejected Origin once, naming the header value and the setting to change, then rate-limits repeats', async () => {
    app = await buildTestApp();
    const calls = spyOnWarn(app);

    await app.inject({ method: 'PATCH', url: '/api/settings', payload: {}, headers: { origin: 'http://evil.example.com' } });
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: {}, headers: { origin: 'http://evil.example.com' } });
    expect(calls.length).toBe(1);

    const [meta, msg] = calls[0] as [{ origin?: string }, string];
    expect(meta.origin).toBe('http://evil.example.com');
    expect(msg).toMatch(/corsOrigins/);
    expect(msg).toMatch(/OFFICE_SERVER__CORS_ORIGINS/);
  });

  it('never logs the request Authorization header or any token when rejecting a foreign Origin', async () => {
    app = await buildTestApp();
    const calls = spyOnWarn(app);
    const secretToken = 'tca_totally-secret-admin-token-value';

    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: {},
      headers: { origin: 'http://evil.example.com', authorization: `Bearer ${secretToken}` },
    });

    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls[0])).not.toContain(secretToken);
  });

  it('logs a rejected socket.io handshake Origin once, naming the header value and the setting to change', async () => {
    app = await buildTestApp();
    const calls = spyOnWarn(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`;

    socket = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: { Origin: 'http://evil.example.com' } });
    await new Promise<void>((resolve) => socket?.on('connect_error', () => resolve()));

    expect(calls.length).toBe(1);
    const [meta, msg] = calls[0] as [{ origin?: string }, string];
    expect(meta.origin).toBe('http://evil.example.com');
    expect(msg).toMatch(/corsOrigins/);
    expect(msg).toMatch(/handshake/);
  });
});

// M14 (docs/design/battles.md 6.4): HTTP guards on every progression and battle route.
describe('progression and battle routes (M14 guards)', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const HERO = 'h-00000000';
  const BATTLE = 'b-000000000000';
  const POSTS: { url: string; payload: object }[] = [
    { url: '/api/battles', payload: { projectId: 'p', npcKind: 'sales-dog', encounterId: 'e-1', party: [{ kind: 'hero', heroId: HERO }] } },
    { url: `/api/battles/${BATTLE}/resolve`, payload: { log: [] } },
    { url: `/api/battles/${BATTLE}/abandon`, payload: {} },
    { url: `/api/heroes/${HERO}/skills`, payload: { skills: {} } },
    { url: `/api/heroes/${HERO}/title`, payload: { title: null } },
    { url: `/api/heroes/${HERO}/heal`, payload: {} },
  ];
  const GETS = ['/api/progress', `/api/heroes/${HERO}/progress`, `/api/battles/${BATTLE}`];
  const JSON_HEADERS = { 'content-type': 'application/json' };

  it('every new POST: foreign Origin 403, text/plain 415, no token 401, the hook token alone 401', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: 's3cret' } } });
    const origin = app.diContainer.cradle.settings.get().server.corsOrigins[0];
    for (const { url, payload } of POSTS) {
      const foreign = await app.inject({ method: 'POST', url, payload, headers: { origin: 'http://evil.example.com', ...adminHeaders(app) } });
      expect([url, foreign.statusCode]).toEqual([url, 403]);
      const plain = await app.inject({ method: 'POST', url, payload: '{}', headers: { 'content-type': 'text/plain', origin, ...adminHeaders(app) } });
      expect([url, plain.statusCode]).toEqual([url, 415]);
      const anon = await app.inject({ method: 'POST', url, payload, headers: JSON_HEADERS });
      expect([url, anon.statusCode]).toEqual([url, 401]);
      const hookOnly = await app.inject({ method: 'POST', url, payload, headers: { ...JSON_HEADERS, 'x-office-token': 's3cret' } });
      expect([url, hookOnly.statusCode]).toEqual([url, 401]);
    }
  });

  it('every new GET: foreign Host 403; the battle read needs the admin token, the progress reads stay public', async () => {
    app = await buildTestApp();
    for (const url of GETS) expect([url, (await app.inject({ url, headers: { host: 'evil.example.com' } })).statusCode]).toEqual([url, 403]);
    expect((await app.inject({ url: '/api/progress' })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/battles/${BATTLE}` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/battles/${BATTLE}`, headers: adminHeaders(app) })).statusCode).toBe(404);
  });

  it('strict bodies: unknown keys, bad action indices and over-long logs are 400', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const create = { projectId: 'p', npcKind: 'sales-dog', encounterId: 'e-1', party: [{ kind: 'hero', heroId: HERO }] };
    for (const extra of [{ seed: 1 }, { setup: {} }, { lootSeed: 1 }]) {
      expect((await app.inject({ method: 'POST', url: '/api/battles', payload: { ...create, ...extra }, headers })).statusCode).toBe(400);
    }
    const resolve = (payload: object) => app!.inject({ method: 'POST', url: `/api/battles/${BATTLE}/resolve`, payload, headers });
    expect((await resolve({ log: [], seed: 1 })).statusCode).toBe(400);
    expect((await resolve({ log: [{ t: 'move', move: 8 }] })).statusCode).toBe(400);
    expect((await resolve({ log: [{ t: 'swap', to: 4 }] })).statusCode).toBe(400);
    expect((await resolve({ log: Array.from({ length: 221 }, () => ({ t: 'run' })) })).statusCode).toBe(400);
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const res = await app.inject({ method: 'POST', url: `/api/heroes/${HERO}/skills`, payload: `{"skills":{"${key}":1}}`, headers: { ...JSON_HEADERS, ...headers } });
      expect([key, res.statusCode]).toEqual([key, 400]);
    }
    const many = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`developer.0.${i}`, 1]));
    expect((await app.inject({ method: 'POST', url: `/api/heroes/${HERO}/skills`, payload: { skills: many }, headers })).statusCode).toBe(400);
  });

  it('bodies over the route bodyLimit are 413', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const big = (n: number) => ({ pad: 'x'.repeat(n) });
    expect((await app.inject({ method: 'POST', url: '/api/battles', payload: big(17_000), headers })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: `/api/battles/${BATTLE}/resolve`, payload: big(33_000), headers })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: `/api/heroes/${HERO}/heal`, payload: big(17_000), headers })).statusCode).toBe(413);
  });

  it('malformed hero and battle ids are 400 before any repository access', async () => {
    app = await buildTestApp();
    const cr = app.diContainer.cradle;
    const spies = [vi.spyOn(cr.battlesRepository, 'get'), vi.spyOn(cr.heroesRepository, 'get'), vi.spyOn(cr.progressionRepository, 'getCore'), vi.spyOn(cr.progressionRepository, 'view')];
    const headers = adminHeaders(app);
    for (const { url, payload } of POSTS.slice(1)) {
      const bad = url.replace(HERO, 'not-a-hero').replace(BATTLE, 'not-a-battle');
      expect([bad, (await app.inject({ method: 'POST', url: bad, payload, headers })).statusCode]).toEqual([bad, 400]);
    }
    for (const url of GETS.slice(1)) {
      const bad = url.replace(HERO, 'not-a-hero').replace(BATTLE, 'not-a-battle');
      expect([bad, (await app.inject({ url: bad, headers })).statusCode]).toEqual([bad, 400]);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('errors are { error, statusCode } with no stack, and the 429 limiters are per app instance', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const missing = await app.inject({ method: 'POST', url: `/api/battles/${BATTLE}/abandon`, payload: {}, headers });
    expect(missing.statusCode).toBe(404);
    expect(Object.keys(missing.json()).sort()).toEqual(['error', 'statusCode']);
    expect(missing.body).not.toMatch(/stack|\.ts:|node_modules/);
    for (let i = 0; i < 29; i++) await app.inject({ method: 'POST', url: `/api/battles/${BATTLE}/abandon`, payload: {}, headers });
    expect((await app.inject({ method: 'POST', url: `/api/battles/${BATTLE}/abandon`, payload: {}, headers })).statusCode).toBe(429);
    const other = await buildTestApp();
    try {
      expect((await other.inject({ method: 'POST', url: `/api/battles/${BATTLE}/abandon`, payload: {}, headers: adminHeaders(other) })).statusCode).toBe(404);
    } finally {
      await other.close();
    }
  });

  it('hero:progress for project A never reaches a socket subscribed only to project B', async () => {
    app = await buildTestApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`;
    const sock: ClientSocket = connect(base, { transports: ['websocket'], forceNew: true });
    const got: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        sock.on('connect', () => resolve());
        sock.on('connect_error', reject);
      });
      sock.on('hero:progress', (p) => got.push(p.projectId));
      await new Promise<void>((resolve) => sock.emit('office:subscribe', 'pB', () => resolve()));
      app.diContainer.cradle.bus.emit('progress.upserted', { heroId: HERO, projectId: 'pA' } as never);
      app.diContainer.cradle.bus.emit('progress.upserted', { heroId: HERO, projectId: 'pB' } as never);
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toEqual(['pB']);
    } finally {
      sock.disconnect();
    }
  });
});
