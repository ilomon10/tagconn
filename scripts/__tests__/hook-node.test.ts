// Node-hook-only tests for packages/hook/office-hook.mjs: robustness guarantees
// (always exit 0, never stdout, hard 1 s budget) and the pure path/parse helpers
// (win32 semantics are unit-tested through path.win32, no Windows needed).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHookSandbox,
  TEST_TOKEN,
  type HookSandbox,
  nodeHookScript,
  runHook,
  type ServerMode,
  spawnHook,
  writeHookJson,
} from './support/hook-harness.ts';
// @ts-expect-error plain JS module without types
import * as hook from '../../packages/hook/office-hook.mjs';

const opened: HookSandbox[] = [];
afterEach(async () => {
  for (const sb of opened.splice(0)) await sb.server?.close();
});

async function sandbox(mode: ServerMode = 'ok'): Promise<HookSandbox> {
  const sb = await createHookSandbox('node', mode);
  opened.push(sb);
  return sb;
}

describe('node hook robustness', () => {
  it('invalid JSON stdin: still forwarded verbatim, exits 0, no stdout', async () => {
    const sb = await sandbox();
    const res = await runHook('', sb, 'this is {not json');
    expect(res.status).toBe(0);
    expect(sb.server?.requests[0]?.body).toBe('this is {not json');
  });

  it('empty stdin exits 0 with no stdout', async () => {
    const sb = await sandbox();
    const res = await runHook('', sb, '');
    expect(res.status).toBe(0);
  });

  it('huge stdin (8 MB) is forwarded intact', async () => {
    const sb = await sandbox();
    const big = JSON.stringify({ hook_event_name: 'PostToolUse', x: 'y'.repeat(8_000_000) });
    const res = await runHook('', sb, big);
    expect(res.status).toBe(0);
    expect(sb.server?.requests[0]?.body.length).toBe(big.length);
  });

  it('a server that never answers: exits 0 within ~1.2 s', async () => {
    const sb = await sandbox('hang');
    const res = await runHook('', sb, { session_id: 's', hook_event_name: 'Stop' });
    expect(res.status).toBe(0);
    expect(res.elapsedMs).toBeLessThan(1200);
  });

  it('a server returning 500: exits 0, nothing printed', async () => {
    const sb = await sandbox('error500');
    const res = await runHook('', sb, { session_id: 's', hook_event_name: 'Stop' });
    expect(res.status).toBe(0);
    expect(sb.server?.requests).toHaveLength(1);
  });

  it('a refused connection: exits 0', async () => {
    const sb = await sandbox();
    writeHookJson(sb, { url: 'http://127.0.0.1:1' });
    const res = await runHook('', sb, { session_id: 's', hook_event_name: 'Stop' });
    expect(res.status).toBe(0);
  });

  it('OFFICE_DISABLED=1 posts nothing', async () => {
    const sb = await sandbox();
    const res = await runHook('', sb, { session_id: 's' }, { OFFICE_DISABLED: '1' });
    expect(res.status).toBe(0);
    expect(sb.server?.requests).toHaveLength(0);
  });

  it('receptionist runs post nothing', async () => {
    const sb = await sandbox();
    await runHook('', sb, { session_id: 's' }, { TAGCONN_RUN_KIND: 'receptionist' });
    expect(sb.server?.requests).toHaveLength(0);
  });

  it.each([
    ['missing file', undefined],
    ['invalid JSON', '{nope'],
    ['wrong version', JSON.stringify({ version: 2, url: 'http://127.0.0.1:1', token: 't' })],
    ['missing token', JSON.stringify({ version: 1, url: 'http://127.0.0.1:1' })],
    ['non-http url', JSON.stringify({ version: 1, url: 'file:///etc/passwd', token: 't' })],
  ])('config %s: silent no-op', async (_n, content) => {
    const sb = await sandbox();
    if (content === undefined) writeFileSync(sb.hookJson, '');
    else writeFileSync(sb.hookJson, content);
    if (content === undefined) {
      const res = await spawnHook('node', '{}', { PATH: process.env.PATH, TAGCONN_HOOK_CONFIG: join(sb.configDir, 'absent.json') });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('');
    } else {
      const res = await runHook('', sb, { session_id: 's' });
      expect(res.status).toBe(0);
    }
    expect(sb.server?.requests).toHaveLength(0);
  });

  it('TAGCONN_CONFIG_DIR selects <dir>/hook.json', async () => {
    const sb = await sandbox();
    const res = await spawnHook('node', JSON.stringify({ session_id: 's' }), {
      PATH: process.env.PATH,
      HOME: sb.home,
      TAGCONN_CONFIG_DIR: sb.configDir,
    });
    expect(res.status).toBe(0);
    expect(sb.server?.requests).toHaveLength(1);
  });

  it('debug flag writes to stderr only', async () => {
    const sb = await sandbox();
    writeHookJson(sb, { url: 'http://127.0.0.1:1' });
    const res = await runHook('', sb, { session_id: 's' }, { TAGCONN_HOOK_DEBUG: '1' });
    expect(res.stderr).toContain('tagconn-hook');
  });

  it('sends the import with the session id header (default on)', async () => {
    const sb = await sandbox();
    mkdirSync(join(sb.projectDir, '.tagconn'));
    writeFileSync(join(sb.projectDir, '.tagconn', 'office.json'), '{"kind":"tagconn.office-profile"}');
    await runHook('', sb, { session_id: 'abc_1', hook_event_name: 'SessionStart' });
    for (let i = 0; i < 100 && (sb.server?.requests.length ?? 0) < 2; i++) await new Promise((r) => setTimeout(r, 30));
    const imp = sb.server?.requests.find((r) => r.url === '/api/attribution/import');
    expect(imp?.headers['x-tagconn-session-id']).toBe('abc_1');
    expect(imp?.headers['x-office-token']).toBe(TEST_TOKEN);
  });

  it('a session id outside [A-Za-z0-9_-] skips the import', async () => {
    const sb = await sandbox();
    mkdirSync(join(sb.projectDir, '.tagconn'));
    writeFileSync(join(sb.projectDir, '.tagconn', 'office.json'), '{"kind":"tagconn.office-profile"}');
    await runHook('', sb, { session_id: 'bad id!', hook_event_name: 'SessionStart' });
    await new Promise((r) => setTimeout(r, 500));
    expect(sb.server?.requests.map((r) => r.url)).toEqual(['/api/hooks']);
  });
});

