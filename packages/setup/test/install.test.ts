import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultResources, HOOK_EVENTS, install, summarizeHooks, uninstall, type InstallOptions } from '../src/index.ts';
import { quietContext, tempDir } from './support/sandbox.ts';

/** A sandbox with stub resources (so the test does not depend on the real hook/templates) and no repo .env. */
function sandbox() {
  const root = tempDir();
  const res = join(root, 'res');
  mkdirSync(join(res, 'roles'), { recursive: true });
  mkdirSync(join(res, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(res, 'office-hook.mjs'), '// stub node hook\n');
  writeFileSync(join(res, 'office-hook.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(res, 'README.md.tmpl'), '# .tagconn\n');
  writeFileSync(join(res, 'roles', 'dev.md'), '---\nname: dev\ndescription: "A dev: builds"\n---\nBody\n');
  writeFileSync(join(res, 'skills', 'demo', 'SKILL.md'), '# demo\n');
  const claudeDir = join(root, '.claude');
  const configDir = join(root, 'cfg', 'tagconn');
  const { ctx, logs } = quietContext({
    resources: {
      ...defaultResources(),
      hookMjsPath: join(res, 'office-hook.mjs'),
      hookShPath: join(res, 'office-hook.sh'),
      rolesDir: join(res, 'roles'),
      skillsDir: join(res, 'skills'),
      attributionTemplate: join(res, 'README.md.tmpl'),
    },
  });
  const opts: InstallOptions = {
    claudeDir,
    configDir,
    url: 'http://127.0.0.1:4317',
    urlExplicit: false,
    noAgents: false,
    noSkills: false,
    envFile: null,
    allowDirs: [],
    configDirExplicit: true,
    hook: 'node',
    nodePath: '/opt/node/bin/node',
    attribution: false,
    isDefaultConfigDir: false,
  };
  return { root, claudeDir, configDir, ctx, logs, opts };
}

describe('install / uninstall (node hook, no repo .env)', () => {
  it('writes hook.json (secret), the hook script, settings entries in exec form; returns changed + backup', async () => {
    const { claudeDir, configDir, ctx, opts } = sandbox();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }));

    const result = await install(opts, ctx);

    const hookJson = join(configDir, 'hook.json');
    const cfg = JSON.parse(readFileSync(hookJson, 'utf8'));
    expect(cfg).toMatchObject({ version: 1, url: 'http://127.0.0.1:4317', attributionReadme: false, attributionImport: true });
    expect(cfg.token).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(hookJson).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(configDir, 'office-hook.mjs'), 'utf8')).toContain('stub node hook');
    // the sh-only files are not written for the node kind
    expect(existsSync(join(configDir, 'curl.conf'))).toBe(false);
    expect(existsSync(join(configDir, 'office-hook.sh'))).toBe(false);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.model).toBe('opus');
    expect(settings.hooks.SessionStart[0].hooks[0]).toEqual({
      type: 'command',
      command: '/opt/node/bin/node',
      args: [join(configDir, 'office-hook.mjs')],
    });
    expect(summarizeHooks(settings)).toMatchObject({ kind: 'node', events: HOOK_EVENTS.length });

    expect(result.backup).toMatch(/settings\.json\.tagconn-backup-/);
    expect(result.changed).toEqual(expect.arrayContaining([hookJson, join(configDir, 'office-hook.mjs'), join(claudeDir, 'settings.json'), join(configDir, 'runner.json')]));
    expect(existsSync(join(claudeDir, 'agents', 'dev.md'))).toBe(true);
    expect(existsSync(join(claudeDir, 'skills', 'demo', '.tagconn-managed'))).toBe(true);
  });

  it('keeps the same token on reinstall and reflects the attribution answer in hook.json', async () => {
    const { configDir, ctx, opts } = sandbox();
    await install(opts, ctx);
    const first = JSON.parse(readFileSync(join(configDir, 'hook.json'), 'utf8'));
    const again = quietContext({ resources: ctx.resources });
    await install({ ...opts, attribution: async () => true }, again.ctx);
    const second = JSON.parse(readFileSync(join(configDir, 'hook.json'), 'utf8'));
    expect(second.token).toBe(first.token);
    expect(second.attributionReadme).toBe(true);
    expect(existsSync(join(configDir, 'attribution-README.md'))).toBe(true);
  });

  it('honours an explicit token and rejects a malformed one', async () => {
    const { configDir, ctx, opts } = sandbox();
    await install({ ...opts, token: 'ab'.repeat(24) }, ctx);
    expect(JSON.parse(readFileSync(join(configDir, 'hook.json'), 'utf8')).token).toBe('ab'.repeat(24));
    await expect(install({ ...opts, token: 'NOT-HEX' }, quietContext({ resources: ctx.resources }).ctx)).rejects.toThrow(/hook token is invalid/);
  });

  it('uninstall removes only ours and the secret, leaving foreign hooks and unmanaged agents', async () => {
    const { claudeDir, configDir, ctx, opts } = sandbox();
    mkdirSync(join(claudeDir, 'agents'), { recursive: true });
    writeFileSync(join(claudeDir, 'agents', 'mine.md'), '# not managed\n');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/other' }] }] } }));
    await install(opts, ctx);

    const un = quietContext({ resources: ctx.resources });
    const result = await uninstall({ claudeDir, configDir, noAgents: false, noSkills: false }, un.ctx);
    expect(result.backup).toBeTruthy();
    expect(existsSync(join(configDir, 'hook.json'))).toBe(false);
    expect(existsSync(join(claudeDir, 'agents', 'dev.md'))).toBe(false);
    expect(existsSync(join(claudeDir, 'agents', 'mine.md'))).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: '/x/other' }] }] });
  });

  it('refuses an unparsable settings.json before writing anything at all', async () => {
    const { claudeDir, configDir, ctx, opts } = sandbox();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), '{ nope');
    await expect(install(opts, ctx)).rejects.toThrow(/Failed to parse/);
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe('{ nope');
    expect(existsSync(configDir)).toBe(false);
  });

  it('a dry run writes nothing', async () => {
    const { root, ctx, opts } = sandbox();
    ctx.dryRun = true;
    await install(opts, ctx);
    expect(existsSync(join(root, '.claude'))).toBe(false);
    expect(existsSync(join(root, 'cfg'))).toBe(false);
  });

  it('the sh kind still writes curl.conf and the shell hook, and registers the command string', async () => {
    const { claudeDir, configDir, ctx, opts } = sandbox();
    await install({ ...opts, hook: 'sh', envFile: join(configDir, '..', 'repo.env') }, ctx);
    expect(statSync(join(configDir, 'curl.conf')).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    const entry = settings.hooks.Stop[0].hooks[0];
    expect(entry.args).toBeUndefined();
    expect(entry.command).toContain('office-hook.sh');
  });
});
