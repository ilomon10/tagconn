import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckDeps } from '@tagconn/setup';
import { LogHub } from '../src/logHub.ts';
import { redact } from '../src/redact.ts';
import { resolveBundle, resolvePaths } from '../src/paths.ts';
import { createSupervisor } from '../src/supervisor.ts';
import { runnerDefinition, serverDefinition, serverEnv } from '../src/services.ts';
import { ConfigStore } from '../src/config.ts';
import { RpcFailure } from '../src/errors.ts';
import { FAKE_CHILD, tempDir, waitFor } from './helpers.ts';

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
    const dataDir = join(tempDir(), 'elsewhere', 'data');
    config.set({ dataDir });
    expect(serverEnv({ env, paths, bundle: resolveBundle({}), config, logs: new LogHub() }).OFFICE_STORAGE__DB_PATH).toBe(join(dataDir, 'office.db'));
    expect(statSync(dataDir).mode & 0o777).toBe(0o700); // N8
  });

  it('N2/N6/QA K: no cwd .env or office.yaml, an owned (created) OFFICE_CONFIG, no pairing code on boot, the parent pid', () => {
    const { env } = sandbox();
    const paths = resolvePaths(env, 'linux');
    const config = new ConfigStore({ configDir: paths.config });
    const e = serverEnv({ env: { ...env, OFFICE_CONFIG: '/tmp/evil.yaml', OFFICE_NO_DOTENV: '0' }, paths, bundle: resolveBundle({}), config, logs: new LogHub() });
    expect(e.OFFICE_NO_DOTENV).toBe('1');
    expect(e.OFFICE_CONFIG).toBe(join(paths.config, 'office.yaml')); // not the inherited one
    expect(existsSync(join(paths.config, 'office.yaml'))).toBe(true);
    expect(e.OFFICE_AUTH__LOG_PAIRING_CODE_ON_BOOT).toBe('false');
    expect(e.TAGCONN_PARENT_PID).toBe(String(process.pid));
  });

  it('N2: the server runs with cwd = the (tagconn-owned) data dir', async () => {
    const { env } = sandbox();
    const paths = resolvePaths(env, 'linux');
    const config = new ConfigStore({ configDir: paths.config });
    const checkDeps = { ...okDeps(), bindPort: async () => ({ ok: true as const }) };
    const def = serverDefinition({ env, paths, bundle: { ...resolveBundle({}), serverJs: process.execPath }, config, logs: new LogHub(), checkDeps });
    const spec = await def.prepare();
    expect(spec.cwd).toBe(join(paths.data));
    expect(statSync(spec.cwd!).mode & 0o777).toBe(0o700);
    expect(def.marker?.()).toBe(process.execPath);
  });
});

