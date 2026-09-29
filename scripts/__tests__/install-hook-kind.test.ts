// `node scripts/install.ts --hook node|sh` end to end, sandboxed (never the real ~/.claude or ~/.config/tagconn).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, runDoctor, runInstall, type Sandbox } from './support/sandbox.ts';

describe('installer: --hook', () => {
  let sandbox: Sandbox;
  beforeEach(() => {
    sandbox = createSandbox();
  });

  it('--hook node registers the exec form with --node-path and writes hook.json (0600)', () => {
    const res = runInstall(sandbox, ['--hook', 'node', '--node-path', '/opt/node/bin/node', '--attribution', 'no']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/hooks: 11 added, 0 already present/);
    const settings = JSON.parse(readFileSync(join(sandbox.claudeDir, 'settings.json'), 'utf8'));
    const entry = settings.hooks.SessionStart[0].hooks[0];
    expect(entry).toEqual({ type: 'command', command: '/opt/node/bin/node', args: [join(sandbox.configDir, 'office-hook.mjs')] });
    const hookJson = join(sandbox.configDir, 'hook.json');
    expect(statSync(hookJson).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(hookJson, 'utf8'))).toMatchObject({ version: 1, url: 'http://127.0.0.1:4317', attributionReadme: false });
    expect(existsSync(join(sandbox.configDir, 'office-hook.mjs'))).toBe(true);
  });

  it('defaults --node-path to the running node, and is idempotent', () => {
    expect(runInstall(sandbox, ['--hook', 'node', '--attribution', 'no']).status).toBe(0);
    const again = runInstall(sandbox, ['--hook', 'node', '--attribution', 'no']);
    expect(again.stdout).toMatch(/hooks: 0 added, 11 already present/);
    const settings = JSON.parse(readFileSync(join(sandbox.claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(process.execPath);
  });

  it('switching sh -> node replaces our entries; --uninstall removes the node hook and hook.json', () => {
    expect(runInstall(sandbox, ['--attribution', 'no']).status).toBe(0);
    expect(runInstall(sandbox, ['--hook', 'node', '--attribution', 'no']).stdout).toMatch(/hooks: 11 added/);
    const settings = JSON.parse(readFileSync(join(sandbox.claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.Stop).toHaveLength(1);
    const un = runInstall(sandbox, ['--uninstall']);
    expect(un.status, un.stderr).toBe(0);
    expect(un.stdout).toMatch(/removed 11 tagconn hook entries/);
    expect(existsSync(join(sandbox.configDir, 'hook.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(sandbox.claudeDir, 'settings.json'), 'utf8')).hooks).toBeUndefined();
  });

  it('rejects an unknown --hook value with the help text', () => {
    const res = runInstall(sandbox, ['--hook', 'bash']);
    expect(res.stderr).toMatch(/--hook must be "sh" or "node"/);
    expect(res.stdout).toContain('tagconn installer');
  });

  it('doctor understands a node-hook install', () => {
    runInstall(sandbox, ['--hook', 'node', '--attribution', 'no']);
    const res = runDoctor(sandbox);
    expect(res.stdout).toContain('node hook script installed');
    expect(res.stdout).toMatch(/hook\.json present, mode 600/);
    expect(res.stdout).toContain('settings.json has tagconn hooks for all 11 events');
    expect(res.stdout).not.toContain('curl.conf');
  });
});
