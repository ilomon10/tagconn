import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkBwrap,
  checkCurlConf,
  checkHookScript,
  checkSystemdScope,
  createDoctorEnv,
  install,
  readRunnerToken,
  writeSecretFile,
  type DoctorReporter,
  type ExecFn,
} from '../src/index.ts';
import { quietContext, tempDir } from './support/sandbox.ts';

function recorder() {
  const lines: string[] = [];
  const rep: DoctorReporter = {
    ok: (l) => lines.push(`ok ${l}`),
    fail: (l) => lines.push(`fail ${l}`),
    warn: (l) => lines.push(`warn ${l}`),
    na: (l) => lines.push(`na ${l}`),
    line: (l) => lines.push(l),
  };
  return { lines, rep };
}

const WIN_ENV = { USERDOMAIN: 'PC', USERNAME: 'ilo' };
const whoami = { status: 0, stdout: '"PC\\ilo","S-1-5-21-1-2-3-1001"\r\n', stderr: '' };
const psAcl = (aces: Array<{ sid: string; rights: number }>): ExecFn => (cmd) =>
  /whoami/.test(cmd)
    ? whoami
    : /powershell/i.test(cmd)
      ? { status: 0, stdout: JSON.stringify({ owner: 'S-1-5-21-1-2-3-1001', user: 'S-1-5-21-1-2-3-1001', aces: aces.map((a) => ({ ...a, type: 'Allow', inherited: false, inheritanceFlags: 0, propagationFlags: 0 })) }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
const aclOk = psAcl([{ sid: 'S-1-5-21-1-2-3-1001', rights: 2032127 }]);
const aclOpen = psAcl([{ sid: 'S-1-5-21-1-2-3-1001', rights: 2032127 }, { sid: 'S-1-5-32-545', rights: 1179817 }]);

describe('doctor on win32', () => {
  it('reports systemd and bwrap as not applicable, never as warnings or failures', () => {
    const { lines, rep } = recorder();
    const d = createDoctorEnv(rep, { platform: 'win32' });
    checkSystemdScope(d);
    checkBwrap(d);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith('na '))).toBe(true);
  });

  it('checks secret files with the ACL, not the file mode (no false 600 failure)', () => {
    const dir = tempDir();
    const conf = join(dir, 'curl.conf');
    writeFileSync(conf, 'header = "x-office-token: abc"\nurl = "http://x/api/hooks"\n', { mode: 0o644 });
    const good = recorder();
    checkCurlConf(createDoctorEnv(good.rep, { platform: 'win32', env: WIN_ENV, exec: aclOk }), dir);
    expect(good.lines[0]).toMatch(/^ok curl\.conf present, user-only ACL/);
    const bad = recorder();
    checkCurlConf(createDoctorEnv(bad.rep, { platform: 'win32', env: WIN_ENV, exec: aclOpen }), dir);
    expect(bad.lines[0]).toMatch(/^fail curl\.conf is accessible by other users/);
  });

  it('does not require an executable bit on the hook script', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'office-hook.sh'), '#!/bin/sh\n', { mode: 0o644 });
    const { lines, rep } = recorder();
    checkHookScript(createDoctorEnv(rep, { platform: 'win32' }), dir);
    expect(lines[0]).toMatch(/^ok hook script installed/);
  });

  it('node hook: checks the script and hook.json', async () => {
    const root = tempDir();
    const hook = join(root, 'src.mjs');
    writeFileSync(hook, '//');
    mkdirSync(join(root, 'r'));
    const { ctx } = quietContext({ resources: { hookMjsPath: hook, hookShPath: hook, rolesDir: join(root, 'r'), skillsDir: join(root, 'r'), attributionTemplate: hook, envExample: hook } });
    const configDir = join(root, 'cfg');
    await install(
      { claudeDir: join(root, '.claude'), configDir, url: 'http://127.0.0.1:4317', urlExplicit: false, noAgents: true, noSkills: true, envFile: null, allowDirs: [], configDirExplicit: true, hook: 'node', attribution: false, isDefaultConfigDir: false },
      ctx,
    );
    const { lines, rep } = recorder();
    checkHookScript(createDoctorEnv(rep), configDir, 'node');
    expect(lines).toEqual([expect.stringMatching(/^ok node hook script installed/), expect.stringMatching(/^ok hook\.json present, mode 600/)]);
  });
});

describe('readRunnerToken', () => {
  const token = 'ab'.repeat(32);
  it('POSIX: requires mode 600 (message unchanged)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ token }), { mode: 0o644 });
    expect(() => readRunnerToken(dir)).toThrow(/has mode 644, expected 600\. Run: chmod 600/);
  });

  it('win32: uses the ACL check', () => {
    const dir = tempDir();
    writeSecretFile(join(dir, 'runner.json'), JSON.stringify({ token }), { platform: 'win32', env: WIN_ENV, exec: aclOk });
    expect(readRunnerToken(dir, { platform: 'win32', env: WIN_ENV, exec: aclOk })).toBe(token);
    expect(() => readRunnerToken(dir, { platform: 'win32', env: WIN_ENV, exec: aclOpen })).toThrow(/accessible by other users/);
  });
});
