// Node-hook-only tests for packages/hook/office-hook.mjs: robustness guarantees
// (always exit 0, never stdout, hard 1 s budget) and the pure path/parse helpers
// (win32 semantics are unit-tested through path.win32, no Windows needed).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHookSandbox,
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
    expect(imp?.headers['x-office-token']).toBe('testtoken');
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

describe('node hook pure helpers', () => {
  it('resolveConfigPaths: TAGCONN_HOOK_CONFIG wins, then TAGCONN_CONFIG_DIR, then OS default', () => {
    expect(hook.resolveConfigPaths({ TAGCONN_HOOK_CONFIG: '/a/b/h.json', TAGCONN_CONFIG_DIR: '/z' }, 'linux', '/home/u')).toEqual({
      hookJson: '/a/b/h.json',
      configDir: '/a/b',
    });
    expect(hook.resolveConfigPaths({ TAGCONN_CONFIG_DIR: '/z' }, 'linux', '/home/u').hookJson).toBe('/z/hook.json');
    expect(hook.resolveConfigPaths({}, 'linux', '/home/u').configDir).toBe('/home/u/.config/tagconn');
    expect(hook.resolveConfigPaths({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/u').configDir).toBe('/x/tagconn');
    // Exec-form hooks get no env: a hook.json next to the script wins over the OS default.
    const beside = (f: string) => f === '/opt/cfg/hook.json';
    expect(hook.resolveConfigPaths({}, 'linux', '/home/u', '/opt/cfg', beside).configDir).toBe('/opt/cfg');
    expect(hook.resolveConfigPaths({}, 'linux', '/home/u', '/elsewhere', beside).configDir).toBe('/home/u/.config/tagconn');
    expect(hook.resolveConfigPaths({ TAGCONN_CONFIG_DIR: '/z' }, 'linux', '/home/u', '/opt/cfg', beside).configDir).toBe('/z');
  });

  it('resolveConfigPaths: win32 uses %APPDATA%\\tagconn and backslashes', () => {
    expect(hook.resolveConfigPaths({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toEqual({
      hookJson: 'C:\\Users\\me\\AppData\\Roaming\\tagconn\\hook.json',
      configDir: 'C:\\Users\\me\\AppData\\Roaming\\tagconn',
    });
    expect(hook.resolveConfigPaths({}, 'win32', 'C:\\Users\\me').configDir).toBe('C:\\Users\\me\\AppData\\Roaming\\tagconn');
    expect(hook.resolveConfigPaths({ TAGCONN_HOOK_CONFIG: 'D:\\cfg\\hook.json' }, 'win32', 'C:\\Users\\me').configDir).toBe('D:\\cfg');
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
