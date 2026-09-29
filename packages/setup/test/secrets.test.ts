import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseIcaclsPrincipals, SecretFileError, verifySecretFile, writeSecretFile, type ExecFn } from '../src/index.ts';
import { tempDir } from './support/sandbox.ts';

const WIN_ENV = { USERDOMAIN: 'DESKTOP-1', USERNAME: 'ilo' };

/** A fake icacls: records calls; `listing` decides what `icacls <file>` prints. */
function fakeIcacls(listing: (path: string) => string, opts: { grantStatus?: number } = {}) {
  const calls: string[][] = [];
  const exec: ExecFn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'icacls') return { status: 1, stdout: '', stderr: 'unexpected' };
    if (args.includes('/grant:r')) return { status: opts.grantStatus ?? 0, stdout: '', stderr: opts.grantStatus ? 'Access is denied.' : '' };
    return { status: 0, stdout: listing(args[0] as string), stderr: '' };
  };
  return { exec, calls };
}

const onlyUser = (path: string) => `${path} DESKTOP-1\\ilo:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;

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

describe('writeSecretFile (win32, mocked icacls)', () => {
  it('runs icacls /inheritance:r /grant:r "DOMAIN\\user:F" as an argv array, then verifies', () => {
    const dir = tempDir();
    const path = join(dir, 'hook.json');
    const { exec, calls } = fakeIcacls(onlyUser);
    writeSecretFile(path, '{}', { platform: 'win32', env: WIN_ENV, exec });
    expect(readFileSync(path, 'utf8')).toBe('{}');
    const grant = calls.find((c) => c.includes('/grant:r'));
    expect(grant?.slice(0, 1)).toEqual(['icacls']);
    expect(grant?.slice(2)).toEqual(['/inheritance:r', '/grant:r', 'DESKTOP-1\\ilo:F']);
    // grant happens on the temp file (before the secret is written), then a verification listing.
    expect(calls.some((c) => c.length === 2)).toBe(true);
    expect(readdirSync(dir)).toEqual(['hook.json']);
  });

  it('throws SecretFileError with a fix hint when icacls fails, and writes nothing', () => {
    const dir = tempDir();
    const path = join(dir, 'hook.json');
    const { exec } = fakeIcacls(onlyUser, { grantStatus: 5 });
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

  it('throws when verification finds another principal (e.g. inherited Users), and does not publish the file', () => {
    const dir = tempDir();
    const path = join(dir, 'hook.json');
    const { exec } = fakeIcacls(
      (p) => `${p} DESKTOP-1\\ilo:(F)\r\n    BUILTIN\\Users:(I)(RX)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`,
    );
    expect(() => writeSecretFile(path, 'secret', { platform: 'win32', env: WIN_ENV, exec })).toThrow(/BUILTIN\\Users/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a failed icacls read counts as a failed verification', () => {
    const exec: ExecFn = (_cmd, args) =>
      args.includes('/grant:r') ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '', error: new Error('spawn icacls ENOENT') };
    const dir = tempDir();
    expect(() => writeSecretFile(join(dir, 'f'), 'x', { platform: 'win32', env: WIN_ENV, exec })).toThrow(SecretFileError);
  });

  it('parseIcaclsPrincipals handles paths with spaces and the trailer', () => {
    const path = 'C:\\Users\\Ilo M\\AppData\\Roaming\\tagconn\\hook.json';
    const out = `${path} NT AUTHORITY\\SYSTEM:(I)(F)\r\n    BUILTIN\\Administrators:(I)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
    expect(parseIcaclsPrincipals(out, path)).toEqual(['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators']);
  });

  it('verifySecretFile accepts a bare-user principal', () => {
    const { exec } = fakeIcacls((p) => `${p} ilo:(F)\r\n`);
    expect(verifySecretFile('C:\\x\\f', { platform: 'win32', env: WIN_ENV, exec })).toEqual({ ok: true });
  });
});