describe('node hook project root helpers (M12)', () => {
  it('findGit walks PATH, skipping empty, `.` and relative entries', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const root = fs.mkdtempSync(join(os.tmpdir(), 'tagconn-findgit-'));
    const planted = join(root, 'planted');
    const real = join(root, 'real');
    for (const d of [planted, real]) {
      mkdirSync(d);
      writeFileSync(join(d, 'git'), '#!/bin/sh\n', { mode: 0o755 });
    }
    expect(hook.findGit({ PATH: `:.:rel/bin:${real}` }, 'linux')).toBe(join(real, 'git'));
    expect(hook.findGit({ PATH: `:.:rel/bin` }, 'linux')).toBeUndefined();
    expect(hook.findGit({ PATH: planted + ':' + real }, 'linux')).toBe(join(planted, 'git'));
    expect(hook.findGit({}, 'linux')).toBeUndefined();
  });

  it('findGit on win32 only considers spawnable .exe/.com from PATHEXT (never .cmd)', () => {
    expect(hook.findGit({ PATH: 'C:\\nope', PATHEXT: '.CMD;.BAT' }, 'win32')).toBeUndefined();
  });

  it('gitEnv drops every GIT_* variable (case-insensitive) and keeps the rest', () => {
    const e = hook.gitEnv({ PATH: '/bin', GIT_DIR: 'x', GIT_WORK_TREE: 'x', GIT_CEILING_DIRECTORIES: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'k', GIT_CONFIG_GLOBAL: '/x', GIT_AUTHOR_NAME: 'a', GIT_COMMON_DIR: 'x', git_index_file: 'x', HOME: '/h' });
    expect(Object.keys(e).sort()).toEqual(['HOME', 'PATH']);
  });

  it('acceptToplevel: the project dir or an ancestor with a .git entry; never a root or an unrelated dir', () => {
    const has = () => true;
    expect(hook.acceptToplevel('/w/repo', '/w/repo/apps/web', '', 'linux', has)).toBe(true);
    expect(hook.acceptToplevel('/w/repo', '/w/repo', '', 'linux', has)).toBe(true);
    expect(hook.acceptToplevel('/w/repo', '/link', '/w/repo/real', 'linux', has)).toBe(true);
    expect(hook.acceptToplevel('/w/repo', '/w/repo-other', '', 'linux', has)).toBe(false);
    expect(hook.acceptToplevel('/home', '/w/repo', '', 'linux', has)).toBe(false);
    expect(hook.acceptToplevel('/', '/w/repo', '', 'linux', has)).toBe(false);
    expect(hook.acceptToplevel('/w', '/w/repo', '', 'linux', () => false)).toBe(false); // spoofed: no .git there
    expect(hook.acceptToplevel('C:/Repo', 'c:\\repo\\apps', '', 'win32', has)).toBe(true);
  });

  it('cacheDirSafe: a real 0700 dir only (not a symlink, not group/other accessible)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const base = fs.mkdtempSync(join(os.tmpdir(), 'tagconn-cachedir-'));
    const ok = join(base, 'ok');
    mkdirSync(ok, { mode: 0o700 });
    expect(hook.cacheDirSafe(ok)).toBe(true);
    const open = join(base, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    expect(hook.cacheDirSafe(open)).toBe(false);
    fs.symlinkSync(ok, join(base, 'link'));
    expect(hook.cacheDirSafe(join(base, 'link'))).toBe(false);
    expect(hook.cacheDirSafe(join(base, 'missing'))).toBe(false);
    writeFileSync(join(base, 'file'), 'x');
    expect(hook.cacheDirSafe(join(base, 'file'))).toBe(false);
  });

  it('readRootCache tolerates a missing, corrupt or foreign-dir cache', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'tagconn-rootcache-'));
    expect(hook.readRootCache(dir, '/w/repo')).toBeUndefined();
    mkdirSync(join(dir, 'root-cache'));
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const file = join(dir, 'root-cache', `${createHash('sha256').update('/w/repo').digest('hex').slice(0, 32)}.json`);
    writeFileSync(file, '{ nope', { mode: 0o600 });
    expect(hook.readRootCache(dir, '/w/repo')).toBeUndefined();
    writeFileSync(file, JSON.stringify({ dir: '/other', kind: 'git', root: '/w/repo' }), { mode: 0o600 });
    expect(hook.readRootCache(dir, '/w/repo')).toBeUndefined();
    writeFileSync(file, JSON.stringify({ dir: '/w/repo', kind: 'git', root: '/w/repo' }), { mode: 0o600 });
    expect(hook.readRootCache(dir, '/w/repo')).toEqual({ root: '/w/repo', kind: 'git' });
  });
});

