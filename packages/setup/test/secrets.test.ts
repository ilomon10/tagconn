import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWhoamiUser, SecretFileError, systemBin, verifySecretFile, writeSecretFile, type ExecFn } from '../src/index.ts';
import { tempDir } from './support/sandbox.ts';

const WIN_ENV = { USERDOMAIN: 'DESKTOP-1', USERNAME: 'ilo', SystemRoot: 'C:\\Windows' };
const SID = 'S-1-5-21-1-2-3-1001'; // = ME in the shared fixtures below
const ICACLS = 'C:\\Windows\\System32\\icacls.exe';
const WHOAMI = 'C:\\Windows\\System32\\whoami.exe';

// ---- shared ACL fixtures (identical in apps/runner/test/unit/win32Hardening.test.ts and packages/setup/test/winAclCore.test.ts)
const ME = 'S-1-5-21-1-2-3-1001';
const ace = (sid: string, rights: number, o: { type?: string; inherited?: boolean; inh?: number; prop?: number } = {}) => ({
  sid, rights, type: o.type ?? 'Allow', inherited: o.inherited ?? false, inheritanceFlags: o.inh ?? 0, propagationFlags: o.prop ?? 0,
});
const FULL = 2032127; // FileSystemRights.FullControl
const MODIFY = 1245631;
const READ_EXEC = 1179817;
const aclJson = (aces: unknown[], owner: string | null = ME) => JSON.stringify({ owner, user: ME, aces });
/** English and German Windows print different names, but the SIDs (all this code sees) are the same. */
const ENGLISH = aclJson([ace(ME, FULL), ace('S-1-5-18', FULL), ace('S-1-5-32-544', FULL), ace('S-1-5-32-545', READ_EXEC, { inherited: true, inh: 3 })]);
const GERMAN = ENGLISH;
const UNTRANSLATABLE = aclJson([ace(ME, FULL), ace('S-1-5-21-9-9-9-1234', MODIFY)]);
const AUTH_USERS_WRITE = aclJson([ace(ME, FULL), ace('S-1-5-11', MODIFY, { inh: 3 })]);
const DENY_ONLY_OTHERS = aclJson([ace(ME, FULL), ace('S-1-1-0', FULL, { type: 'Deny' }), ace('S-1-5-11', READ_EXEC)]);
const INHERITED_WRITE = aclJson([ace(ME, FULL), ace('S-1-5-32-545', MODIFY, { inherited: true, inh: 3 })]);
const INHERIT_ONLY_WRITE = aclJson([ace(ME, FULL), ace('S-1-5-11', MODIFY, { inherited: true, inh: 3, prop: 2 })]);
const OWNED_BY_OTHER = aclJson([ace(ME, FULL)], 'S-1-5-21-1-2-3-1002');
// ---- end shared ACL fixtures

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
/** A fake PowerShell + icacls + whoami: records calls (with env); `acl` decides the JSON `Get-Acl` prints for a path. */
function fakeWin(acl: (path: string) => string, opts: { grantStatus?: number; psStatus?: number; psError?: Error } = {}) {
  const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
  const exec: ExecFn = (cmd, args, o) => {
    calls.push({ cmd, args, env: o?.env });
    if (cmd === WHOAMI) return { status: 0, stdout: `"DESKTOP-1\\ilo","${SID}"\r\n`, stderr: '' };
    if (cmd === PS) return { status: opts.psStatus ?? 0, stdout: acl(o?.env?.TAGCONN_ACL_PATH ?? ''), stderr: '', error: opts.psError };
    if (cmd !== ICACLS) return { status: 1, stdout: '', stderr: 'unexpected' };
    return { status: opts.grantStatus ?? 0, stdout: '', stderr: opts.grantStatus ? 'Access is denied.' : '' };
  };
  return { exec, calls };
}

const onlyUser = () => aclJson([ace(ME, FULL)]);

