import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultNodeDir, ensureCurlConf, install, installClaudeHooks, nodeWritableReason, stabilizeNodePath, transientNodeReason, type ExecFn, type InstallOptions } from '../src/index.ts';
import { quietContext, tempDir } from './support/sandbox.ts';

/** A "stable" tree under the sandbox: temp roots are overridden so the sandbox itself does not count as temporary. */
function tree() {
  const root = tempDir();
  const bin = join(root, 'opt', 'node', 'bin');
  mkdirSync(bin, { recursive: true });
  for (const d of [root, join(root, 'opt'), join(root, 'opt', 'node'), bin]) chmodSync(d, 0o755);
  const node = join(bin, 'node');
  writeFileSync(node, '#!/bin/sh\necho v22.0.0\n', { mode: 0o755 });
  return { root, node, opts: { tempRoots: ['/nonexistent-tmp'], nodeDir: join(root, 'stable', 'node') } };
}

describe('transientNodeReason', () => {
  it('a node in a stable, user-only tree is fine', () => {
    const { node, opts } = tree();
    expect(transientNodeReason(quietContext().ctx, node, opts)).toBeNull();
    expect(nodeWritableReason(quietContext().ctx, node, opts)).toBeNull();
  });

  it('flags temp roots, AppImage mounts, fnm multishells', () => {
    const { ctx } = quietContext();
    expect(transientNodeReason(ctx, '/tmp/x/node', { tempRoots: ['/tmp'] })).toMatch(/temporary/);
    expect(transientNodeReason(ctx, '/tmp/.mount_abc123/usr/bin/node', { tempRoots: [] })).toMatch(/AppImage/);
    expect(transientNodeReason(ctx, '/home/u/.local/state/fnm_multishells/123_456/bin/node', { tempRoots: [] })).toMatch(/fnm/);
    const win = quietContext({ platform: 'win32' }).ctx;
    expect(transientNodeReason(win, 'C:\\Users\\u\\AppData\\Local\\Temp\\n\\node.exe', { tempRoots: ['C:\\Users\\u\\AppData\\Local\\Temp'] })).toMatch(/temporary/);
    expect(transientNodeReason(win, 'C:\\Users\\u\\AppData\\Local\\fnm_multishells\\1\\node.exe', { tempRoots: [] })).toMatch(/fnm/);
  });

  it('flags a group/world-writable ancestor, but tolerates a sticky one', () => {
    const { root, node, opts } = tree();
    const { ctx } = quietContext();
    chmodSync(join(root, 'opt'), 0o775);
    expect(nodeWritableReason(ctx, node, opts)).toMatch(/writable by other users/);
    chmodSync(join(root, 'opt'), 0o1777);
    expect(nodeWritableReason(ctx, node, opts)).toBeNull();
  });

  it('flags a component owned by another user, including a sticky world-writable dir', () => {
    const { root, node, opts } = tree();
    const { ctx } = quietContext();
    expect(nodeWritableReason(ctx, node, { ...opts, uid: 4242424 })).toMatch(/owned by another user/);
    chmodSync(join(root, 'opt'), 0o1777);
    expect(nodeWritableReason(ctx, node, { ...opts, uid: 4242424 })).toMatch(/owned by another user/);
  });

  it('flags a group-writable binary itself', () => {
    const { node, opts } = tree();
    chmodSync(node, 0o775);
    expect(nodeWritableReason(quietContext().ctx, node, opts)).toMatch(new RegExp(`${node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is writable`));
  });

  it('follows a symlink to the real location', () => {
    const { root, node } = tree();
    const link = join(root, 'link-node');
    symlinkSync(node, link);
    expect(transientNodeReason(quietContext().ctx, link, { tempRoots: [root] })).toMatch(/temporary/);
  });
});