describe('redact and log ring', () => {
  it('N6: masks a pairing code and the "code" JSON field', () => {
    expect(redact('pairing code: 7GXK-2M9Q-R4TD (valid 5 min)')).not.toContain('7GXK-2M9Q-R4TD');
    expect(redact('code 7GXK2M9QR4TD')).not.toContain('7GXK2M9QR4TD');
    expect(redact('{"code":"anything-here","url":"http://x"}')).toBe('{"code":"[redacted]","url":"http://x"}');
    expect(redact('LISTENING on 127.0.0.1:4317')).toBe('LISTENING on 127.0.0.1:4317');
  });

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

  it('QA B/D: start resolves when running; a port change restarts the server cleanly (not a crash)', async () => {
    const { env } = sandbox();
    const seen: { state: string; lastError?: string }[] = [];
    const healthUrls: string[] = [];
    const sup = createSupervisor({
      env,
      platform: 'linux',
      checkDeps: okDeps(),
      stderr: () => {},
      bundle: { ...resolveBundle({}), serverJs: FAKE_CHILD },
      notify: (m, params) => {
        if (m === 'service.changed') seen.push(params as { state: string; lastError?: string });
      },
      // Healthy only on the port the server was started with; the old port stops answering after the change.
      health: async (url) => {
        healthUrls.push(url);
        return url.includes(`:${sup.config.get().serverPort}/`);
      },
      timing: { startPollMs: 15, healthIntervalMs: 15, stopTimeoutMs: 500 },
    });
    try {
      sup.config.set({ serverPort: 4700 });
      const started = await sup.handlers['service.start']({ id: 'server' });
      expect(started.state).toBe('running');
      const firstPid = started.pid;
      sup.config.set({ serverPort: 4701 }); // direct store call: no restart yet
      expect(sup.services.server.status().pid).toBe(firstPid);
      await sup.handlers['config.set']({ serverPort: 4702 });
      await waitFor(() => sup.services.server.status().state === 'running' && sup.services.server.status().pid !== firstPid, 5000, 'a restart on the new port');
      expect(seen.some((s) => s.state === 'crashed')).toBe(false);
      expect(seen.some((s) => (s.lastError ?? '').includes('Restarting'))).toBe(false);
      expect(healthUrls.at(-1)).toContain(':4702/');
    } finally {
      await sup.shutdown();
    }
  });

  it('N8: config.set rejects a relative, root or home path, and a data dir inside an allowed dir', async () => {
    const { root, env } = sandbox();
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const sup = createSupervisor({ env, platform: 'linux', checkDeps: okDeps(), stderr: () => {} });
    const set = async (p: object) => sup.handlers['config.set'](p);
    await expect(set({ dataDir: 'relative/dir' })).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('absolute') });
    await expect(set({ allowedProjectDirs: ['relative'] })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(set({ allowedProjectDirs: ['/'] })).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('root') });
    await expect(set({ dataDir: '/' })).rejects.toMatchObject({ code: 'invalid_request' });
    const cfg = sup.config;
    // HOME is only consulted through the store's env: build one that knows the sandbox home.
    const store = new ConfigStore({ configDir: join(root, 'cfg2'), env, homeDir: home });
    expect(() => store.set({ allowedProjectDirs: [home] })).toThrow(/home folder/);
    expect(() => store.set({ dataDir: home })).toThrow(/home folder/);
    const proj = join(root, 'work', 'proj');
    mkdirSync(proj, { recursive: true });
    expect(() => store.set({ allowedProjectDirs: [proj], dataDir: join(proj, 'data') })).toThrow(/inside an allowed project folder/);
    store.set({ allowedProjectDirs: [proj] });
    expect(() => store.set({ dataDir: join(proj, 'sub', 'data') })).toThrow(/inside an allowed project folder/);
    expect(existsSync(join(proj, 'sub'))).toBe(false); // nothing created when rejected
    expect(cfg.get().dataDir).toBeNull();
    // A valid data dir outside is created private.
    const data = join(root, 'safe-data');
    store.set({ dataDir: data });
    expect(statSync(data).mode & 0o777).toBe(0o700);
  });

  it('N8: the runner gets dataDir, bundleDir and hookNodePath in runner.json at start (only when they changed)', async () => {
    const { root, env } = sandbox();
    const paths = resolvePaths(env, 'linux');
    const config = new ConfigStore({ configDir: paths.config, env });
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(join(paths.config, 'runner.json'), JSON.stringify({ token: 'r'.repeat(64), url: 'http://127.0.0.1:4317', allowedProjectDirs: [], keep: 1 }));
    config.set({ dataDir: join(root, 'd') });
    const bundle = { ...resolveBundle({}), dir: join(root, 'bundle'), runnerJs: FAKE_CHILD };
    const def = runnerDefinition({ env, paths, bundle, config, logs: new LogHub(), platform: 'linux' });
    await def.prepare();
    const json = JSON.parse(readFileSync(join(paths.config, 'runner.json'), 'utf8'));
    expect(json).toMatchObject({ keep: 1, dataDir: join(root, 'd'), bundleDir: join(root, 'bundle') });
    expect(typeof json.hookNodePath).toBe('string');
    const mtime = statSync(join(paths.config, 'runner.json')).mtimeMs;
    await def.prepare();
    expect(statSync(join(paths.config, 'runner.json')).mtimeMs).toBe(mtime);
    expect(statSync(join(paths.config, 'runner.json')).mode & 0o777).toBe(0o600);
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
