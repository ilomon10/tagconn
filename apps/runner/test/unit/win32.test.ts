// M11 Wave 1 C: the runner's Windows behaviour (decision #28), exercised on any OS by injecting a win32 Platform.

import { absoluteRulePathForms, DEFAULT_QUEST_ALWAYS_DENY, DEFAULT_QUEST_MAX_ALLOWED_TOOLS, expandHomeDenyRules } from '@tagconn/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildReceptionistArgv } from '../../src/argv.js';
import { bwrapAvailable, probeSystemdScope, resolveClaudePath, type Spawn } from '../../src/capabilities.js';
import { loadRunnerConfig } from '../../src/config.js';
import { childSpawnOptions, defaultStateDir, killTree, makePlatform, resolveClaudeLaunch, taskkillArgs, type Platform } from '../../src/platform.js';
import { reapStaleQuestScopes } from '../../src/runProcess.js';
import { checkQuestPolicy, effectiveMaxPermissionMode } from '../../src/toolPolicy.js';
import { checkAllowedDir, defaultClaudeJsonPath, isTrustedDir, isWithinAllowedDirs, readTrustFlag } from '../../src/trust.js';
import { validateQuestStart } from '../../src/validate.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkSandbox, rmSandbox } from '../helpers.js';

const HOME = 'C:\\Users\\Ann';

interface FakeFs {
  files: Record<string, string>;
  where?: string[];
  runs?: Array<[string, string[]]>;
}

/** A win32 Platform over an in-memory file table (keys use backslashes, lower-case compare not needed). */
function win(fs: FakeFs, env: NodeJS.ProcessEnv = { USERPROFILE: HOME, LOCALAPPDATA: `${HOME}\\AppData\\Local` }): Platform {
  return makePlatform({
    os: 'win32',
    env,
    homedir: () => HOME,
    exists: (p) => p in fs.files,
    realpath: (p) => p,
    readText: (p) => {
      const t = fs.files[p];
      if (t === undefined) throw new Error('ENOENT');
      return t;
    },
    run: (command, args) => {
      fs.runs?.push([command, args]);
      if (command.endsWith('\\System32\\where.exe')) return fs.where ? { status: 0, stdout: fs.where.join('\r\n') + '\r\n' } : { status: 1, stdout: '' };
      return { status: 0, stdout: '' };
    },
    nodeExecPath: 'C:\\node\\node.exe',
  });
}

/** A win32 Platform whose whoami/icacls/dir answers say `file` is private to Ann. */
export function winWithGoodAcl(file: string): Platform {
  return makePlatform({
    ...win({ files: {} }),
    run: (command) => {
      if (command.endsWith('whoami.exe')) return { status: 0, stdout: '"desktop\\ann","S-1-5-21-1-2-3-1001"\r\n' };
      if (command.endsWith('icacls.exe')) return { status: 0, stdout: `${file} DESKTOP\\ann:(F)\r\n       NT AUTHORITY\\SYSTEM:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n` };
      return { status: 0, stdout: `01/02/2026  10:00 AM               123 DESKTOP\\ann ${file.split('/').pop()}\r\n` };
    },
  });
}

const NPM = 'C:\\Users\\Ann\\AppData\\Roaming\\npm';
const SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

