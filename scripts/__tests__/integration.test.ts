// Integration tests: spawn `node scripts/install.ts` / `node scripts/doctor.ts`
// as real child processes, always against a sandboxed HOME (under the OS
// tmpdir) with explicit --claude-dir/--config-dir/--repo-env-file, per
// CLAUDE.md's sandboxing recipe. Never touches the real ~/.config/tagconn or
// ~/.claude - see support/real-paths-guard.ts and support/global-guard.ts for
// the trip-wire that would fail the whole run if this were violated.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isExplicitFalse, parseFrontmatter } from '../install.ts';
import { createSandbox, listRecursive, repoRoot, runDoctor, runInstall, type Sandbox } from './support/sandbox.ts';

const rolesDir = join(repoRoot, 'packages', 'agent-templates', 'roles');
// Mirrors installAgents' office-enabled/office-sync filtering, so this test
// doesn't hardcode a count that drifts when a role template is added/disabled.
const roleCount = readdirSync(rolesDir)
  .filter((f) => f.endsWith('.md'))
  .filter((f) => {
    const { frontmatter } = parseFrontmatter(readFileSync(join(rolesDir, f), 'utf8'));
    return !isExplicitFalse(frontmatter['office-enabled']) && !isExplicitFalse(frontmatter['office-sync']);
  }).length;

describe('install -> reinstall -> doctor -> uninstall', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  it('installs hooks, agents, skills, curl.conf and the hook script', () => {
    const res = runInstall(sandbox);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('generated new OFFICE_HOOK_TOKEN');
    expect(res.stdout).toMatch(/hooks: 11 added, 0 already present/);

    const settings = JSON.parse(readFileSync(join(sandbox.claudeDir, 'settings.json'), 'utf8'));
    expect(Object.keys(settings.hooks)).toHaveLength(11);

    const agentsDir = join(sandbox.claudeDir, 'agents');
    const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
    expect(agentFiles.length).toBe(roleCount);
    for (const f of agentFiles) {
      expect(readFileSync(join(agentsDir, f), 'utf8')).toContain('<!-- managed-by: tagconn -->');
    }

    const skillsDir = join(sandbox.claudeDir, 'skills');
    const skillDirs = readdirSync(skillsDir);
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const d of skillDirs) {
      expect(existsSync(join(skillsDir, d, '.tagconn-managed'))).toBe(true);
    }

    expect(existsSync(sandbox.envFile)).toBe(true);
    expect(readFileSync(sandbox.envFile, 'utf8')).toMatch(/OFFICE_HOOK_TOKEN=[0-9a-f]{16,}/);
  });

  it('file modes: curl.conf is 0600 and the config dir is 0700', () => {
    runInstall(sandbox);
    const confMode = statSync(join(sandbox.configDir, 'curl.conf')).mode & 0o777;
    expect(confMode.toString(8)).toBe('600');
    const dirMode = statSync(sandbox.configDir).mode & 0o777;
    expect(dirMode.toString(8)).toBe('700');
  });

  it('reinstalling is idempotent: keeps the token, adds no duplicate hooks', () => {
    runInstall(sandbox);
    const res = runInstall(sandbox);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('kept existing OFFICE_HOOK_TOKEN');
    expect(res.stdout).toMatch(/hooks: 0 added, 11 already present/);

    const settings = JSON.parse(readFileSync(join(sandbox.claudeDir, 'settings.json'), 'utf8'));
    for (const groups of Object.values(settings.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      const ourCount = groups.flatMap((g) => g.hooks).filter((h) => h.command.includes('office-hook.sh')).length;
      expect(ourCount).toBe(1);
    }
  });

  it('doctor exits 0 after a successful install', () => {
    runInstall(sandbox);
    const res = runDoctor(sandbox);
    expect(res.stdout, res.stdout).toContain('All hard checks passed.');
    expect(res.status).toBe(0);
  });

  it('uninstall removes our hooks, agents, skills and curl.conf, but leaves the hook script and .env', () => {
    runInstall(sandbox);
    const res = runInstall(sandbox, ['--uninstall']);
    expect(res.status, res.stderr).toBe(0);

    const settings = JSON.parse(readFileSync(join(sandbox.claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks).toBeUndefined();

    const agentsDir = join(sandbox.claudeDir, 'agents');
    const remainingAgents = existsSync(agentsDir) ? readdirSync(agentsDir) : [];
    expect(remainingAgents).toEqual([]);

    const skillsDir = join(sandbox.claudeDir, 'skills');
    const remainingSkills = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
    expect(remainingSkills).toEqual([]);

    expect(existsSync(join(sandbox.configDir, 'curl.conf'))).toBe(false);
    // Documented behavior: the hook script and repo .env survive uninstall.
    expect(existsSync(join(sandbox.configDir, 'office-hook.sh'))).toBe(true);
    expect(existsSync(sandbox.envFile)).toBe(true);
  });
});

describe('doctor: H2 (SC5) risky user-level settings.json permissions', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    runInstall(sandbox);
  });

  function patchSettings(patch: Record<string, unknown>): void {
    const path = join(sandbox.claudeDir, 'settings.json');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...settings, ...patch }, null, 2));
  }

  it('warns about Bash/WebFetch/mcp__ allow rules that quests would inherit via --setting-sources=user', () => {
    patchSettings({ permissions: { allow: ['Bash(rm -rf /)', 'WebFetch', 'mcp__github__search', 'Read'] } });
    const res = runDoctor(sandbox);
    expect(res.status).toBe(0); // a warning, never a hard failure
    expect(res.stdout).toMatch(/permissions\.allow has 3 Bash\/WebFetch\/mcp__ rule\(s\)/);
    expect(res.stdout).toContain('Bash(rm -rf /)');
    expect(res.stdout).toContain('mcp__github__search');
  });

  it('warns about permissions.additionalDirectories', () => {
    patchSettings({ permissions: { additionalDirectories: ['/etc'] } });
    const res = runDoctor(sandbox);
    expect(res.stdout).toMatch(/permissions\.additionalDirectories is set: \/etc/);
  });

  it('warns about a non-"plan" permissions.defaultMode', () => {
    patchSettings({ permissions: { defaultMode: 'bypassPermissions' } });
    const res = runDoctor(sandbox);
    expect(res.stdout).toMatch(/permissions\.defaultMode is "bypassPermissions"/);
  });

  it('does not warn about defaultMode "plan", and does not flag a plain "Read" allow rule', () => {
    patchSettings({ permissions: { defaultMode: 'plan', allow: ['Read', 'Grep'] } });
    const res = runDoctor(sandbox);
    expect(res.stdout).not.toMatch(/permissions\.allow has/);
    expect(res.stdout).not.toMatch(/permissions\.defaultMode is/);
  });

  it('does not warn at all when settings.json has no permissions section (the plain installer output)', () => {
    const res = runDoctor(sandbox);
    expect(res.stdout).not.toMatch(/permissions\.allow has/);
    expect(res.stdout).not.toMatch(/permissions\.additionalDirectories/);
    expect(res.stdout).not.toMatch(/permissions\.defaultMode is/);
  });
});

