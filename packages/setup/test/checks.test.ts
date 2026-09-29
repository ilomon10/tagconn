import { describe, expect, it } from 'vitest';
import {
  checkClaudeCli,
  checkClaudeLogin,
  checkClaudeSettings,
  checkConfigDir,
  checkDataDir,
  checkDocker,
  checkGitBash,
  checkHooks,
  checkRunnerPlatform,
  checkServerPort,
  defaultCheckDeps,
  findClaude,
  HOOK_EVENTS,
  installHooks,
  runSetupChecks,
  type CheckDeps,
  type ExecResult,
} from '../src/index.ts';

type Call = [string, ...string[]];

/** Deps with everything mocked: `exec` answers from a table keyed by "cmd arg arg". */
function deps(over: Partial<CheckDeps> & { table?: Record<string, Partial<ExecResult>>; files?: Record<string, string>; busy?: number[] } = {}) {
  const calls: Call[] = [];
  const files = over.files ?? {};
  const table = over.table ?? {};
  const busy = new Set(over.busy ?? []);
  const d: CheckDeps = {
    ...defaultCheckDeps(),
    platform: 'linux',
    env: {},
    homedir: '/home/u',
    exec: (cmd, args) => {
      calls.push([cmd, ...args]);
      const r = table[[cmd, ...args].join(' ')];
      if (!r) return { status: null, stdout: '', stderr: '', error: Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }) };
      return { status: 0, stdout: '', stderr: '', ...r };
    },
    exists: (p) => p in files,
    readFile: (p) => files[p] ?? '',
    assertWritable: () => {},
    writeTest: () => {},
    bindPort: async (port) => (busy.has(port) ? { ok: false, code: 'EADDRINUSE', message: 'in use' } : { ok: true }),
    ...over,
  };
  return { d, calls };
}

describe('claude_cli / claude_login', () => {
  it('POSIX: command -v, then the version', () => {
    const { d } = deps({ table: { 'sh -c command -v claude': { stdout: '/usr/bin/claude\n' }, '/usr/bin/claude --version': { stdout: '2.1.283 (Claude Code)\n' } } });
    const c = checkClaudeCli(d);
    expect(c).toMatchObject({ id: 'claude_cli', status: 'ok', required: false });
    expect(c.detail).toContain('2.1.283');
    expect(c.detail).toContain('/usr/bin/claude');
  });

  it('falls back to the native install path', () => {
    const { d } = deps({ files: { '/home/u/.local/bin/claude': '' }, table: { '/home/u/.local/bin/claude --version': { stdout: '2.0.1' } } });
    expect(findClaude(d)).toBe('/home/u/.local/bin/claude');
  });

  it('missing: fail (not required), link to the install page, recheck available via the wizard', () => {
    const c = checkClaudeCli(deps().d);
    expect(c).toMatchObject({ status: 'fail', required: false });
    expect(c.fix).toMatchObject({ action: 'open_url' });
    expect(c.detail).toMatch(/not found/);
  });

  it('too old', () => {
    const { d } = deps({ table: { 'sh -c command -v claude': { stdout: '/c' }, '/c --version': { stdout: '1.0.5' } } });
    const c = checkClaudeCli(d, { minVersion: '2.0.0' });
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('older than 2.0.0');
  });

  it('win32: where.exe prefers .exe over an npm .cmd shim; a .cmd shim runs through cmd.exe', () => {
    const win = { platform: 'win32' as const, homedir: 'C:\\Users\\u', env: { USERPROFILE: 'C:\\Users\\u' } };
    const both = deps({ ...win, table: { 'where.exe claude': { stdout: 'C:\\npm\\claude.cmd\r\nC:\\bin\\claude.exe\r\n' }, 'C:\\bin\\claude.exe --version': { stdout: '2.1.0' } } });
    expect(findClaude(both.d)).toBe('C:\\bin\\claude.exe');
    const shim = deps({ ...win, table: { 'where.exe claude': { stdout: 'C:\\npm\\claude.cmd\r\n' }, 'cmd.exe /d /c C:\\npm\\claude.cmd --version': { stdout: '2.1.0' } } });
    expect(checkClaudeCli(shim.d).status).toBe('ok');
  });

  it('win32: falls back to %USERPROFILE%\\.local\\bin\\claude.exe when where.exe finds nothing', () => {
    const native = 'C:\\Users\\u\\.local\\bin\\claude.exe';
    const { d } = deps({ platform: 'win32', homedir: 'C:\\Users\\u', env: { USERPROFILE: 'C:\\Users\\u' }, files: { [native]: '' }, table: { 'where.exe claude': { status: 1 } } });
    expect(findClaude(d)).toBe(native);
  });

  it('login: `claude auth status` exit code', () => {
    const base = { 'sh -c command -v claude': { stdout: '/c' } };
    expect(checkClaudeLogin(deps({ table: { ...base, '/c auth status': { status: 0 } } }).d).status).toBe('ok');
    const out = checkClaudeLogin(deps({ table: { ...base, '/c auth status': { status: 1 } } }).d);
    expect(out).toMatchObject({ status: 'fail', fix: { action: 'recheck' } });
    expect(out.detail).toContain('Run `claude` once');
    expect(checkClaudeLogin(deps().d).status).toBe('skip');
  });
});