describe('win32 claude path resolution', () => {
  it('prefers a real .exe from where.exe', () => {
    const exe = 'C:\\Tools\\claude.exe';
    const p = win({ files: { [exe]: '' }, where: [exe] });
    expect(resolveClaudeLaunch('claude', p)).toEqual({ command: exe, args: [] });
    expect(resolveClaudePath('claude', p)).toBe(exe);
  });

  it('falls back to %USERPROFILE%\\.local\\bin\\claude.exe', () => {
    const exe = `${HOME}\\.local\\bin\\claude.exe`;
    const p = win({ files: { [exe]: '' } });
    expect(resolveClaudeLaunch('claude', p)).toEqual({ command: exe, args: [] });
  });

  it('keeps PATH order: an earlier shim is not overridden by a later .exe (or the fallback)', () => {
    const exe = `${HOME}\\.local\\bin\\claude.exe`;
    const cmd = `${NPM}\\claude.cmd`;
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const p = win({ files: { [exe]: '', [cmd]: SHIM, [cli]: '' }, where: [`${NPM}\\claude`, cmd, 'C:\\Later\\claude.exe'] });
    expect(resolveClaudeLaunch('claude', p)).toEqual({ command: 'C:\\node\\node.exe', args: [cli] });
    // the first hit is an unparseable shim: fail closed rather than fall through to a later .exe
    const bad = win({ files: { [exe]: '', [cmd]: '@echo hi %*', 'C:\\Later\\claude.exe': '' }, where: [cmd, 'C:\\Later\\claude.exe'] });
    expect(resolveClaudeLaunch('claude', bad)).toBeUndefined();
  });

  it('uses the absolute System32 where.exe with $PATH: (PATH only), a timeout and a fixed cwd; drops relative hits', () => {
    const calls: Array<[string, string[], unknown]> = [];
    const p = makePlatform({
      ...win({ files: { 'C:\\Tools\\claude.exe': '' } }, { USERPROFILE: HOME, SystemRoot: 'C:\\Windows' }),
      run: (c, a, o) => {
        calls.push([c, a, o]);
        return { status: 0, stdout: '.\\claude.exe\r\nC:\\Tools\\claude.exe\r\n' };
      },
      exists: (f) => f === 'C:\\Tools\\claude.exe' || f === '.\\claude.exe',
    });
    expect(resolveClaudeLaunch('claude', p)?.command).toBe('C:\\Tools\\claude.exe');
    expect(calls[0]?.[0]).toBe('C:\\Windows\\System32\\where.exe');
    expect(calls[0]?.[1]).toEqual(['$PATH:claude']);
    expect(calls[0]?.[2]).toMatchObject({ cwd: 'C:\\Windows', timeoutMs: expect.any(Number) });
  });

  it('resolves an npm .cmd shim to node + cli.js, never through cmd.exe', () => {
    const cmd = `${NPM}\\claude.cmd`;
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const runs: Array<[string, string[]]> = [];
    const p = win({ files: { [cmd]: SHIM, [cli]: '' }, where: [`${NPM}\\claude`, cmd], runs });
    expect(resolveClaudeLaunch('claude', p)).toEqual({ command: 'C:\\node\\node.exe', args: [cli] });
    expect(runs.every(([c]) => c.endsWith('\\System32\\where.exe'))).toBe(true);
  });

  it('uses a node.exe sitting next to the shim', () => {
    const cmd = `${NPM}\\claude.cmd`;
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const p = win({ files: { [cmd]: SHIM, [cli]: '', [`${NPM}\\node.exe`]: '' }, where: [cmd] });
    expect(resolveClaudeLaunch('claude', p)?.command).toBe(`${NPM}\\node.exe`);
  });

  it('a shim that targets a native .exe resolves to that exe', () => {
    const cmd = `${NPM}\\claude.cmd`;
    const exe = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    const shim = '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
    const p = win({ files: { [cmd]: shim, [exe]: '' }, where: [cmd] });
    expect(resolveClaudeLaunch('claude', p)).toEqual({ command: exe, args: [] });
  });

  it('fails closed on an unparseable shim, a missing target, or nothing found', () => {
    const cmd = `${NPM}\\claude.cmd`;
    expect(resolveClaudeLaunch('claude', win({ files: { [cmd]: '@echo hi %*' }, where: [cmd] }))).toBeUndefined();
    expect(resolveClaudeLaunch('claude', win({ files: { [cmd]: SHIM }, where: [cmd] }))).toBeUndefined();
    expect(resolveClaudeLaunch('claude', win({ files: {} }))).toBeUndefined();
    expect(resolveClaudePath('claude', win({ files: {} }))).toBeUndefined();
  });

  it('an absolute claudePath is used as-is (no where.exe)', () => {
    const exe = 'D:\\bin\\claude.exe';
    const runs: Array<[string, string[]]> = [];
    expect(resolveClaudeLaunch(exe, win({ files: { [exe]: '' }, runs }))).toEqual({ command: exe, args: [] });
    expect(runs).toEqual([]);
  });
});

