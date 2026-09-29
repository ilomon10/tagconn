import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckDeps } from '@tagconn/setup';
import { LogHub } from '../src/logHub.ts';
import { redact } from '../src/redact.ts';
import { resolveBundle, resolvePaths } from '../src/paths.ts';
import { createSupervisor } from '../src/supervisor.ts';
import { serverEnv } from '../src/services.ts';
import { ConfigStore } from '../src/config.ts';
import { RpcFailure } from '../src/errors.ts';
import { tempDir } from './helpers.ts';

function sandbox() {
  const root = tempDir();
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    TAGCONN_CONFIG_DIR: join(root, 'cfg'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_DATA_HOME: join(root, 'data'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    OFFICE_SERVER__PORT: '9999',
    ANTHROPIC_API_KEY: 'sk-ant-should-not-leak-0123456789',
  };
  return { root, env };
}

describe('server env', () => {
  it('passes the port, cors origin, web dir, db path, tokens and runner scope; strips inherited OFFICE_/ANTHROPIC_', async () => {
    const { root, env } = sandbox();
    const paths = resolvePaths(env, 'linux');
    const bundle = resolveBundle({});
    const config = new ConfigStore({ configDir: paths.config });
    config.set({ serverPort: 4555, allowedProjectDirs: ['/work/a'] });
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(join(paths.config, 'hook.json'), JSON.stringify({ token: 'h'.repeat(32) }));
    writeFileSync(join(paths.config, 'runner.json'), JSON.stringify({ token: 'r'.repeat(64) }));
    const logs = new LogHub();
    const e = serverEnv({ env, paths, bundle, config, logs });
    expect(e).toMatchObject({
      OFFICE_SERVER__HOST: '127.0.0.1',
      OFFICE_SERVER__PORT: '4555',
      OFFICE_SERVER__CORS_ORIGINS: JSON.stringify(['http://127.0.0.1:4555', 'http://localhost:4555']),
      OFFICE_SERVER__WEB_DIR: bundle.webDir,
      OFFICE_SERVER__ALLOWED_HOSTS: JSON.stringify(['localhost', '127.0.0.1', '[::1]']),
      OFFICE_STORAGE__DB_PATH: join(root, 'data', 'tagconn', 'office.db'),
      OFFICE_HOOK_TOKEN: 'h'.repeat(32),
      OFFICE_RUNNER__TOKEN: 'r'.repeat(64),
      OFFICE_RUNNER__ENABLED: 'true',
      OFFICE_RUNNER__ALLOWED_PROJECT_DIRS: JSON.stringify(['/work/a']),
    });
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.OFFICE_SERVER__PORT).toBe('4555'); // not the inherited 9999
    // The tokens are now log secrets.
    logs.push('server', 'stdout', `using ${'h'.repeat(32)} and ${'r'.repeat(64)}`);
    expect(logs.tail('server', 1)[0]!.line).toBe('using [redacted] and [redacted]');
  });

  it('data dir override moves the database', () => {
    const { env } = sandbox();
    const paths = resolvePaths(env, 'linux');
    const config = new ConfigStore({ configDir: paths.config });
    config.set({ dataDir: '/elsewhere/data' });
    expect(serverEnv({ env, paths, bundle: resolveBundle({}), config, logs: new LogHub() }).OFFICE_STORAGE__DB_PATH).toBe(join('/elsewhere/data', 'office.db'));
  });
});