describe('node hook pure helpers', () => {
  it('resolveConfigPaths: TAGCONN_HOOK_CONFIG wins, then TAGCONN_CONFIG_DIR, then OS default', () => {
    expect(hook.resolveConfigPaths({ TAGCONN_HOOK_CONFIG: '/home/u/b/h.json', TAGCONN_CONFIG_DIR: '/home/u/z' }, 'linux', '/home/u')).toEqual({
      hookJson: '/home/u/b/h.json',
      configDir: '/home/u/b',
    });
    expect(hook.resolveConfigPaths({ TAGCONN_CONFIG_DIR: '/home/u/z' }, 'linux', '/home/u').hookJson).toBe('/home/u/z/hook.json');
    expect(hook.resolveConfigPaths({}, 'linux', '/home/u').configDir).toBe('/home/u/.config/tagconn');
    expect(hook.resolveConfigPaths({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/u').configDir).toBe('/x/tagconn');
    // Exec-form hooks get no env: a hook.json next to the script wins over the OS default.
    const beside = (f: string) => f === '/opt/cfg/hook.json';
    expect(hook.resolveConfigPaths({}, 'linux', '/home/u', '/opt/cfg', beside).configDir).toBe('/opt/cfg');
    expect(hook.resolveConfigPaths({}, 'linux', '/home/u', '/elsewhere', beside).configDir).toBe('/home/u/.config/tagconn');
    expect(hook.resolveConfigPaths({ TAGCONN_CONFIG_DIR: '/home/u/z' }, 'linux', '/home/u', '/opt/cfg', beside).configDir).toBe('/home/u/z');
  });

  it('L2: env overrides outside home / OS config dirs are ignored', () => {
    const r = hook.resolveConfigPaths({ TAGCONN_CONFIG_DIR: '/repo/.tagconn-cfg', TAGCONN_HOOK_CONFIG: '/repo/h.json' }, 'linux', '/home/u');
    expect(r).toEqual({ hookJson: '/home/u/.config/tagconn/hook.json', configDir: '/home/u/.config/tagconn' });
    // '..' escapes are resolved before the check
    expect(hook.resolveConfigPaths({ TAGCONN_CONFIG_DIR: '/home/u/../evil' }, 'linux', '/home/u').configDir).toBe('/home/u/.config/tagconn');
  });

  it('L2: a repo-relative TAGCONN_CONFIG_DIR is ignored end to end', async () => {
    const sb = await sandbox();
    const rel = join(sb.projectDir, 'cfg');
    mkdirSync(rel);
    writeFileSync(join(rel, 'hook.json'), JSON.stringify({ version: 1, url: sb.server?.url, token: TEST_TOKEN }));
    const res = await spawnHook('node', JSON.stringify({ session_id: 's' }), {
      PATH: process.env.PATH,
      HOME: sb.home,
      USERPROFILE: sb.home,
      XDG_CONFIG_HOME: join(sb.home, 'nothing'),
      TAGCONN_CONFIG_DIR: rel,
      CLAUDE_PROJECT_DIR: sb.projectDir,
    });
    expect(res.status).toBe(0);
    expect(sb.server?.requests).toHaveLength(0);
  });

  it('childEnv drops NODE_OPTIONS and NODE_TLS_REJECT_UNAUTHORIZED', () => {
    const e = hook.childEnv({ NODE_OPTIONS: '--require x', NODE_TLS_REJECT_UNAUTHORIZED: '0', A: '1' });
    expect(e).toEqual({ A: '1' });
  });

  it('L1: token must be 16-128 lowercase hex; header values may not hold CR/LF/NUL', () => {
    expect(hook.isValidToken('0123456789abcdef')).toBe(true);
    expect(hook.isValidToken('0123456789abcde')).toBe(false);
    expect(hook.isValidToken('0123456789ABCDEF0123')).toBe(false);
    expect(hook.isValidToken('0123456789abcdef\r\nx-evil: 1')).toBe(false);
    expect(hook.isValidToken('a'.repeat(129))).toBe(false);
    for (const bad of ['a\r', 'a\n', 'a\0']) expect(hook.hasHeaderBreak(bad)).toBe(true);
    expect(hook.hasHeaderBreak('abc')).toBe(false);
  });

  it('L1: a hook.json token with CRLF is a no-op (nothing posted)', async () => {
    const sb = await sandbox();
    writeHookJson(sb, { token: `${TEST_TOKEN}\r\nx-evil: 1` });
    const res = await runHook('', sb, { session_id: 's', hook_event_name: 'Stop' });
    expect(res.status).toBe(0);
    expect(sb.server?.requests).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('L2: a group-writable hook.json is a no-op; 0600 works', async () => {
    const sb = await sandbox();
    chmodSync(sb.hookJson, 0o664);
    await runHook('', sb, { session_id: 's', hook_event_name: 'Stop' });
    expect(sb.server?.requests).toHaveLength(0);
    chmodSync(sb.hookJson, 0o600);
    await runHook('', sb, { session_id: 's', hook_event_name: 'Stop' });
    expect(sb.server?.requests).toHaveLength(1);
  });

  it('configFileTrusted: owner and mode rules', () => {
    expect(hook.configFileTrusted({ uid: 5, mode: 0o100600 }, 5)).toBe(true);
    expect(hook.configFileTrusted({ uid: 6, mode: 0o100600 }, 5)).toBe(false);
    expect(hook.configFileTrusted({ uid: 5, mode: 0o100620 }, 5)).toBe(false);
    expect(hook.configFileTrusted({ uid: 5, mode: 0o100602 }, 5)).toBe(false);
    expect(hook.configFileTrusted({ uid: 5, mode: 0o100644 }, 5)).toBe(true);
    expect(hook.configFileTrusted({ uid: 0, mode: 0o100666 }, undefined)).toBe(true);
  });

  it('L3: sameInode detects a swapped object (dev/ino mismatch)', () => {
    const a = { dev: 1, ino: 10 };
    expect(hook.sameInode(a, { dev: 1, ino: 10 })).toBe(true);
    expect(hook.sameInode(a, { dev: 1, ino: 11 })).toBe(false);
    expect(hook.sameInode(a, { dev: 2, ino: 10 })).toBe(false);
    expect(hook.sameInode(a, null)).toBe(false);
  });

  it('L4: win32 project outside %USERPROFILE% is refused (case-insensitive, canonical)', () => {
    const up = 'C:\\Users\\Me';
    expect(hook.winProjectOutsideUserProfile('c:\\users\\me\\code\\repo', up)).toBe(false);
    expect(hook.winProjectOutsideUserProfile('C:\\Users\\Me', up)).toBe(false);
    expect(hook.winProjectOutsideUserProfile('D:\\work\\repo', up)).toBe(true);
    expect(hook.winProjectOutsideUserProfile('C:\\Users\\Meagan\\repo', up)).toBe(true);
    expect(hook.winProjectOutsideUserProfile('C:\\Users\\Me\\..\\Other', up)).toBe(true);
    expect(hook.winProjectOutsideUserProfile('C:\\Users\\Me\\repo', '')).toBe(true);
  });

  it('L5: homeGuard refuses any home match and skips when none resolve', () => {
    expect(hook.homeGuard('/p', [], 'linux')).toEqual({ skip: true, isHome: false });
    expect(hook.homeGuard('/p', ['/h1', '/p'], 'linux')).toEqual({ skip: false, isHome: true });
    expect(hook.homeGuard('/p', ['/h1', '/h2'], 'linux')).toEqual({ skip: false, isHome: false });
  });

  it('L5: unresolvable HOME/USERPROFILE/homedir skips attribution (no README)', async () => {
    const sb = await sandbox();
    writeHookJson(sb, { attributionReadme: true });
    writeFileSync(join(sb.configDir, 'attribution-README.md'), 'hi');
    mkdirSync(join(sb.projectDir, '.git'));
    const res = await spawnHook('node', JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart' }), {
      PATH: process.env.PATH,
      HOME: '/nonexistent-home-xyz',
      USERPROFILE: '/nonexistent-home-xyz',
      TAGCONN_HOOK_CONFIG: sb.hookJson,
      XDG_CONFIG_HOME: sb.configDir,
      CLAUDE_PROJECT_DIR: sb.projectDir,
    });
    expect(res.status).toBe(0);
    await new Promise((r) => setTimeout(r, 600));
    expect(existsSync(join(sb.projectDir, '.tagconn'))).toBe(false);
  });

  it('resolveConfigPaths: win32 uses %APPDATA%\\tagconn and backslashes', () => {
    expect(hook.resolveConfigPaths({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toEqual({
      hookJson: 'C:\\Users\\me\\AppData\\Roaming\\tagconn\\hook.json',
      configDir: 'C:\\Users\\me\\AppData\\Roaming\\tagconn',
    });
    expect(hook.resolveConfigPaths({}, 'win32', 'C:\\Users\\me').configDir).toBe('C:\\Users\\me\\AppData\\Roaming\\tagconn');
    expect(hook.resolveConfigPaths({ TAGCONN_HOOK_CONFIG: 'C:\\Users\\me\\cfg\\hook.json' }, 'win32', 'C:\\Users\\me').configDir).toBe('C:\\Users\\me\\cfg');
  });

  it('samePath / isFsRoot honour win32 case-insensitivity, drive roots and trailing separators', () => {
    expect(hook.samePath('C:\\Users\\Me', 'c:\\users\\me\\', 'win32')).toBe(true);
    expect(hook.samePath('C:\\Users\\Me', 'C:\\Users\\Other', 'win32')).toBe(false);
    expect(hook.samePath('/home/Me', '/home/me', 'linux')).toBe(false);
    expect(hook.samePath('/home/me/', '/home/me', 'linux')).toBe(true);
    expect(hook.samePath('', '/x', 'linux')).toBe(false);
    expect(hook.isFsRoot('C:\\', 'win32')).toBe(true);
    expect(hook.isFsRoot('C:\\proj', 'win32')).toBe(false);
    expect(hook.isFsRoot('/', 'linux')).toBe(true);
    expect(hook.isFsRoot('/proj', 'linux')).toBe(false);
  });

  it('isRunIdHint accepts only lowercase UUID shape', () => {
    expect(hook.isRunIdHint('12345678-1234-1234-1234-123456789012')).toBe(true);
    expect(hook.isRunIdHint('12345678-1234-1234-1234-12345678901G')).toBe(false);
    expect(hook.isRunIdHint('ABCDEF12-1234-1234-1234-123456789012')).toBe(false);
    expect(hook.isRunIdHint(undefined)).toBe(false);
  });

  it('sanitizeSessionId and lastStringField', () => {
    expect(hook.sanitizeSessionId('ok-1_A')).toBe('ok-1_A');
    expect(hook.sanitizeSessionId('a/b')).toBe('');
    expect(hook.sanitizeSessionId('')).toBe('');
    expect(hook.lastStringField('{"a":"1","a" : "2"}', 'a')).toBe('2');
    expect(hook.lastStringField('{}', 'a')).toBe('');
  });

  it('isSessionStart: exact event name, small bodies only', () => {
    expect(hook.isSessionStart('{"hook_event_name":"SessionStart"}')).toBe(true);
    expect(hook.isSessionStart('{"hook_event_name":"Stop","x":"SessionStart"}')).toBe(false);
    const big = `{"hook_event_name":"SessionStart","pad":"${'x'.repeat(17000)}"}`;
    expect(hook.isSessionStart(big)).toBe(false);
  });
});

describe('node hook file', () => {
  it('a syntax check of the file itself passes (node --check)', () => {
    const r = spawnSync(process.execPath, ['--check', nodeHookScript], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});
