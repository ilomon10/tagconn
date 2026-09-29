import { describe, expect, it } from 'vitest';
// Pins the duplicated types (src/types.ts) against the real contract. Reached by relative path: only this
// test may load @tagconn/shared (zod); the library itself must stay dependency-free.
import { FIX_ACTIONS, InstallResultSchema, SETUP_CHECK_IDS, SetupCheckSchema } from '../../shared/src/desktop.ts';
import { defaultCheckDeps, install, runSetupChecks, type FixAction, type SetupCheckId } from '../src/index.ts';
import { quietContext, tempDir } from './support/sandbox.ts';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

describe('contract with packages/shared/src/desktop.ts', () => {
  it('SetupCheckId / FixAction unions match the shared lists (compile-time + runtime)', () => {
    const ids: SetupCheckId[] = [...SETUP_CHECK_IDS];
    const actions: FixAction[] = [...FIX_ACTIONS];
    expect(ids.length).toBe(11);
    expect(actions.length).toBe(8);
    // the reverse direction: every literal we know is accepted by the shared list
    const ours: SetupCheckId[] = ['claude_cli', 'claude_login', 'git_bash', 'server_port', 'config_dir', 'data_dir', 'claude_settings', 'hooks', 'docker', 'webview2', 'runner_platform'];
    expect([...ours].sort()).toEqual([...SETUP_CHECK_IDS].sort());
  });

  it('every check parses with SetupCheckSchema', async () => {
    const root = tempDir();
    const checks = await runSetupChecks(
      { claudeDir: join(root, '.claude'), configDir: join(root, 'cfg'), dataDir: join(root, 'data'), port: 4317 },
      { ...defaultCheckDeps(), platform: 'win32', homedir: root, env: {}, exec: () => ({ status: 1, stdout: '', stderr: '' }) },
    );
    for (const c of checks) expect(() => SetupCheckSchema.parse(c)).not.toThrow();
  });

  it('install() returns an InstallResult', async () => {
    const root = tempDir();
    const hook = join(root, 'office-hook.mjs');
    writeFileSync(hook, '//');
    mkdirSync(join(root, 'r'));
    const { ctx } = quietContext({ resources: { hookMjsPath: hook, hookShPath: hook, rolesDir: join(root, 'r'), skillsDir: join(root, 'r'), attributionTemplate: hook, envExample: hook } });
    const res = await install(
      { claudeDir: join(root, '.claude'), configDir: join(root, 'cfg'), url: 'http://127.0.0.1:4317', urlExplicit: false, noAgents: true, noSkills: true, envFile: null, allowDirs: [], configDirExplicit: true, hook: 'node', attribution: false, isDefaultConfigDir: false },
      ctx,
    );
    expect(() => InstallResultSchema.parse(res)).not.toThrow();
  });
});
