import {
  ATTRIBUTION_PROFILE_KIND,
  ATTRIBUTION_PROFILE_VERSION,
  ATTRIBUTION_SESSION_HEADER,
  AttributionProfileSchema,
  type AttributionProfileInput,
  DEFAULT_LAYOUT,
  type HookPayload,
  type PendingProfileImport,
} from '@tagconn/shared';
import { asValue } from 'awilix';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { adminHeaders, buildTestApp } from '../../../../test/helpers.js';

/** Replaces the DI `logger` (what `AttributionService` logs through) with a spy that records every
 *  call's arguments, without touching Fastify's own per-request `req.log`/error handler logging. */
function spyOnServiceLogger(app: App): unknown[][] {
  const calls: unknown[][] = [];
  const noop = () => {};
  const spy = {
    info: (...a: unknown[]) => calls.push(['info', ...a]),
    warn: (...a: unknown[]) => calls.push(['warn', ...a]),
    error: (...a: unknown[]) => calls.push(['error', ...a]),
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => spy,
    level: 'info',
    silent: noop,
  };
  app.diContainer.register({ logger: asValue(spy as unknown as App['log']) });
  return calls;
}

const HOOK_TOKEN = 'test-secret';
const HOOK_HEADERS = { 'x-office-token': HOOK_TOKEN };

// A `ProfileLayoutSchema`-shaped layout (DEFAULT_LAYOUT minus the server/optimistic-concurrency fields
// it carries but a profile never does), known to validate with 0 geometry issues.
const { id: _id, builtin: _builtin, createdAt: _createdAt, updatedAt: _updatedAt, ...PROFILE_LAYOUT } = DEFAULT_LAYOUT;

function validProfile(over: Partial<AttributionProfileInput> = {}): AttributionProfileInput {
  return {
    kind: ATTRIBUTION_PROFILE_KIND,
    version: ATTRIBUTION_PROFILE_VERSION,
    tagconnVersion: '0.3.0',
    savedAt: new Date().toISOString(),
    floor: { name: 'Acme Corp Floor' },
    layout: PROFILE_LAYOUT,
    heroes: [
      { role: 'developer', name: 'Dev Dan' },
      { role: 'nonexistent-ghost-role', name: 'Ghost' },
    ],
    ...over,
  };
}

const hook = (sessionId: string, p: Partial<HookPayload> & { hook_event_name: string }): HookPayload => ({ session_id: sessionId, ...p }) as HookPayload;

async function startSession(app: App, sessionId: string, cwd: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/hooks',
    payload: hook(sessionId, { hook_event_name: 'SessionStart', cwd }),
    headers: HOOK_HEADERS,
  });
  expect(res.statusCode).toBe(202);
}

async function importPost(app: App, sessionId: string | undefined, body: Record<string, unknown>, headers: Record<string, string> = HOOK_HEADERS) {
  return app.inject({
    method: 'POST',
    url: '/api/attribution/import',
    payload: body,
    headers: { ...headers, ...(sessionId ? { [ATTRIBUTION_SESSION_HEADER]: sessionId } : {}) },
  });
}

