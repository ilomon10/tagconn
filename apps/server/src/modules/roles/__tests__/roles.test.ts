import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Role } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { isSafeAgentsDir, MANAGED_MARKER, renderAgentFile, syncRolesToDir } from '../roles.sync.js';
import { buildTestApp, makeTempDir } from '../../../../test/helpers.js';

const DEVELOPER_ROLE: Role = {
  name: 'developer',
  title: 'Developer',
  description: 'd',
  model: 'inherit',
  tools: null,
  prompt: 'p',
  zone: 'desks',
  color: '#4f8cff',
  sprite: 0,
  enabled: true,
  syncToClaude: true,
  builtin: true,
};

describe('roles', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function setup() {
    const agentsDir = join(makeTempDir(), 'agents');
    mkdirSync(agentsDir);
    app = await buildTestApp({ settings: { paths: { agentsDir } } });
    return { app, agentsDir };
  }

  it('seeds the default roles from the templates package', async () => {
    const { app } = await setup();
    const roles = (await app.inject({ url: '/api/roles' })).json<Role[]>();
    const names = roles.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['pm', 'developer', 'qa-engineer', 'architect']));
    expect(roles.find((r) => r.name === 'pm')).toMatchObject({ zone: 'pm-office', syncToClaude: false, builtin: true, title: 'Project Manager' });
    expect(roles.find((r) => r.name === 'developer')).toMatchObject({ title: 'Developer', model: 'sonnet', zone: 'desks', builtin: true });
  });

  it('syncs enabled roles with Claude-only frontmatter and the managed marker', async () => {
    const { app, agentsDir } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/roles/sync', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(200);
    const files = readdirSync(agentsDir).sort();
    expect(files).toContain('developer.md');
    expect(files).not.toContain('pm.md'); // office-sync: false
    const dev = readFileSync(join(agentsDir, 'developer.md'), 'utf8');
    expect(dev.startsWith('---\nname: developer\ndescription: ')).toBe(true);
    expect(dev).toContain('model: sonnet');
    expect(dev).not.toMatch(/office-|title:|zone:|color:/);
    expect(dev.trimEnd().endsWith(MANAGED_MARKER)).toBe(true);
  });

  it('writes on save, removes only managed files, and never touches user files', async () => {
    const { app, agentsDir } = await setup();
    const userFile = join(agentsDir, 'my-own.md');
    writeFileSync(userFile, '---\nname: my-own\n---\nmine\n');
    const clash = join(agentsDir, 'writer.md');
    writeFileSync(clash, '---\nname: writer\n---\nuser owned\n');
    const stale = join(agentsDir, 'old-role.md');
    writeFileSync(stale, `---\nname: old-role\n---\nx\n\n${MANAGED_MARKER}\n`);

    const role = { title: 'Data Scientist', description: 'Analyses data', prompt: 'You analyse data.', tools: ['Read', 'Bash'], zone: 'library' };
    const saved = await app.inject({ method: 'PUT', url: '/api/roles/data-scientist', payload: role });
    expect(saved.statusCode).toBe(200);
    const file = readFileSync(join(agentsDir, 'data-scientist.md'), 'utf8');
    expect(file).toContain('tools: Read, Bash');
    expect(file).not.toContain('model:'); // inherit is omitted
    expect(existsSync(stale)).toBe(false); // managed but no longer a role
    expect(readFileSync(userFile, 'utf8')).toContain('mine');

    const writer = await app.inject({ method: 'PUT', url: '/api/roles/writer', payload: { ...role, title: 'Writer' } });
    expect(writer.statusCode).toBe(200);
    expect(readFileSync(clash, 'utf8')).toContain('user owned'); // unmanaged → skipped
    const sync = (await app.inject({ method: 'POST', url: '/api/roles/sync', headers: { 'content-type': 'application/json' } })).json();
    expect(sync.skipped).toEqual(['writer.md']);

    // Disabling a role removes its managed file; deleting works too.
    await app.inject({ method: 'PUT', url: '/api/roles/data-scientist', payload: { ...role, enabled: false } });
    expect(existsSync(join(agentsDir, 'data-scientist.md'))).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: '/api/roles/developer' })).statusCode).toBe(204);
    expect(existsSync(join(agentsDir, 'developer.md'))).toBe(false);
    expect(existsSync(userFile)).toBe(true);
  });

  it('rejects unsafe or invalid names and protects the main role', async () => {
    const { app, agentsDir } = await setup();
    const role = { title: 'X', description: 'x', prompt: 'x' };
    for (const name of ['..%2F..%2Fetc', 'a.b', '.hidden', 'Upper', 'x']) {
      const res = await app.inject({ method: 'PUT', url: `/api/roles/${name}`, payload: role });
      expect(res.statusCode, name).toBe(400);
    }
    expect(() => app.diContainer.cradle.rolesService.save('../evil', role)).toThrow(/Invalid role name/);
    const mismatch = await app.inject({ method: 'PUT', url: '/api/roles/good-name', payload: { ...role, name: 'other' } });
    expect(mismatch.statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/roles/pm' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/roles/nope-nope' })).statusCode).toBe(404);
    expect(readdirSync(agentsDir).every((f) => /^[a-z][a-z0-9-]+\.md$/.test(f))).toBe(true);
  });

  it('refuses to sync into an unsafe agentsDir (not literally "agents", or same as claudeDir)', async () => {
    const claudeDir = makeTempDir();
    const notAgents = join(makeTempDir(), 'not-agents-at-all');
    mkdirSync(notAgents);
    app = await buildTestApp({ settings: { paths: { claudeDir, agentsDir: notAgents } } });
    let result = app.diContainer.cradle.rolesService.sync();
    expect(result).toEqual({ written: [], removed: [], skipped: [] });
    expect(readdirSync(notAgents)).toEqual([]); // nothing written

    expect(isSafeAgentsDir(claudeDir, claudeDir)).toBe(false); // same dir as ~/.claude
    const restApp = await buildTestApp({ settings: { paths: { claudeDir, agentsDir: claudeDir } } });
    try {
      const res = await restApp.inject({ method: 'POST', url: '/api/roles/sync', headers: { 'content-type': 'application/json' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ written: [], removed: [], skipped: [] });
    } finally {
      await restApp.close();
    }
  });

  it('never treats a symlink as a managed file: write and stale-delete both skip it', () => {
    const dir = join(makeTempDir(), 'agents');
    mkdirSync(dir);

    // A symlink sitting where a wanted role's file would go: never overwritten, even if its target
    // happens to contain the managed marker.
    const realTarget = join(makeTempDir(), 'real-target.md');
    writeFileSync(realTarget, `---\nname: developer\n---\nx\n\n${MANAGED_MARKER}\n`);
    const linkPath = join(dir, 'developer.md');
    symlinkSync(realTarget, linkPath);

    const result = syncRolesToDir([DEVELOPER_ROLE], dir);
    expect(result.skipped).toEqual(['developer.md']);
    expect(result.written).toEqual([]);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    // A stale symlink (role no longer wanted) whose target contains the marker: must not be unlinked.
    const ghostTarget = join(makeTempDir(), 'ghost-target.md');
    writeFileSync(ghostTarget, `x\n\n${MANAGED_MARKER}\n`);
    const ghostLink = join(dir, 'ghost.md');
    symlinkSync(ghostTarget, ghostLink);
    const result2 = syncRolesToDir([DEVELOPER_ROLE], dir);
    expect(result2.removed).not.toContain('ghost.md');
    expect(existsSync(ghostLink)).toBe(true);
  });

  it('renders YAML-safe frontmatter', () => {
    const out = renderAgentFile({
      name: 'odd',
      title: 'Odd',
      description: 'Use when: "quotes" and colons: appear',
      model: 'haiku',
      tools: null,
      prompt: 'Body',
      zone: 'desks',
      color: '#000000',
      sprite: 0,
      enabled: true,
      syncToClaude: true,
      builtin: false,
    });
    expect(out).toMatch(/^---\nname: odd\ndescription: .+\nmodel: haiku\n---\n\nBody\n\n<!-- managed-by: tagconn -->\n$/);
    expect(out).not.toContain('tools:');
  });
});