describe('redact and log ring', () => {
  it('masks token-like values', () => {
    expect(redact('x-office-token: abc123')).toBe('x-office-token: [redacted]');
    expect(redact('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redact('open http://127.0.0.1:4317/#pair=ABCD-EFGH')).toBe('open http://127.0.0.1:4317/#pair=[redacted]');
    expect(redact('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('key [redacted]');
    expect(redact('hook ' + 'ab12'.repeat(16))).toBe('hook [redacted]');
    expect(redact('port 4317 started')).toBe('port 4317 started');
  });

  it('keeps only the last 2000 lines per service', () => {
    const logs = new LogHub();
    for (let i = 0; i < 2100; i++) logs.push('server', 'stdout', `line ${i}`);
    expect(logs.tail('server', 2000)).toHaveLength(2000);
    expect(logs.tail('server', 1)[0]!.line).toBe('line 2099');
    expect(logs.tail('server', 2000)[0]!.line).toBe('line 100');
    expect(logs.tail('runner', 5)).toEqual([]);
  });
});

describe('handlers', () => {
  const okDeps = (): CheckDeps => ({
    platform: 'linux',
    env: {},
    homedir: '/nonexistent',
    exec: () => ({ status: 1, stdout: '', stderr: '', error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }),
    exists: () => false,
    bindPort: async () => ({ ok: true }),
    writeTest: () => {},
    assertWritable: () => {},
    readFile: () => '',
  });

  it('app.info, config.get/set, service.status, logs.tail and diagnostics.collect', async () => {
    const { root, env } = sandbox();
    const sup = createSupervisor({ env, platform: 'linux', checkDeps: okDeps(), stderr: () => {} });
    const info = await sup.handlers['app.info']({});
    expect(info.paths).toEqual({ config: join(root, 'cfg'), state: join(root, 'state', 'tagconn'), data: join(root, 'data', 'tagconn'), claudeDir: join(root, 'claude') });
    expect(info.rpcVersion).toBe(1);
    expect((await sup.handlers['config.set']({ serverPort: 4600 })).serverPort).toBe(4600);
    expect((await sup.handlers['config.get']({})).serverPort).toBe(4600);
    expect((await sup.handlers['service.status']({})).map((s) => s.id)).toEqual(['server', 'runner', 'docker']);
    sup.logs.push('server', 'stdout', 'token=supersecretvalue123');
    expect(await sup.handlers['logs.tail']({ service: 'server', lines: 5 })).toHaveLength(1);
    const diag = await sup.handlers['diagnostics.collect']({});
    expect(diag.text).toContain('## setup checks');
    expect(diag.text).toContain('## log: server');
    expect(diag.text).not.toContain('supersecretvalue123');
    const checks = await sup.handlers['setup.check']({});
    expect(checks.find((c) => c.id === 'claude_cli')?.status).toBe('fail');
  });

  it('runner start without setup fails with spawn_failed and a hint; pair.mint needs a running server', async () => {
    const { env } = sandbox();
    const sup = createSupervisor({ env, platform: 'linux', checkDeps: okDeps(), stderr: () => {} });
    await expect(sup.handlers['service.start']({ id: 'runner' })).rejects.toMatchObject({ code: 'spawn_failed', hint: expect.stringContaining('setup') });
    await expect(sup.handlers['pair.mint']({})).rejects.toMatchObject({ code: 'not_running' });
  });

  it('server start on a busy port fails with port_in_use and names the next free port', async () => {
    const { env } = sandbox();
    const checkDeps = { ...okDeps(), bindPort: async (p: number) => (p === 4317 ? { ok: false as const, code: 'EADDRINUSE', message: 'in use' } : { ok: true as const }) };
    const sup = createSupervisor({ env, platform: 'linux', checkDeps, stderr: () => {} });
    const err = await (async () => sup.handlers['service.start']({ id: 'server' }))().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcFailure);
    expect(err).toMatchObject({ code: 'port_in_use', hint: expect.stringContaining('4318') });
  });

  it('setup.install (node hook, sandboxed) then setup.uninstall; a broken settings.json is never overwritten', async () => {
    const { root, env } = sandbox();
    const sup = createSupervisor({ env, platform: 'linux', checkDeps: okDeps(), stderr: () => {} });
    const settings = join(root, 'claude', 'settings.json');
    mkdirSync(join(root, 'claude'), { recursive: true });
    writeFileSync(settings, '{ "hooks": ');
    await expect(sup.handlers['setup.install']({})).rejects.toMatchObject({ code: 'install_failed', message: expect.stringContaining('settings.json') });
    expect(readFileSync(settings, 'utf8')).toBe('{ "hooks": ');
    expect(existsSync(join(root, 'cfg', 'hook.json'))).toBe(false);

    writeFileSync(settings, '{}');
    const res = await sup.handlers['setup.install']({});
    expect(res.backup).toBeTruthy();
    expect(res.changed).toContain(join(root, 'cfg', 'hook.json'));
    const hooks = JSON.parse(readFileSync(settings, 'utf8')).hooks;
    const entry = hooks.SessionStart[0].hooks[0];
    expect(entry).toMatchObject({ command: process.execPath, args: [join(root, 'cfg', 'office-hook.mjs')] });
    expect(JSON.parse(readFileSync(join(root, 'cfg', 'hook.json'), 'utf8')).url).toBe('http://127.0.0.1:4317');

    const un = await sup.handlers['setup.uninstall']({});
    expect(un.changed.length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'cfg', 'hook.json'))).toBe(false);
    expect(JSON.parse(readFileSync(settings, 'utf8')).hooks ?? {}).toEqual({});
  });
});
