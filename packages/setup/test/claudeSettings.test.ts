import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultFs,
  HOOK_EVENTS,
  hookKindOf,
  installClaudeHooks,
  installHooks,
  isOurEntry,
  SettingsParseError,
  SettingsRollbackError,
  summarizeHooks,
  uninstallClaudeHooks,
  uninstallHooks,
  type FsOps,
  type HookSpec,
  type SettingsJson,
} from '../src/index.ts';
import { quietContext, tempDir } from './support/sandbox.ts';

const NODE_SPEC: HookSpec = { kind: 'node', nodePath: '/opt/node/bin/node', scriptPath: '/cfg/tagconn/office-hook.mjs' };
const SH_SPEC: HookSpec = { kind: 'sh', scriptPath: '/home/u/.config/tagconn/office-hook.sh', confPath: '/home/u/.config/tagconn/curl.conf', isDefaultConfigDir: true };
const N = HOOK_EVENTS.length;

const foreign = { type: 'command', command: '/usr/local/bin/other-hook' };

describe('node-kind hook merge', () => {
  it('registers exec form: command = node, args = [script]', () => {
    const s: SettingsJson = {};
    expect(installHooks(s, NODE_SPEC)).toEqual({ added: N, skipped: 0 });
    const entry = s.hooks?.SessionStart?.[0]?.hooks[0];
    expect(entry).toEqual({ type: 'command', command: '/opt/node/bin/node', args: ['/cfg/tagconn/office-hook.mjs'] });
    // matcher events get a "*" group like the sh kind
    expect(s.hooks?.PreToolUse?.[0]?.matcher).toBe('*');
  });

  it('is idempotent', () => {
    const s: SettingsJson = {};
    installHooks(s, NODE_SPEC);
    const before = JSON.stringify(s);
    expect(installHooks(s, NODE_SPEC)).toEqual({ added: 0, skipped: N });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('replaces a node entry whose node path changed instead of adding a second one', () => {
    const s: SettingsJson = {};
    installHooks(s, NODE_SPEC);
    installHooks(s, { ...NODE_SPEC, nodePath: 'C:\\Program Files\\nodejs\\node.exe' } as HookSpec);
    const hooks = s.hooks?.Stop?.flatMap((g) => g.hooks) ?? [];
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.command).toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('switching kinds replaces ours and keeps foreign hooks', () => {
    const s: SettingsJson = { hooks: { PreToolUse: [{ matcher: '*', hooks: [foreign] }] } };
    installHooks(s, SH_SPEC);
    installHooks(s, NODE_SPEC);
    const pre = s.hooks?.PreToolUse?.flatMap((g) => g.hooks) ?? [];
    expect(pre.filter(isOurEntry)).toHaveLength(1);
    expect(hookKindOf(pre.find(isOurEntry))).toBe('node');
    expect(pre).toContainEqual(foreign);
    expect(summarizeHooks(s)).toMatchObject({ kind: 'node', events: N });
  });

  it('uninstall removes only our entries of either kind and cleans empty groups', () => {
    const s: SettingsJson = { model: 'x', hooks: { Stop: [{ hooks: [foreign] }] } };
    installHooks(s, NODE_SPEC);
    expect(uninstallHooks(s)).toEqual({ removed: N });
    expect(s.hooks).toEqual({ Stop: [{ hooks: [foreign] }] });
    expect(s.model).toBe('x');
    expect(uninstallHooks(s)).toEqual({ removed: 0 });

    const t: SettingsJson = {};
    installHooks(t, SH_SPEC);
    expect(uninstallHooks(t)).toEqual({ removed: N });
    expect(t.hooks).toBeUndefined();
  });

  it('never treats a foreign node hook as ours', () => {
    expect(isOurEntry({ command: 'node', args: ['/x/other.mjs'] })).toBe(false);
    expect(isOurEntry({ command: '/usr/bin/node', args: ['C:\\cfg\\tagconn\\office-hook.mjs'] })).toBe(true);
  });
});

describe('settings.json write safety', () => {
  function setup(content?: string) {
    const dir = tempDir();
    const path = join(dir, 'settings.json');
    if (content !== undefined) writeFileSync(path, content);
    return { dir, path, ...quietContext() };
  }

  it('backs up first and writes atomically', () => {
    const { dir, path, ctx } = setup(JSON.stringify({ model: 'opus' }));
    const res = installClaudeHooks(ctx, path, NODE_SPEC);
    expect(res.added).toBe(N);
    expect(res.backup).toMatch(/settings\.json\.tagconn-backup-/);
    expect(JSON.parse(readFileSync(res.backup as string, 'utf8'))).toEqual({ model: 'opus' });
    expect(JSON.parse(readFileSync(path, 'utf8')).model).toBe('opus');
    expect(readdirSync(dir).filter((f) => f.includes('tmp'))).toEqual([]);
    expect(ctx.changed).toContain(path);
  });

  it('creates settings.json when missing (no backup)', () => {
    const { path, ctx } = setup();
    const res = installClaudeHooks(ctx, path, NODE_SPEC);
    expect(res.backup).toBeNull();
    expect(summarizeHooks(JSON.parse(readFileSync(path, 'utf8'))).events).toBe(N);
  });

  it('never overwrites an unparsable settings.json and reports the position', () => {
    const bad = '{\n  "model": "opus",\n  "hooks": {oops}\n}\n';
    const { path, ctx } = setup(bad);
    let err: unknown;
    try {
      installClaudeHooks(ctx, path, NODE_SPEC);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SettingsParseError);
    const perr = err as SettingsParseError;
    expect(perr.path).toBe(path);
    expect(perr.line).toBe(3);
    expect(perr.column).toBeGreaterThan(1);
    expect(perr.message).toContain('line 3');
    expect(readFileSync(path, 'utf8')).toBe(bad);
    // uninstall is just as careful
    expect(() => uninstallClaudeHooks(ctx, path)).toThrow(SettingsParseError);
    expect(readFileSync(path, 'utf8')).toBe(bad);
  });

  it('rejects a settings.json whose top level is not an object, without touching it', () => {
    const { path, ctx } = setup('[1,2]');
    expect(() => installClaudeHooks(ctx, path, NODE_SPEC)).toThrow(SettingsParseError);
    expect(readFileSync(path, 'utf8')).toBe('[1,2]');
  });

  it('rolls back from the backup when the final rename fails', () => {
    const original = JSON.stringify({ model: 'opus', permissions: { allow: ['Read'] } }, null, 2) + '\n';
    const { dir, path, ctx } = setup(original);
    let renames = 0;
    const fs: FsOps = {
      ...defaultFs,
      renameSync: (from, to) => {
        // the FIRST rename is the atomic publish of the new settings: simulate a crash there
        if (renames++ === 0) throw new Error('EBUSY: resource busy or locked');
        renameSync(from, to);
      },
    };
    let err: unknown;
    try {
      installClaudeHooks(ctx, path, NODE_SPEC, fs);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SettingsRollbackError);
    expect((err as SettingsRollbackError).restored).toBe(true);
    expect((err as SettingsRollbackError).message).toContain('EBUSY');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(dir).filter((f) => f.includes('tmp') || f.includes('restore'))).toEqual([]);
  });

  it('rolls back when a write lands corrupt (post-write verification fails)', () => {
    const original = JSON.stringify({ model: 'opus' }) + '\n';
    const { path, ctx } = setup(original);
    const fs: FsOps = {
      ...defaultFs,
      // the temp file is written truncated, as after a full disk
      writeFileSync: (p, data, opts) => defaultFs.writeFileSync(p, data.slice(0, 10), opts),
    };
    expect(() => installClaudeHooks(ctx, path, NODE_SPEC, fs)).toThrow(SettingsRollbackError);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('removes a settings.json it just created when the write fails', () => {
    const { path, ctx } = setup();
    const fs: FsOps = {
      ...defaultFs,
      renameSync: () => {
        throw new Error('EACCES');
      },
    };
    expect(() => installClaudeHooks(ctx, path, NODE_SPEC, fs)).toThrow(SettingsRollbackError);
    expect(existsSync(path)).toBe(false);
  });

  it('reports a failed restore with the backup path for a manual fix', () => {
    const { path, ctx } = setup(JSON.stringify({ a: 1 }));
    const fs: FsOps = {
      ...defaultFs,
      renameSync: () => {
        throw new Error('locked');
      },
    };
    let err: unknown;
    try {
      installClaudeHooks(ctx, path, NODE_SPEC, fs);
    } catch (e) {
      err = e;
    }
    // both the publish and the restore rename fail
    expect((err as SettingsRollbackError).restored).toBe(false);
    expect((err as SettingsRollbackError).message).toContain('.tagconn-backup-');
  });

  it('dry run writes nothing', () => {
    const { path, ctx, logs } = setup(JSON.stringify({ a: 1 }));
    ctx.dryRun = true;
    installClaudeHooks(ctx, path, NODE_SPEC);
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify({ a: 1 }));
    expect(readdirSync(join(path, '..'))).toEqual(['settings.json']);
    expect(logs.out.join('\n')).toContain('[dry-run] would back up');
  });

  it('install then uninstall restores the original content', () => {
    const original = { model: 'opus', hooks: { Stop: [{ hooks: [foreign] }] } };
    const { path, ctx } = setup(JSON.stringify(original));
    installClaudeHooks(ctx, path, NODE_SPEC);
    installClaudeHooks(ctx, path, NODE_SPEC); // idempotent
    const res = uninstallClaudeHooks(ctx, path);
    expect(res.removed).toBe(N);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(original);
  });
});
