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

describe('nodeWritableReason (win32, mocked icacls)', () => {
  const SID = 'S-1-5-21-1-2-3-1001';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  function winCtx(acls: Record<string, string[]>) {
    const exec: ExecFn = (cmd, args) => {
      if (/whoami/i.test(cmd)) return { status: 0, stdout: `"PC\\u","${SID}"`, stderr: '' };
      const path = args[0] as string;
      const aces = acls[path] ?? ['NT AUTHORITY\\SYSTEM:(F)'];
      return { status: 0, stdout: `${path} ${aces[0]}\n${aces.slice(1).map((a) => `        ${a}`).join('\n')}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`, stderr: '' };
    };
    return quietContext({ platform: 'win32', exec, env: { SystemRoot: 'C:\\Windows' } }).ctx;
  }
  const safe = ['NT AUTHORITY\\SYSTEM:(I)(F)', 'BUILTIN\\Administrators:(I)(F)', 'BUILTIN\\Users:(I)(RX)', 'NT AUTHORITY\\Authenticated Users:(I)(RX)'];

  it('a Program Files style ACL (read-only for Users) is fine, inherit-only and DENY entries are ignored', () => {
    const acls = { [node]: safe, 'C:\\Program Files\\nodejs': safe, 'C:\\': ['NT AUTHORITY\\Authenticated Users:(OI)(CI)(IO)(M)', 'NT AUTHORITY\\Authenticated Users:(AD)', 'Everyone:(DENY)(F)', ...safe] };
    expect(nodeWritableReason(winCtx(acls), node)).toBeNull();
  });

  it.each([
    ['C:\\Program Files\\nodejs', 'BUILTIN\\Users:(I)(OI)(CI)(M)', /nodejs is writable by BUILTIN\\Users/],
    ['C:\\Program Files\\nodejs', 'NT AUTHORITY\\Authenticated Users:(OI)(CI)(WD,AD)', /Authenticated Users/],
    ['C:\\Program Files', 'Everyone:(F)', /Everyone/],
    ['C:\\', 'BUILTIN\\Users:(OI)(CI)(M)', /BUILTIN\\Users/],
    [node, '*S-1-5-21-9-9-9-1234:(F)', /S-1-5-21-9-9-9-1234/],
  ])('%s: %s is unsafe', (path, ace, re) => {
    const acls = { [node]: safe, 'C:\\Program Files\\nodejs': safe, 'C:\\Program Files': safe, 'C:\\': safe, [path]: [ace, ...safe] };
    expect(nodeWritableReason(winCtx(acls), node)).toMatch(re);
  });

  it('fails closed when icacls or whoami fails', () => {
    const noIcacls: ExecFn = (cmd) => (/whoami/i.test(cmd) ? { status: 0, stdout: `"PC\\u","${SID}"`, stderr: '' } : { status: 1, stdout: '', stderr: 'nope' });
    expect(nodeWritableReason(quietContext({ platform: 'win32', exec: noIcacls }).ctx, node)).toMatch(/could not be read/);
    const noWhoami: ExecFn = () => ({ status: 1, stdout: '', stderr: '' });
    expect(nodeWritableReason(quietContext({ platform: 'win32', exec: noWhoami }).ctx, node)).toMatch(/could not be determined/);
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
