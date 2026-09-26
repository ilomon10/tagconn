import {
  AttributionProfileSchema,
  type AttributionWriteCommand,
  type AttributionWriteResult,
  OFFICE_NAMESPACE,
  type Project,
} from '@tagconn/shared';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { adminHeaders, adminSocketAuth, buildTestApp } from '../../../../test/helpers.js';
import { connectVerifiedRunner, type FakeRunner } from '../../runs/__tests__/fake-runner.js';

/**
 * "Save profile to project" end to end (M8 8k/8l, §6.4): `POST /api/attribution/save` and socket
 * `attribution:save` both build the same portable profile `GET /api/attribution/export` returns, then
 * forward it as `attribution:write` to the verified host runner (`runsService.sendAttributionWrite`,
 * added in `modules/runs/runs.service.ts`). The runner's own realpath/`.git`/symlink/overwrite checks
 * are exercised in `apps/runner/test/unit/attributionWrite.test.ts`; here we only check that the
 * server forwards correctly, gates on `runner.enabled` + `runner.allowedProjectDirs`, is admin-gated,
 * and reports the runner's result (or a client-safe refusal) back to the caller.
 */

const TOKEN = 'c'.repeat(40);
const PROJECT: Project = {
  id: 'proj-attr-save',
  cwd: '/tmp/attr-save-project',
  name: 'Attr Save Project',
  archived: false,
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
};

async function withProject(app: App): Promise<void> {
  app.diContainer.cradle.projectsRepository.upsert(PROJECT);
}

async function connectAdminSocket(app: App): Promise<ClientSocket> {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const client: ClientSocket = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, {
    transports: ['websocket'],
    forceNew: true,
    auth: adminSocketAuth(app),
  });
  await new Promise<void>((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('connect_error', reject);
  });
  return client;
}

describe('attribution:save / POST /api/attribution/save (M8 8k/8l, §6.4)', () => {
  let app: App | undefined;
  let runner: FakeRunner | undefined;
  let socket: ClientSocket | undefined;

  afterEach(async () => {
    socket?.disconnect();
    runner?.close();
    await app?.close();
    app = runner = socket = undefined;
  });

  it('401s without an admin session', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    const res = await app.inject({ method: 'POST', url: '/api/attribution/save', payload: { projectId: PROJECT.id } });
    expect(res.statusCode).toBe(401);
  });

  it('404s an unknown project', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/attribution/save',
      payload: { projectId: 'does-not-exist' },
      headers: adminHeaders(app),
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses with runner_disabled while settings.runner.enabled is false (the default)', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, allowedProjectDirs: ['/tmp'] } } }); // enabled defaults to false
    await withProject(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/attribution/save',
      payload: { projectId: PROJECT.id },
      headers: adminHeaders(app),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/runner_disabled/) });
  });

  it('refuses with a clear "no verified runner" error when enabled but nothing is connected', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/attribution/save',
      payload: { projectId: PROJECT.id },
      headers: adminHeaders(app),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/no verified runner/i) });
  });

  it('refuses with dir_not_allowed when the project cwd is outside runner.allowedProjectDirs, without ever contacting the runner', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/somewhere/else'] } } });
    await withProject(app); // PROJECT.cwd = /tmp/attr-save-project, not under /somewhere/else
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    let contacted = false;
    runner.socket.on('attribution:write', () => {
      contacted = true;
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/attribution/save',
      payload: { projectId: PROJECT.id },
      headers: adminHeaders(app),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/dir_not_allowed/) });
    expect(contacted).toBe(false);
  });

  it('forwards the exported profile to the runner and returns its result (written)', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });

    const seen: AttributionWriteCommand[] = [];
    runner.socket.on('attribution:write', (cmd: AttributionWriteCommand, ack: (res: { ok: true; data: AttributionWriteResult }) => void) => {
      seen.push(cmd);
      ack({ ok: true, data: { written: true, existed: false, relativePath: '.tagconn/office.json' } });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/attribution/save',
      payload: { projectId: PROJECT.id },
      headers: adminHeaders(app),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AttributionWriteResult>()).toEqual({ written: true, existed: false, relativePath: '.tagconn/office.json' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ projectDir: PROJECT.cwd, overwrite: false });
    const profile = AttributionProfileSchema.parse(JSON.parse(seen[0]!.content));
    expect(profile.floor.name).toBe(PROJECT.name);
  });

  it('a second save without overwrite reports existed:true, written:false (not an error); overwrite:true asks the runner to replace it', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });

    const seenOverwrite: boolean[] = [];
    runner.socket.on('attribution:write', (cmd: AttributionWriteCommand, ack: (res: { ok: true; data: AttributionWriteResult }) => void) => {
      seenOverwrite.push(cmd.overwrite);
      ack({ ok: true, data: cmd.overwrite ? { written: true, existed: true, relativePath: '.tagconn/office.json' } : { written: false, existed: true, relativePath: '.tagconn/office.json' } });
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/attribution/save',
      payload: { projectId: PROJECT.id },
      headers: adminHeaders(app),
    });
    expect(first.json()).toEqual({ written: false, existed: true, relativePath: '.tagconn/office.json' });

    const second = await app.inject({
      method: 'POST',
      url: '/api/attribution/save',
      payload: { projectId: PROJECT.id, overwrite: true },
      headers: adminHeaders(app),
    });
    expect(second.json()).toEqual({ written: true, existed: true, relativePath: '.tagconn/office.json' });
    expect(seenOverwrite).toEqual([false, true]);
  });

  it('maps a runner-side refusal (e.g. no .git) to a client-safe error', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.socket.on('attribution:write', (_cmd: AttributionWriteCommand, ack: (res: { ok: false; error: string }) => void) => {
      ack({ ok: false, error: 'project directory has no .git' });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/attribution/save',
      payload: { projectId: PROJECT.id },
      headers: adminHeaders(app),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'project directory has no .git' });
  });

  it('the socket event attribution:save forwards the same way', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.socket.on('attribution:write', (_cmd: AttributionWriteCommand, ack: (res: { ok: true; data: AttributionWriteResult }) => void) => {
      ack({ ok: true, data: { written: true, existed: false, relativePath: '.tagconn/office.json' } });
    });

    socket = await connectAdminSocket(app);
    const ack = await new Promise<{ ok: boolean; data?: AttributionWriteResult; error?: string }>((resolve) =>
      socket!.emit('attribution:save', { projectId: PROJECT.id }, resolve),
    );
    expect(ack).toEqual({ ok: true, data: { written: true, existed: false, relativePath: '.tagconn/office.json' } });
  });

  it('a non-admin socket never receives an ack at all (fail-closed default gating)', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    socket = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve, reject) => {
      socket!.on('connect', () => resolve());
      socket!.on('connect_error', reject);
    });

    const timedOut = await Promise.race([
      new Promise<'acked'>((resolve) => socket!.emit('attribution:save', { projectId: PROJECT.id }, () => resolve('acked'))),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300)),
    ]);
    expect(timedOut).toBe('timeout');
  });
});