describe('writeSecretFile (POSIX)', () => {
  it('writes with mode 600 atomically and leaves no temp file', () => {
    const dir = tempDir();
    const path = join(dir, 'sub', 'secret');
    writeSecretFile(path, 'hunter2\n', { platform: 'linux' });
    expect(readFileSync(path, 'utf8')).toBe('hunter2\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'sub'))).toEqual(['secret']);
  });

  it('replaces an existing world-readable file with a 600 one', () => {
    const dir = tempDir();
    const path = join(dir, 'secret');
    writeFileSync(path, 'old', { mode: 0o644 });
    writeSecretFile(path, 'new', { platform: 'linux' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('verifySecretFile reports a wrong mode', () => {
    const path = join(tempDir(), 'f');
    writeFileSync(path, 'x', { mode: 0o644 });
    expect(verifySecretFile(path, { platform: 'linux' })).toEqual({ ok: false, kind: 'mode', mode: '644' });
  });
});

describe('writeSecretFile (win32, mocked PowerShell + icacls)', () => {
  it('grants by SID with the absolute System32 icacls as an argv array, then verifies via PowerShell with the path in the env', () => {
    const dir = tempDir();
    const path = join(dir, 'hook.json');
    const { exec, calls } = fakeWin(onlyUser);
    writeSecretFile(path, '{}', { platform: 'win32', env: WIN_ENV, exec });
    expect(readFileSync(path, 'utf8')).toBe('{}');
    const grant = calls.find((c) => c.args.includes('/grant:r'));
    expect(grant?.cmd).toBe(ICACLS);
    expect(grant?.args.slice(1)).toEqual(['/inheritance:r', '/grant:r', `*${SID}:F`]);
    expect(calls.some((c) => c.cmd === WHOAMI && c.args.join(' ') === '/user /fo csv /nh')).toBe(true);
    const ps = calls.find((c) => c.cmd === PS);
    expect(ps?.env).toMatchObject({ TAGCONN_ACL_PATH: expect.stringContaining('hook.json') });
    expect(ps?.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text']);
    expect(ps?.args.join(' ')).not.toContain('hook.json');
    expect(readdirSync(dir)).toEqual(['hook.json']);
  });

  it('throws SecretFileError with a fix hint when icacls fails, and writes nothing', () => {
    const dir = tempDir();
    const path = join(dir, 'hook.json');
    const { exec } = fakeWin(onlyUser, { grantStatus: 5 });
    let err: unknown;
    try {
      writeSecretFile(path, 'secret', { platform: 'win32', env: WIN_ENV, exec });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SecretFileError);
    expect((err as SecretFileError).hint).toContain('icacls');
    expect((err as SecretFileError).hint).toContain('/inheritance:r');
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['inherited Users', INHERITED_WRITE, /S-1-5-32-545/],
    ['Authenticated Users', AUTH_USERS_WRITE, /S-1-5-11/],
    ['an untranslatable SID', UNTRANSLATABLE, /S-1-5-21-9-9-9-1234/],
    ['a read-only other', DENY_ONLY_OTHERS, /S-1-5-11/],
    ['SYSTEM and Administrators (not tolerated for secrets)', ENGLISH, /S-1-5-18/],
  ])('refuses when another principal is listed: %s, and does not publish the file', (_n, json, re) => {
    const dir = tempDir();
    const { exec } = fakeWin(() => json);
    expect(() => writeSecretFile(join(dir, 'hook.json'), 'secret', { platform: 'win32', env: WIN_ENV, exec })).toThrow(re);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ignores DENY entries, but needs at least one allow entry', () => {
    const denyPlus = fakeWin(() => aclJson([ace(ME, FULL), ace('S-1-1-0', FULL, { type: 'Deny' })]));
    expect(verifySecretFile('C:\\x\\f', { platform: 'win32', env: WIN_ENV, exec: denyPlus.exec })).toEqual({ ok: true });
    const denyOnly = fakeWin(() => aclJson([ace('S-1-1-0', FULL, { type: 'Deny' })]));
    expect(verifySecretFile('C:\\x\\f', { platform: 'win32', env: WIN_ENV, exec: denyOnly.exec })).toMatchObject({ ok: false, kind: 'acl' });
  });

  it('fails closed with a hint on a PowerShell failure, an error, or unparseable output', () => {
    for (const w of [fakeWin(onlyUser, { psStatus: 1 }), fakeWin(onlyUser, { psError: new Error('ETIMEDOUT') }), fakeWin(() => 'not json'), fakeWin(() => '')]) {
      const r = verifySecretFile('C:\\x\\f', { platform: 'win32', env: WIN_ENV, exec: w.exec });
      expect(r).toMatchObject({ ok: false, kind: 'acl' });
      expect((r as { hint: string }).hint).toContain('icacls');
    }
    const dir = tempDir();
    const { exec } = fakeWin(onlyUser, { psStatus: 1 });
    expect(() => writeSecretFile(join(dir, 'f'), 'x', { platform: 'win32', env: WIN_ENV, exec })).toThrow(SecretFileError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fails closed with a hint when whoami cannot give a SID (nothing is granted or written)', () => {
    const dir = tempDir();
    const calls: string[] = [];
    const exec: ExecFn = (cmd) => {
      calls.push(cmd);
      return { status: 0, stdout: 'garbage', stderr: '' };
    };
    let err: unknown;
    try {
      writeSecretFile(join(dir, 'f'), 'x', { platform: 'win32', env: WIN_ENV, exec });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SecretFileError);
    expect((err as SecretFileError).message).toMatch(/SID/);
    expect((err as SecretFileError).hint).toContain('whoami');
    expect(calls).not.toContain(ICACLS);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('decodes UTF-16-looking (NUL-interleaved) whoami output', () => {
    const wide = `"DESKTOP-1\\ilo","${SID}"`.split('').join('\u0000');
    expect(parseWhoamiUser(wide)?.sid).toBe(SID);
  });

  it('systemBin uses %SystemRoot% and falls back to C:\\Windows', () => {
    expect(systemBin({ SystemRoot: 'D:\\Win\\' }, 'cmd')).toBe('D:\\Win\\System32\\cmd.exe');
    expect(systemBin({}, 'where')).toBe('C:\\Windows\\System32\\where.exe');
  });
});