describe('git_bash / runner_platform (win32 only)', () => {
  it('are not reported on linux', () => {
    expect(checkGitBash(deps().d)).toBeNull();
    expect(checkRunnerPlatform(deps().d)).toBeNull();
  });

  it('git_bash: ok when Git Bash exists, warn (never fail) with a link when not', () => {
    const win = { platform: 'win32' as const, homedir: 'C:\\Users\\u', env: { ProgramFiles: 'C:\\Program Files' } };
    const ok = checkGitBash(deps({ ...win, files: { 'C:\\Program Files\\Git\\bin\\bash.exe': '' } }).d);
    expect(ok?.status).toBe('ok');
    const missing = checkGitBash(deps({ ...win, table: { 'where.exe git': { status: 1 } } }).d);
    expect(missing).toMatchObject({ status: 'warn', required: false, fix: { action: 'open_url' } });
  });

  it('runner_platform warns with the decision #28 limits', () => {
    const c = checkRunnerPlatform(deps({ platform: 'win32' }).d);
    expect(c?.status).toBe('warn');
    expect(c?.detail).toMatch(/Bash is always denied/);
    expect(c?.detail).toMatch(/acceptEdits/);
  });
});

describe('server_port / dirs', () => {
  it('ok when free', async () => {
    expect(await checkServerPort(deps().d, 4317)).toMatchObject({ status: 'ok', required: true });
  });

  it('busy: fail, required, offers the next free port', async () => {
    const c = await checkServerPort(deps({ busy: [4317, 4318] }).d, 4317);
    expect(c).toMatchObject({ status: 'fail', required: true, fix: { action: 'use_next_free_port', target: '4319' } });
    expect(c.detail).toContain('already in use');
  });

  it('real bind test on a free and a taken loopback port', async () => {
    const real = defaultCheckDeps();
    const { createServer } = await import('node:net');
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await real.bindPort(port)).toMatchObject({ ok: false, code: 'EADDRINUSE' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(await real.bindPort(port)).toEqual({ ok: true });
  });

  it('config/data dir write tests', () => {
    expect(checkConfigDir(deps().d, '/c').status).toBe('ok');
    const bad = deps({
      writeTest: () => {
        throw new Error('EACCES: permission denied');
      },
    }).d;
    expect(checkDataDir(bad, '/data')).toMatchObject({ status: 'fail', required: true, fix: { action: 'choose_data_dir' } });
    expect(checkConfigDir(bad, '/c').detail).toContain('/c');
  });
});

describe('claude_settings / hooks', () => {
  const path = '/home/u/.claude/settings.json';

  it('missing file is fine (it will be created)', () => {
    expect(checkClaudeSettings(deps().d, path).status).toBe('ok');
  });

  it('invalid JSON: fail with the position and an Open file fix', () => {
    const c = checkClaudeSettings(deps({ files: { [path]: '{\n "a": 1,\n oops\n}' } }).d, path);
    expect(c).toMatchObject({ status: 'fail', required: true, fix: { action: 'open_file', target: path } });
    expect(c.detail).toContain('line 3');
  });

  it('locked file: fail with Retry', () => {
    const c = checkClaudeSettings(
      deps({
        files: { [path]: '{}' },
        assertWritable: () => {
          throw new Error('EPERM');
        },
      }).d,
      path,
    );
    expect(c).toMatchObject({ status: 'fail', fix: { action: 'recheck' } });
  });

  it('hooks: none, node, sh, partial', () => {
    expect(checkHooks(deps().d, path)).toMatchObject({ status: 'warn', fix: { action: 'install_hooks' } });
    const node = {};
    installHooks(node, { kind: 'node', nodePath: '/n', scriptPath: '/cfg/office-hook.mjs' });
    const c = checkHooks(deps({ files: { [path]: JSON.stringify(node) } }).d, path);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('node kind');
    const sh = {};
    installHooks(sh, { kind: 'sh', scriptPath: '/a/tagconn/office-hook.sh', confPath: '/a/tagconn/curl.conf', isDefaultConfigDir: true });
    expect(checkHooks(deps({ files: { [path]: JSON.stringify(sh) } }).d, path).detail).toContain('sh kind');
    const partial = JSON.parse(JSON.stringify(node));
    delete partial.hooks[HOOK_EVENTS[0] as string];
    expect(checkHooks(deps({ files: { [path]: JSON.stringify(partial) } }).d, path)).toMatchObject({ status: 'warn', fix: { action: 'install_hooks' } });
  });
});

describe('docker', () => {
  it('skipped unless docker mode', () => {
    const { d, calls } = deps();
    expect(checkDocker(d, false).status).toBe('skip');
    expect(calls).toEqual([]);
  });

  it('docker mode: ok / not running / not installed', () => {
    expect(checkDocker(deps({ table: { 'docker info': { status: 0 } } }).d, true).status).toBe('ok');
    const down = checkDocker(deps({ table: { 'docker info': { status: 1 } } }).d, true);
    expect(down).toMatchObject({ status: 'fail', required: true, fix: { action: 'switch_to_native' } });
    expect(down.detail).toContain('not running');
    expect(checkDocker(deps().d, true).detail).toContain('not installed');
  });
});

describe('runSetupChecks', () => {
  it('returns SetupChecks in wizard order and omits win32-only checks on linux', async () => {
    const { d } = deps();
    const out = await runSetupChecks({ claudeDir: '/home/u/.claude', configDir: '/c', dataDir: '/d', port: 4317 }, d);
    expect(out.map((c) => c.id)).toEqual(['claude_cli', 'claude_login', 'server_port', 'config_dir', 'data_dir', 'claude_settings', 'hooks', 'docker']);
  });

  it('includes git_bash and runner_platform on win32', async () => {
    const { d } = deps({ platform: 'win32', homedir: 'C:\\Users\\u', table: { 'where.exe claude': { status: 1 }, 'where.exe git': { status: 1 } } });
    const out = await runSetupChecks({ claudeDir: 'C:\\Users\\u\\.claude', configDir: 'C:\\c', dataDir: 'C:\\d', port: 4317 }, d);
    expect(out.map((c) => c.id)).toEqual(expect.arrayContaining(['git_bash', 'runner_platform']));
  });
});