describe('nodeWritableReason (win32, mocked PowerShell Get-Acl)', () => {
  const ME = 'S-1-5-21-1-2-3-1001';
  const SYSTEM = 'S-1-5-18';
  const ADMINS = 'S-1-5-32-544';
  const TI = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
  const USERS = 'S-1-5-32-545';
  const AUTH = 'S-1-5-11';
  const FULL = 2032127;
  const MODIFY = 1245631;
  const WRITE_DATA = 0x2;
  const READ_EXEC = 1179817;
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  type A = { sid: string; rights: number; type?: string; inherited?: boolean; prop?: number };
  const json = (aces: A[]) =>
    JSON.stringify({ owner: SYSTEM, user: ME, aces: aces.map((a) => ({ sid: a.sid, rights: a.rights, type: a.type ?? 'Allow', inherited: a.inherited ?? false, inheritanceFlags: 3, propagationFlags: a.prop ?? 0 })) });
  function winCtx(acls: Record<string, A[]>, opts: { psStatus?: number; stdout?: string } = {}) {
    const envs: Array<Record<string, string> | undefined> = [];
    const exec: ExecFn = (cmd, args, o) => {
      envs.push(o?.env);
      if (!/powershell\.exe$/i.test(cmd)) return { status: 1, stdout: '', stderr: 'unexpected' };
      const path = o?.env?.TAGCONN_ACL_PATH as string;
      return { status: opts.psStatus ?? 0, stdout: opts.stdout ?? json(acls[path] ?? [{ sid: SYSTEM, rights: FULL }]), stderr: '' };
    };
    return { ctx: quietContext({ platform: 'win32', exec, env: { SystemRoot: 'C:\\Windows' } }).ctx, envs };
  }
  // A German Windows prints different names, but the SIDs are the same: this ACL is the same on any locale.
  const safe: A[] = [
    { sid: SYSTEM, rights: FULL, inherited: true },
    { sid: ADMINS, rights: FULL, inherited: true },
    { sid: TI, rights: FULL, inherited: true },
    { sid: USERS, rights: READ_EXEC, inherited: true },
    { sid: AUTH, rights: READ_EXEC, inherited: true },
  ];

  it('a Program Files style ACL (read-only for Users) is fine, inherit-only and DENY entries are ignored; the path travels in the env', () => {
    const acls = {
      [node]: safe,
      'C:\\Program Files\\nodejs': safe,
      'C:\\': [{ sid: AUTH, rights: MODIFY, prop: 2 }, { sid: AUTH, rights: WRITE_DATA }, { sid: 'S-1-1-0', rights: FULL, type: 'Deny' }, ...safe],
    };
    const { ctx, envs } = winCtx(acls);
    expect(nodeWritableReason(ctx, node)).toBeNull();
    expect(envs.map((e) => e?.TAGCONN_ACL_PATH)).toEqual([node, 'C:\\Program Files\\nodejs', 'C:\\Program Files', 'C:\\']);
  });

  it.each([
    ['C:\\Program Files\\nodejs', { sid: USERS, rights: MODIFY, inherited: true }, /nodejs is writable by S-1-5-32-545/],
    ['C:\\Program Files\\nodejs', { sid: AUTH, rights: WRITE_DATA }, /S-1-5-11/],
    ['C:\\Program Files', { sid: 'S-1-1-0', rights: FULL }, /S-1-1-0/],
    ['C:\\', { sid: USERS, rights: MODIFY }, /S-1-5-32-545/],
    [node, { sid: 'S-1-5-21-9-9-9-1234', rights: FULL }, /S-1-5-21-9-9-9-1234/],
  ])('%s: %j is unsafe', (path, ace, re) => {
    const acls = { [node]: safe, 'C:\\Program Files\\nodejs': safe, 'C:\\Program Files': safe, 'C:\\': safe, [path]: [ace, ...safe] };
    expect(nodeWritableReason(winCtx(acls).ctx, node)).toMatch(re);
  });

  it('a plain write right only matters on the binary and its folder, not further up', () => {
    const acls = { [node]: safe, 'C:\\Program Files\\nodejs': safe, 'C:\\Program Files': [{ sid: USERS, rights: WRITE_DATA }, ...safe], 'C:\\': safe };
    expect(nodeWritableReason(winCtx(acls).ctx, node)).toBeNull();
  });

  it('trusts the current user, SYSTEM, Administrators and TrustedInstaller by SID', () => {
    const acls = { [node]: [{ sid: ME, rights: FULL }, { sid: SYSTEM, rights: FULL }, { sid: ADMINS, rights: FULL }, { sid: TI, rights: FULL }] };
    expect(nodeWritableReason(winCtx(acls).ctx, node)).toBeNull();
  });

  it('fails closed when PowerShell fails or prints something unparseable', () => {
    expect(nodeWritableReason(winCtx({}, { psStatus: 1 }).ctx, node)).toMatch(/could not be read/);
    expect(nodeWritableReason(winCtx({}, { stdout: 'oops' }).ctx, node)).toMatch(/could not be read/);
    const noPs: ExecFn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') });
    expect(nodeWritableReason(quietContext({ platform: 'win32', exec: noPs }).ctx, node)).toMatch(/could not be read/);
  });
});