describe('attribution import (M8 8j, S4)', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('refuses every import when server.hookToken is empty, regardless of headers', async () => {
    app = await buildTestApp(); // default hookToken: ''
    await startSession(app, 'sess-empty-token', '/tmp/attr-empty-token');
    const res = await importPost(app, 'sess-empty-token', validProfile(), {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ignored', reason: 'no-hook-token' });
  });

  it('401s on a wrong hook token when one is configured (same auth as /api/hooks)', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN } } });
    await startSession(app, 'sess-badtoken', '/tmp/attr-badtoken');
    const res = await importPost(app, 'sess-badtoken', validProfile(), { 'x-office-token': 'wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('resolves the project from the SESSION only: a header naming another session cannot reach a forged project', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN } } });
    await startSession(app, 'sess-project-A', '/tmp/attr-project-A');
    await startSession(app, 'sess-project-B', '/tmp/attr-project-B');

    const res = await importPost(app, 'sess-project-A', validProfile({ floor: { name: 'Floor A' } }));
    expect(res.json()).toMatchObject({ status: 'pending' });

    const pending = (await app.inject({ url: '/api/attribution/pending', headers: adminHeaders(app) })).json<PendingProfileImport[]>();
    expect(pending).toHaveLength(1);
    // The pending entry is tied to session A's own project (by cwd), never session B's, no matter what
    // the body claims: AttributionProfileSchema doesn't even have a project/cwd field to forge.
    expect(pending[0]).toMatchObject({ projectCwd: '/tmp/attr-project-A', floorName: 'Floor A' });
  });

  it('an unknown session id is ignored (unknown-session), not a 401', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN } } });
    const res = await importPost(app, 'sess-never-started', validProfile());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ignored', reason: 'unknown-session' });
  });

  it('missing x-tagconn-session-id header is treated as unknown-session', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN } } });
    const res = await importPost(app, undefined, validProfile());
    expect(res.json()).toMatchObject({ status: 'ignored', reason: 'unknown-session' });
  });

  it('a request outside attribution.importWindowSec of the session\'s SessionStart is ignored (stale-session)', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN }, attribution: { importWindowSec: 10 } } });
    await startSession(app, 'sess-stale', '/tmp/attr-stale');
    const farFuture = Date.now() + 60_000;
    const result = app.diContainer.cradle.attributionService.importProfile('sess-stale', validProfile(), farFuture);
    expect(result).toMatchObject({ status: 'ignored', reason: 'stale-session' });
  });

  it('413s a profile over the live attribution.maxProfileBytes cap, before it is ever parsed', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN }, attribution: { maxProfileBytes: 1_024 } } });
    await startSession(app, 'sess-toobig', '/tmp/attr-toobig');
    const huge = validProfile({ notes: 'x'.repeat(5_000) });
    const res = await importPost(app, 'sess-toobig', huge);
    expect(res.statusCode).toBe(413);
  });

  it('rejects a schema-invalid profile (rejected/invalid) without ever logging or echoing the raw body', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN } } });
    await startSession(app, 'sess-invalid', '/tmp/attr-invalid');
    const calls = spyOnServiceLogger(app);

    const SECRET_MARKER = 'sk-thisIsNotARealSecretMarkerXYZ';
    const res = await importPost(app, 'sess-invalid', { ...validProfile(), extraField: SECRET_MARKER, version: 999 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'rejected', reason: 'invalid' });

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(serialized).not.toContain('extraField');
    expect(serialized).not.toContain('ZodError');
  });

  it('rejects a profile that looks like it carries a secret, even though it matches the schema', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN } } });
    await startSession(app, 'sess-secret', '/tmp/attr-secret');
    const withSecret = validProfile({ notes: 'api_key: sk-aaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const res = await importPost(app, 'sess-secret', withSecret);
    expect(res.json()).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });

  describe('autoImport modes', () => {
    it("'off': the import is ignored and nothing is stored as pending", async () => {
      app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN }, attribution: { autoImport: 'off' } } });
      await startSession(app, 'sess-off', '/tmp/attr-off');
      const res = await importPost(app, 'sess-off', validProfile());
      expect(res.json()).toMatchObject({ status: 'ignored', reason: 'disabled' });
      const pending = (await app.inject({ url: '/api/attribution/pending', headers: adminHeaders(app) })).json<PendingProfileImport[]>();
      expect(pending).toHaveLength(0);
    });

    it("'ask' (default): stores a pending review and emits it for the admin toast; resolve({action:'import'}) applies it", async () => {
      app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN } } });
      await startSession(app, 'sess-ask', '/tmp/attr-ask');

      const seen: PendingProfileImport[] = [];
      app.diContainer.cradle.bus.on('attribution.pending', (p) => seen.push(p));

      const res = await importPost(app, 'sess-ask', validProfile());
      expect(res.json()).toMatchObject({ status: 'pending' });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ floorName: 'Acme Corp Floor', heroCount: 2, unknownRoles: ['nonexistent-ghost-role'] });

      const pending = (await app.inject({ url: '/api/attribution/pending', headers: adminHeaders(app) })).json<PendingProfileImport[]>();
      expect(pending).toHaveLength(1);
      const { projectId } = pending[0]!;

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/api/attribution/resolve',
        payload: { projectId, action: 'import' },
        headers: adminHeaders(app),
      });
      expect(resolveRes.statusCode).toBe(200);

      const project = (await app.inject({ url: '/api/projects', headers: adminHeaders(app) })).json<{ id: string; name: string; layoutId?: string }[]>();
      const applied = project.find((p) => p.id === projectId);
      expect(applied?.name).toBe('Acme Corp Floor');
      expect(applied?.layoutId).toBeDefined();
      expect(applied?.layoutId?.startsWith('imported-')).toBe(true);

      // Resolved: cleared from the pending list.
      const pendingAfter = (await app.inject({ url: '/api/attribution/pending', headers: adminHeaders(app) })).json<PendingProfileImport[]>();
      expect(pendingAfter).toHaveLength(0);

      // A second POST for the same (now-configured) project is a no-op.
      const again = await importPost(app, 'sess-ask', validProfile());
      expect(again.json()).toMatchObject({ status: 'ignored', reason: 'already-configured' });
    });

    it("'ask': dismissing a pending review marks it ignored (dismissed-before on the next hook POST)", async () => {
      app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN } } });
      await startSession(app, 'sess-dismiss', '/tmp/attr-dismiss');
      await importPost(app, 'sess-dismiss', validProfile());
      const pending = (await app.inject({ url: '/api/attribution/pending', headers: adminHeaders(app) })).json<PendingProfileImport[]>();
      const { projectId } = pending[0]!;

      const dismissRes = await app.inject({
        method: 'POST',
        url: '/api/attribution/resolve',
        payload: { projectId, action: 'dismiss' },
        headers: adminHeaders(app),
      });
      expect(dismissRes.statusCode).toBe(200);

      const again = await importPost(app, 'sess-dismiss', validProfile());
      expect(again.json()).toMatchObject({ status: 'ignored', reason: 'dismissed-before' });
    });

    it("'auto': applies immediately when the project has no layout/heroes yet, then ignores a repeat", async () => {
      app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN }, attribution: { autoImport: 'auto' } } });
      await startSession(app, 'sess-auto', '/tmp/attr-auto');

      const res = await importPost(app, 'sess-auto', validProfile());
      expect(res.json()).toMatchObject({ status: 'imported' });

      const project = (await app.inject({ url: '/api/projects' })).json<{ cwd: string; name: string; layoutId?: string }[]>();
      const applied = project.find((p) => p.cwd === '/tmp/attr-auto');
      expect(applied?.name).toBe('Acme Corp Floor');
      expect(applied?.layoutId).toBeDefined();

      const again = await importPost(app, 'sess-auto', validProfile());
      expect(again.json()).toMatchObject({ status: 'ignored', reason: 'already-configured' });
    });
  });

  it('never creates or changes roles: a hero referencing an unregistered role is dropped, not auto-created', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN }, attribution: { autoImport: 'auto' } } });
    await startSession(app, 'sess-roles', '/tmp/attr-roles');
    await importPost(app, 'sess-roles', validProfile());

    const roles = (await app.inject({ url: '/api/roles' })).json<{ name: string }[]>();
    expect(roles.some((r) => r.name === 'nonexistent-ghost-role')).toBe(false);

    const projects = (await app.inject({ url: '/api/projects' })).json<{ id: string; cwd: string }[]>();
    const projectId = projects.find((p) => p.cwd === '/tmp/attr-roles')!.id;
    const heroes = (await app.inject({ url: `/api/heroes?projectId=${projectId}`, headers: adminHeaders(app) })).json<{ role: string }[]>();
    expect(heroes.some((h) => h.role === 'nonexistent-ghost-role')).toBe(false);
    expect(heroes.some((h) => h.role === 'developer')).toBe(true);
  });
});

describe('attribution export (M8 8j, S4)', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /api/attribution/export?cwd= is public and returns a valid, portable profile', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: HOOK_TOKEN }, attribution: { autoImport: 'auto' } } });
    const CWD = '/tmp/attr-export';
    await startSession(app, 'sess-export', CWD);
    await importPost(app, 'sess-export', validProfile({ floor: { name: 'Exportable Floor' } }));

    const res = await app.inject({ url: `/api/attribution/export?cwd=${encodeURIComponent(CWD)}` }); // no auth header: public
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.floor.name).toBe('Exportable Floor');
    expect(body.layout).toBeDefined();
    expect(Array.isArray(body.heroes)).toBe(true);
    expect(body.heroes.some((h: { role: string }) => h.role === 'developer')).toBe(true);

    // The export itself must satisfy the exact schema a subsequent import would validate against.
    expect(AttributionProfileSchema.safeParse(body).success).toBe(true);
  });

  it('404s for an unregistered cwd', async () => {
    app = await buildTestApp();
    const res = await app.inject({ url: '/api/attribution/export?cwd=/tmp/never-seen-project' });
    expect(res.statusCode).toBe(404);
  });
});
