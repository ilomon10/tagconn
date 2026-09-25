import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MASKED_SECRET, OFFICE_NAMESPACE, type ClientToServerEvents, type ServerToClientEvents, type Settings } from '@tagconn/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { loadConfig } from '../../../core/config/index.js';
import { buildTestApp, makeTempDir } from '../../../../test/helpers.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe('layered config loader', () => {
  it('applies defaults → YAML → env → overrides', () => {
    const dir = makeTempDir();
    const file = join(dir, 'office.yaml');
    writeFileSync(file, 'server:\n  port: 5000\n  logLevel: debug\nagents:\n  idleAfterSec: 30\n');
    const { base, configFile } = loadConfig({
      configFile: file,
      env: {
        OFFICE_SERVER__PORT: '6000',
        OFFICE_HOOK_TOKEN: '123456',
        OFFICE_PATHS__AGENTS_DIR: '~/agents-x',
        OFFICE_SERVER__CORS_ORIGINS: 'http://a,http://b',
        OFFICE_AGENTS__TYPE_TO_ROLE: '{"Explore":"analyst"}',
        OFFICE_INGEST__STORE_TOOL_PAYLOADS: 'true',
        OFFICE_PORT: '9999', // no section separator: not a settings key
      },
      overrides: { agents: { doneLingerSec: 1 } },
    });
    expect(configFile).toBe(file);
    expect(base.server.port).toBe(6000);
    expect(base.server.logLevel).toBe('debug');
    expect(base.server.hookToken).toBe('123456'); // stays a string
    expect(base.server.corsOrigins).toEqual(['http://a', 'http://b']);
    expect(base.paths.agentsDir).toBe(join(homedir(), 'agents-x'));
    expect(base.agents).toMatchObject({ idleAfterSec: 30, doneLingerSec: 1, typeToRole: { Explore: 'analyst' } });
    expect(base.ingest.storeToolPayloads).toBe(true);
    expect(base.storage.snapshotEventLimit).toBe(200); // default
  });

  it('rejects invalid values with a clear error', () => {
    expect(() => loadConfig({ configFile: false, env: { OFFICE_SERVER__PORT: 'abc' } })).toThrow(/Invalid configuration/);
  });
});

describe('settings REST', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('updates, broadcasts, and resets (mutable keys)', async () => {
    app = await buildTestApp();
    const changes: string[][] = [];
    app.diContainer.cradle.bus.on('settings.changed', ({ changed }) => changes.push(changed));

    const res = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agents: { idleAfterSec: 5 } } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ settings: Settings; restartRequired: string[] }>();
    // Every currently-listed RESTART_REQUIRED_SETTINGS key also falls under GUI_IMMUTABLE_SETTINGS
    // (server.*, storage.dbPath, paths.*), so a GUI-permitted patch never reports one.
    expect(body.restartRequired).toEqual([]);
    expect(body.settings.agents.idleAfterSec).toBe(5);
    expect(body.settings.agents.doneLingerSec).toBe(20); // untouched siblings keep their value
    expect(changes).toEqual([['agents.idleAfterSec']]);

    const second = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { office: { zoom: 2 } } });
    expect(second.json()).toMatchObject({ restartRequired: [], settings: { agents: { idleAfterSec: 5 }, office: { zoom: 2 } } });

    const got = (await app.inject({ url: '/api/settings' })).json<Settings>();
    expect(got.office.zoom).toBe(2);

    const reset = await app.inject({ method: 'POST', url: '/api/settings/reset', headers: { 'content-type': 'application/json' } });
    expect(reset.json()).toMatchObject({ restartRequired: [], settings: { agents: { idleAfterSec: 90 }, office: { zoom: 1 } } });
  });

  it('rejects invalid patches without changing anything', async () => {
    app = await buildTestApp();
    const bad = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agents: { idleAfterSec: 'x' } } });
    expect(bad.statusCode).toBe(400);
    const badRegex = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { activity: { rules: [{ tool: '(', activity: 'typing' }] } },
    });
    expect(badRegex.statusCode).toBe(400);
    expect(badRegex.json().error).toMatch(/activity\.rules\[0\]\.tool/);
    expect(app.diContainer.cradle.settings.get().agents.idleAfterSec).toBe(90);
  });

  it('rejects a nested-quantifier (ReDoS-prone) regex', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { ingest: { redactPatterns: ['(a+)+$'] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unsafe regex/i);
  });

  it('rejects a patch touching any GUI-immutable setting, listing the offending keys', async () => {
    app = await buildTestApp();
    for (const payload of [
      { paths: { agentsDir: '/tmp/evil' } },
      { server: { hookToken: 'sneaky' } },
      { runner: { permissionMode: 'bypassPermissions' } },
    ]) {
      const res = await app.inject({ method: 'PATCH', url: '/api/settings', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toMatch(/immutable/i);
    }
    // Nothing changed.
    expect(app.diContainer.cradle.settings.get().paths.agentsDir).not.toBe('/tmp/evil');
  });

  it('never returns the real hook token over REST or sockets', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: 's3cret-token' } } });
    const rest = (await app.inject({ url: '/api/settings' })).json<Settings>();
    expect(rest.server.hookToken).toBe(MASKED_SECRET);
    expect(JSON.stringify(rest)).not.toContain('s3cret-token');

    // An empty token stays '' so the UI can warn "no token configured".
    const noToken = await buildTestApp();
    expect((await noToken.inject({ url: '/api/settings' })).json<Settings>().server.hookToken).toBe('');
    await noToken.close();

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const socket: ClientSocket = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, { transports: ['websocket'], forceNew: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });
      const ack = await new Promise<{ ok: boolean; data?: Settings }>((resolve) => socket.emit('settings:get', resolve));
      expect(ack.data?.server.hookToken).toBe(MASKED_SECRET);
    } finally {
      socket.disconnect();
    }
  });

  it('replaces map-typed settings (agents.typeToRole) wholesale instead of merging, via settings:update', async () => {
    app = await buildTestApp({ settings: { agents: { typeToRole: { 'general-purpose': 'developer', Explore: 'analyst', Plan: 'architect' } } } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const socket: ClientSocket = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, { transports: ['websocket'], forceNew: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });
      // Sending the map without "Explore" must delete it, not just leave it merged in.
      const ack = await new Promise<{ ok: boolean; data?: Settings }>((resolve) =>
        socket.emit('settings:update', { agents: { typeToRole: { 'general-purpose': 'developer' } } }, resolve),
      );
      expect(ack.ok).toBe(true);
      expect(ack.data?.agents.typeToRole).toEqual({ 'general-purpose': 'developer' });
      expect(app.diContainer.cradle.settings.get().agents.typeToRole).toEqual({ 'general-purpose': 'developer' });
    } finally {
      socket.disconnect();
    }
  });

  it('persists runtime overrides in the database across restarts', async () => {
    const dbPath = join(makeTempDir(), 'office.db');
    app = await buildTestApp({ dbPath });
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { storage: { eventRetentionDays: 3 } } });
    await app.close();
    app = await buildTestApp({ dbPath });
    expect(app.diContainer.cradle.settings.get().storage.eventRetentionDays).toBe(3);
  });

  it('null in a patch reverts a key to the lower layer', async () => {
    app = await buildTestApp({ settings: { office: { zoom: 1.5 } } });
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { office: { zoom: 3 } } });
    expect(app.diContainer.cradle.settings.get().office.zoom).toBe(3);
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { office: { zoom: null } } });
    expect(app.diContainer.cradle.settings.get().office.zoom).toBe(1.5);
  });
});