describe('stabilizeNodePath', () => {
  it('leaves a stable node and a missing node untouched', () => {
    const { node, opts } = tree();
    const { ctx } = quietContext();
    expect(stabilizeNodePath(ctx, node, opts)).toBe(node);
    expect(stabilizeNodePath(ctx, '/opt/none/node', opts)).toBe('/opt/none/node');
  });

  it('copies a transient node to the stable dir (executable, 700 dir), idempotently', () => {
    const { root, node, opts } = tree();
    const exec: ExecFn = (cmd) => ({ status: 0, stdout: readFileSync(cmd, 'utf8').includes('v22') ? 'v22.0.0\n' : 'v?', stderr: '' });
    const { ctx, logs } = quietContext({ exec });
    const dest = stabilizeNodePath(ctx, node, { ...opts, tempRoots: [root] });
    expect(dest).toBe(join(opts.nodeDir, 'node'));
    expect(statSync(dest).mode & 0o777).toBe(0o755);
    expect(statSync(opts.nodeDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(node, 'utf8'));
    expect(ctx.changed).toContain(dest);

    const mtime = statSync(dest).mtimeMs;
    ctx.changed.length = 0;
    expect(stabilizeNodePath(ctx, node, { ...opts, tempRoots: [root] })).toBe(dest);
    expect(statSync(dest).mtimeMs).toBe(mtime);
    expect(ctx.changed).toEqual([]);
    expect(logs.out.join('\n')).toContain('up to date');

    // a different size (new version) is re-copied
    writeFileSync(node, '#!/bin/sh\necho v22.1.0 with more bytes\n', { mode: 0o755 });
    stabilizeNodePath(ctx, node, { ...opts, tempRoots: [root] });
    expect(readFileSync(dest, 'utf8')).toContain('more bytes');
  });

  it('re-copies when the size matches but --version differs', () => {
    const { root, node, opts } = tree();
    const dest = join(opts.nodeDir, 'node');
    mkdirSync(opts.nodeDir, { recursive: true });
    copyFileSync(node, dest);
    const exec: ExecFn = (cmd) => ({ status: 0, stdout: cmd === dest ? 'v21.0.0' : 'v22.0.0', stderr: '' });
    const { ctx } = quietContext({ exec });
    writeFileSync(dest, readFileSync(node, 'utf8').replace('v22', 'v21')); // same length, different bytes
    stabilizeNodePath(ctx, node, { ...opts, tempRoots: [root] });
    expect(readFileSync(dest, 'utf8')).toContain('v22');
  });

  it('refuses a shared-writable node instead of copying it', () => {
    const { root, node, opts } = tree();
    chmodSync(join(root, 'opt', 'node'), 0o777);
    const { ctx } = quietContext();
    expect(() => stabilizeNodePath(ctx, node, { ...opts, tempRoots: [root] })).toThrow(/Refusing.*writable by other users.*bundled node/);
    expect(existsSync(opts.nodeDir)).toBe(false);
    expect(() => stabilizeNodePath(quietContext({ dryRun: true }).ctx, node, opts)).toThrow(/Refusing/);
  });

  it('forces an existing stable dir to 0700 and copies from the opened file', () => {
    const { root, node, opts } = tree();
    mkdirSync(opts.nodeDir, { recursive: true, mode: 0o755 });
    chmodSync(opts.nodeDir, 0o755);
    const { ctx } = quietContext({ exec: () => ({ status: 0, stdout: 'v22.0.0', stderr: '' }) });
    const dest = stabilizeNodePath(ctx, node, { ...opts, tempRoots: [root] });
    expect(statSync(opts.nodeDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(node, 'utf8'));
  });

  it('dry run copies nothing', () => {
    const { root, node, opts } = tree();
    const { ctx } = quietContext({ dryRun: true });
    const dest = stabilizeNodePath(ctx, node, { ...opts, tempRoots: [root] });
    expect(existsSync(dest)).toBe(false);
  });

  it('defaultNodeDir: ~/.local/share/tagconn/node style on POSIX, %LOCALAPPDATA%\\tagconn\\node on win32', () => {
    expect(defaultNodeDir(quietContext({ env: { XDG_DATA_HOME: '/x/share' } }).ctx)).toBe('/x/share/tagconn/node');
    expect(defaultNodeDir(quietContext({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } }).ctx)).toBe('C:\\Users\\u\\AppData\\Local\\tagconn\\node');
  });
});

describe('install() registers the stable copy', () => {
  it('a transient node is copied and the copy is what settings.json runs', async () => {
    const root = tempDir();
    const node = join(root, 'tmpnode', 'node');
    mkdirSync(join(root, 'tmpnode'));
    writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 });
    const hook = join(root, 'office-hook.mjs');
    writeFileSync(hook, '// stub\n');
    const { ctx } = quietContext({ resources: { ...quietContext().ctx.resources, hookMjsPath: hook } });
    const opts: InstallOptions = {
      claudeDir: join(root, '.claude'), configDir: join(root, 'cfg', 'tagconn'), url: 'http://127.0.0.1:4317', urlExplicit: false,
      noAgents: true, noSkills: true, envFile: null, allowDirs: [], configDirExplicit: true, hook: 'node', nodePath: node,
      attribution: false, isDefaultConfigDir: false, nodeStable: { tempRoots: [join(root, 'tmpnode')] },
    };
    await install(opts, ctx);
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
    // sandboxed config dir: the copy lives inside it, not in the real data dir
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(join(root, 'cfg', 'tagconn', 'node', 'node'));
  });
});