describe('win32 process control and probes', () => {
  it('kills a tree with taskkill /PID <pid> /T /F', () => {
    expect(taskkillArgs(4242)).toEqual(['/PID', '4242', '/T', '/F']);
    const runs: Array<[string, string[]]> = [];
    const kill = vi.fn();
    killTree(4242, { platform: makePlatform({ ...win({ files: {}, runs }, { USERPROFILE: HOME, SystemRoot: 'C:\\Windows' }), kill }), signal: 'SIGTERM', group: false });
    expect(runs).toEqual([['C:\\Windows\\System32\\taskkill.exe', ['/PID', '4242', '/T', '/F']]]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('POSIX keeps the group kill', () => {
    const kill = vi.fn();
    const posix = makePlatform({ os: 'linux', kill });
    killTree(77, { platform: posix, signal: 'SIGTERM', group: true });
    killTree(77, { platform: posix, signal: 'SIGKILL', group: false });
    expect(kill.mock.calls).toEqual([[-77, 'SIGTERM'], [77, 'SIGKILL']]);
  });

  it('spawn options: no detached group and windowsHide on win32', () => {
    expect(childSpawnOptions(win({ files: {} }), true)).toEqual({ detached: false, windowsHide: true });
    expect(childSpawnOptions(makePlatform({ os: 'linux' }), true)).toEqual({ detached: true, windowsHide: false });
    expect(childSpawnOptions(makePlatform({ os: 'linux' }), false).detached).toBe(false);
  });

  it('never spawns systemd-run, bwrap or systemctl on win32', () => {
    const spawn = vi.fn<Spawn>(() => ({ status: 0, stdout: '', stderr: '' }));
    const p = win({ files: {} });
    expect(probeSystemdScope(spawn, p)).toBe(false);
    expect(bwrapAvailable(spawn, p)).toBe(false);
    const systemctl = vi.fn(() => ({ status: 0, stdout: 'tagconn-quest-x.scope loaded' }));
    expect(reapStaleQuestScopes(systemctl, p)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
  });
});

describe('win32 state dir and config', () => {
  it('uses %LOCALAPPDATA%\\tagconn\\state, ignoring XDG', () => {
    const p = win({ files: {} }, { LOCALAPPDATA: 'C:\\L', XDG_STATE_HOME: 'C:\\xdg', USERPROFILE: HOME });
    expect(defaultStateDir(p)).toBe('C:\\L\\tagconn\\state');
  });

  it('falls back to <home>\\AppData\\Local when LOCALAPPDATA is unset', () => {
    expect(defaultStateDir(win({ files: {} }, {}))).toBe('C:\\Users\\Ann\\AppData\\Local\\tagconn\\state');
  });

  it('POSIX keeps XDG_STATE_HOME / ~/.local/state', () => {
    const posix = (env: NodeJS.ProcessEnv) => makePlatform({ os: 'linux', env, homedir: () => '/home/u' });
    expect(defaultStateDir(posix({ XDG_STATE_HOME: '/x' }))).toBe('/x/tagconn');
    expect(defaultStateDir(posix({}))).toBe('/home/u/.local/state/tagconn');
  });

  it('skips the POSIX 0600 mode check on win32 (the ACL is verified through icacls instead, see win32Hardening.test.ts)', () => {
    const root = mkSandbox();
    try {
      const path = join(root, 'runner.json');
      writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:4317', token: 'a'.repeat(32), stateDir: join(root, 'state') }), { mode: 0o644 });
      expect(() => loadRunnerConfig(path)).toThrow(/0600/);
      expect(loadRunnerConfig(path, winWithGoodAcl(path)).configPath).toBe(path);
    } finally {
      rmSandbox(root);
    }
  });
});

describe('win32 trust paths', () => {
  const p = win({ files: {} });

  it('builds ~/.claude.json with the win32 path module', () => {
    expect(defaultClaudeJsonPath(p)).toBe('C:\\Users\\Ann\\.claude.json');
  });

  it('containment is case-insensitive including the drive letter, and slash-agnostic', () => {
    expect(isWithinAllowedDirs('c:\\work\\proj\\sub', ['C:\\Work'], p)).toBe(true);
    expect(isWithinAllowedDirs('C:\\WORK', ['c:/work/'], p)).toBe(true);
    expect(isWithinAllowedDirs('C:\\Workshop', ['C:\\Work'], p)).toBe(false);
    expect(isWithinAllowedDirs('D:\\work', ['C:\\Work'], p)).toBe(false);
  });

  it('never allows a drive root or the home dir', () => {
    expect(isWithinAllowedDirs('C:\\', ['C:\\'], p)).toBe(false);
    expect(isWithinAllowedDirs('c:\\users\\ann', ['C:\\Users\\Ann'], p)).toBe(false);
    expect(isWithinAllowedDirs('C:\\Users\\Ann\\proj', ['C:\\Users\\Ann'], p)).toBe(true);
  });

  it('checkAllowedDir uses the platform realpath', () => {
    const real = makePlatform({ ...p, realpath: () => 'C:\\Work\\Proj' });
    expect(checkAllowedDir('whatever', ['c:\\work'], real)).toEqual({ ok: true, realDir: 'C:\\Work\\Proj' });
    const gone = makePlatform({ ...p, realpath: () => { throw new Error('ENOENT'); } });
    expect(checkAllowedDir('x', ['c:\\work'], gone).ok).toBe(false);
  });

  it('trust flag and overrides match exact dirs despite case and slash style, but not parents', () => {
    const root = mkSandbox();
    try {
      const json = join(root, '.claude.json');
      writeFileSync(json, JSON.stringify({ projects: { 'C:/Work/Proj': { hasTrustDialogAccepted: true }, 'C:/Work': { hasTrustDialogAccepted: false } } }));
      expect(readTrustFlag(json, 'c:\\work\\proj', p)).toBe(true);
      expect(readTrustFlag(json, 'C:\\Work\\Proj\\Sub', p)).toBe(false);
      expect(isTrustedDir('C:\\Work\\Proj', { claudeJsonPath: join(root, 'none.json'), trustOverrideDirs: ['c:\\work\\proj'] }, p)).toBe(true);
      expect(isTrustedDir('C:\\Other', { claudeJsonPath: json, trustOverrideDirs: [] }, p)).toBe(false);
    } finally {
      rmSandbox(root);
    }
  });
});

describe('win32 policy (decision #28)', () => {
  const ctx = (extra: object = {}) => ({
    maxPermissionMode: 'bypassPermissions' as const,
    allowBypassPermissions: true,
    questToolPolicy: { maxAllowedTools: [...DEFAULT_QUEST_MAX_ALLOWED_TOOLS, 'Bash(git status)'], alwaysDeny: [] },
    systemdScopeAvailable: true,
    platform: win({ files: {} }),
    ...extra,
  });
  const all = ['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];

  it('caps the mode at acceptEdits whatever runner.json allows', () => {
    expect(effectiveMaxPermissionMode('bypassPermissions', win({ files: {} }))).toBe('acceptEdits');
    expect(effectiveMaxPermissionMode('plan', win({ files: {} }))).toBe('plan');
    expect(effectiveMaxPermissionMode('bypassPermissions', makePlatform({ os: 'linux' }))).toBe('bypassPermissions');
    for (const mode of ['auto', 'bypassPermissions'] as const) {
      expect(checkQuestPolicy({ mode, allowedTools: [], availablePermissionModes: all }, ctx())).toEqual({ ok: false, failure: 'mode_not_allowed' });
    }
    expect(checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['Read'], availablePermissionModes: all }, ctx()).ok).toBe(true);
  });

  it('POSIX with the same config still allows auto', () => {
    const r = checkQuestPolicy({ mode: 'auto', allowedTools: [], availablePermissionModes: all }, ctx({ platform: makePlatform({ os: 'linux' }) }));
    expect(r.ok).toBe(true);
  });

  it('hard-denies Bash and keeps it out of --tools, even with an allow rule and a scope', () => {
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['Read', 'Bash(git status)'], availablePermissionModes: all }, ctx());
    if (!r.ok) throw new Error('expected ok');
    expect(r.toolSet).not.toContain('Bash');
    expect(r.disallowedTools).toContain('Bash');
    expect(r.allowedTools).toEqual(['Read']);
    expect(r.requiresScope).toBe(false);
  });

  it('emits every home deny in both absolute-path forms', () => {
    const r = checkQuestPolicy({ mode: 'plan', allowedTools: [], availablePermissionModes: all }, ctx());
    if (!r.ok) throw new Error('expected ok');
    expect(r.disallowedTools).toContain('Read(~/.ssh/**)');
    expect(r.disallowedTools).toContain('Read(//C:/Users/Ann/.ssh/**)');
    expect(r.disallowedTools).toContain('Read(C:/Users/Ann/.ssh/**)');
    expect(r.disallowedTools).toContain('Edit(//C:/Users/Ann/.claude/**)');
    expect(r.disallowedTools).toContain('Write(C:/Users/Ann/.bashrc)');
    expect(r.disallowedTools).toContain('Read(**/.env)');
  });

  it('validateQuestStart adds the stateDir deny in both forms and returns the filtered allow list', () => {
    const root = mkSandbox();
    try {
      const project = join(root, 'proj');
      mkdirSync(project);
      const claudeJson = join(root, '.claude.json');
      writeFileSync(claudeJson, JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
      const p = win({ files: {} });
      const r = validateQuestStart(
        { projectDir: project, permissionMode: 'acceptEdits', allowedTools: ['Read', 'Bash(git status)'], disallowedTools: [] },
        {
          allowedProjectDirs: [root],
          trustOverrideDirs: [],
          maxPermissionMode: 'acceptEdits',
          allowBypassPermissions: false,
          questToolPolicy: { maxAllowedTools: ['Read', 'Bash(git status)'], alwaysDeny: [...DEFAULT_QUEST_ALWAYS_DENY] },
          processIsolation: 'auto',
          stateDir: 'C:\\Users\\Ann\\AppData\\Local\\tagconn\\state',
        },
        { permissionModes: ['acceptEdits'], systemdScope: false },
        claudeJson,
        new Map(),
        p,
      );
      if (!r.ok) throw new Error(`expected ok, got ${r.failure}`);
      expect(r.disallowedTools).toContain('Edit(//C:/Users/Ann/AppData/Local/tagconn/state/**)');
      expect(r.disallowedTools).toContain('Write(C:/Users/Ann/AppData/Local/tagconn/state/**)');
      expect(r.allowedTools).toEqual(['Read']);
      expect(r.toolSet).not.toContain('Bash');
    } finally {
      rmSandbox(root);
    }
  });
});

describe('win32 Receptionist', () => {
  const base = {
    claudePath: 'claude.exe',
    scope: 'general' as const,
    model: 'haiku' as const,
    maxTurns: 5,
    webSearch: false,
    webFetchDomains: ['example.com'],
    sandboxed: false,
    safeMode: false,
    extraDisallowedTools: [],
    stdinPrompt: true,
    prompt: 'hi',
  };

  it('keeps the read-only tool set (no Bash, no WebFetch without a sandbox) and adds both deny forms', () => {
    const built = buildReceptionistArgv({ ...base, platform: win({ files: {} }) });
    expect(built.toolSet).not.toContain('Bash');
    expect(built.toolSet).not.toContain('WebFetch');
    const denied = built.argv.find((a) => a.startsWith('--disallowedTools='));
    expect(denied).toContain('Read(//C:/Users/Ann/.ssh/**)');
    expect(denied).toContain('Read(C:/Users/Ann/.ssh/**)');
    expect(denied).toContain('Bash');
  });
});

describe('deny-rule path forms (shared)', () => {
  it('absoluteRulePathForms emits both forms with forward slashes on win32, one on POSIX', () => {
    expect(absoluteRulePathForms('C:\\Users\\Ann\\x', true)).toEqual(['//C:/Users/Ann/x', 'C:/Users/Ann/x']);
    expect(absoluteRulePathForms('c:/Users/Ann', true)).toEqual(['//c:/Users/Ann', 'c:/Users/Ann']);
    expect(absoluteRulePathForms('/home/u/x')).toEqual(['//home/u/x']);
  });

  it('expandHomeDenyRules keeps the ~ rule, adds both forms, and passes non-home rules through', () => {
    expect(expandHomeDenyRules(['Read(~/.ssh/**)', 'Read(**/.env)', 'Bash', 'Edit(~/.npmrc)'], 'C:\\Users\\Ann\\')).toEqual([
      'Read(~/.ssh/**)',
      'Read(//C:/Users/Ann/.ssh/**)',
      'Read(C:/Users/Ann/.ssh/**)',
      'Read(//c:/Users/Ann/.ssh/**)',
      'Read(c:/Users/Ann/.ssh/**)',
      'Read(**/.env)',
      'Bash',
      'Edit(~/.npmrc)',
      'Edit(//C:/Users/Ann/.npmrc)',
      'Edit(C:/Users/Ann/.npmrc)',
      'Edit(//c:/Users/Ann/.npmrc)',
      'Edit(c:/Users/Ann/.npmrc)',
    ]);
  });
});