describe('unmanaged agent/skill files are left untouched', () => {
  let sandbox: Sandbox;
  const unmanagedAgentContent = '---\nname: developer\n---\nMy own hand-written developer agent.\n';

  beforeEach(() => {
    sandbox = createSandbox();
    mkdirSync(join(sandbox.claudeDir, 'agents'), { recursive: true });
    writeFileSync(join(sandbox.claudeDir, 'agents', 'developer.md'), unmanagedAgentContent, 'utf8');
    mkdirSync(join(sandbox.claudeDir, 'skills', 'office-kickoff'), { recursive: true });
    writeFileSync(join(sandbox.claudeDir, 'skills', 'office-kickoff', 'SKILL.md'), 'My own skill.\n', 'utf8');
  });

  it('install skips the unmanaged agent/skill instead of overwriting them', () => {
    const res = runInstall(sandbox);
    expect(res.status, res.stderr).toBe(0);
    // console.warn goes to stderr.
    expect(res.stderr).toMatch(/WARNING: skipping .*developer\.md.*not managed by tagconn/);
    expect(res.stderr).toMatch(/WARNING: skipping .*office-kickoff.*not managed by tagconn/);
    expect(res.stdout).toContain('1 skipped (unmanaged file exists)');
    expect(res.stdout).toContain('1 skipped (unmanaged dir exists)');
    expect(readFileSync(join(sandbox.claudeDir, 'agents', 'developer.md'), 'utf8')).toBe(unmanagedAgentContent);
    expect(readFileSync(join(sandbox.claudeDir, 'skills', 'office-kickoff', 'SKILL.md'), 'utf8')).toBe('My own skill.\n');
    expect(existsSync(join(sandbox.claudeDir, 'skills', 'office-kickoff', '.tagconn-managed'))).toBe(false);
  });

  it('uninstall leaves the unmanaged agent/skill in place', () => {
    runInstall(sandbox);
    runInstall(sandbox, ['--uninstall']);
    expect(readFileSync(join(sandbox.claudeDir, 'agents', 'developer.md'), 'utf8')).toBe(unmanagedAgentContent);
    expect(readFileSync(join(sandbox.claudeDir, 'skills', 'office-kickoff', 'SKILL.md'), 'utf8')).toBe('My own skill.\n');
  });
});

describe('--dry-run', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  it('writes nothing to disk', () => {
    const before = listRecursive(sandbox.home);
    const res = runInstall(sandbox, ['--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('[dry-run]');
    const after = listRecursive(sandbox.home);
    expect(after).toEqual(before);
  });
});