describe('URL validation inside the library (L11)', () => {
  const bad = ['http://x/\nurl = "file:///etc/passwd"', 'http://a b', 'ftp://host', 'http://x/"', "http://x/'", 'not a url'];
  it.each(bad)('ensureCurlConf refuses %j', (url) => {
    const { ctx } = quietContext();
    expect(() => ensureCurlConf(ctx, join(tempDir(), 'c'), 'a'.repeat(48), url)).toThrow(/server URL/);
  });

  it('install() refuses before writing anything', async () => {
    const root = tempDir();
    const { ctx } = quietContext();
    const opts: InstallOptions = {
      claudeDir: join(root, '.claude'), configDir: join(root, 'cfg'), url: 'http://x/\nheader = "evil"', urlExplicit: true,
      noAgents: true, noSkills: true, envFile: null, allowDirs: [], configDirExplicit: true, hook: 'sh', attribution: false, isDefaultConfigDir: false,
    };
    await expect(install(opts, ctx)).rejects.toThrow(/server URL/);
    expect(existsSync(join(root, 'cfg'))).toBe(false);
  });
});

describe('settings.json rewrite keeps symlink and mode (L10)', () => {
  it('writes through a symlink and preserves the 0640 mode', () => {
    const root = tempDir();
    const real = join(root, 'dotfiles', 'settings.json');
    mkdirSync(join(root, 'dotfiles'));
    writeFileSync(real, '{"model":"opus"}', { mode: 0o640 });
    chmodSync(real, 0o640);
    mkdirSync(join(root, '.claude'));
    const link = join(root, '.claude', 'settings.json');
    symlinkSync(real, link);
    const { ctx } = quietContext();
    installClaudeHooks(ctx, link, { kind: 'node', nodePath: '/n', scriptPath: '/c/office-hook.mjs' });
    expect(statSync(link, { throwIfNoEntry: false })).toBeDefined();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).hooks).toBeDefined();
    expect(statSync(real).mode & 0o777).toBe(0o640);
  });
});
