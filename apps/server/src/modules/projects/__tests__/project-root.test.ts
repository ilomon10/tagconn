import type { Agent, HookPayload, OfficeSnapshot, Project } from '@tagconn/shared';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT_HEADER, PROJECT_ROOT_KIND_HEADER } from '@tagconn/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp, loadFixture, makeTempDir } from '../../../../test/helpers.js';
import type { HookContext } from '../../../core/event-bus/index.js';
import { isStrictlyUnder, nearestAncestor } from '../../../core/db/index.js';

const SESSION = '5948c2cf-049b-4e78-b056-afb89ccf8c59';
const SUBAGENT = 'ad90ad52fc9581bdf';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('project pinning, root header and ancestor folding (M12)', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    app!.inject({ method: 'POST', url: '/api/hooks', headers, payload: payload as HookPayload });
  const snapshot = async () => (await app!.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();

  it('a mid-session cd keeps one project and puts the subagent on the PM floor', async () => {
    app = await buildTestApp();
    const events = loadFixture();
    const root = events[0]!.cwd as string;
    const sub = `${root}/apps/platform`;
    // The agent cd's into a subdirectory right before it spawns the subagent: from the Agent tool call on.
    const idx = events.findIndex((e) => e.hook_event_name === 'PreToolUse' && e.tool_name === 'Agent');
    for (const [i, e] of events.entries()) {
      const res = await post(i >= idx ? { ...e, cwd: sub } : e);
      expect(res.statusCode).toBe(202);
    }
    const snap = await snapshot();
    expect(snap.projects).toHaveLength(1);
    expect(snap.projects[0]?.cwd).toBe(root);
    expect(snap.sessions[0]?.projectId).toBe(snap.projects[0]?.id);
    const main = snap.agents.find((a: Agent) => a.id === `main:${SESSION}`);
    const subagent = snap.agents.find((a: Agent) => a.id === SUBAGENT);
    expect(subagent?.projectId).toBe(main?.projectId);
    expect(snap.tasks.every((t) => t.projectId === snap.projects[0]?.id)).toBe(true);
  });

  it('a valid root header wins over cwd for a new session and is the project cwd', async () => {
    app = await buildTestApp();
    const contexts: HookContext[] = [];
    app.diContainer.cradle.bus.on('hook.received', (c) => contexts.push(c));
    await post({ session_id: 's1', cwd: '/work/p/repo/apps/web', hook_event_name: 'SessionStart' }, { [PROJECT_ROOT_HEADER]: b64('/work/p/repo') });
    expect(contexts[0]?.projectRoot).toBe('/work/p/repo');
    expect(contexts[0]?.projectRootKind).toBeUndefined(); // no kind header: the service treats it as dir, never git
    const projects = (await app.inject({ url: '/api/projects' })).json<Project[]>();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ cwd: '/work/p/repo', name: 'repo' });
  });

  it.each([
    ['relative', b64('work/repo')],
    ['dot-dot', b64('/work/../etc')],
    ['NUL', b64('/work/re\u0000po')],
    ['newline', b64('/work/re\npo')],
    ['filesystem root', b64('/')],
    ['oversized', b64(`/${'a'.repeat(5000)}`)],
    ['bad base64', '***not base64***'],
    ['empty', ' '],
  ])('ignores a %s header (falls back to cwd)', async (_name, value) => {
    app = await buildTestApp();
    const contexts: HookContext[] = [];
    app.diContainer.cradle.bus.on('hook.received', (c) => contexts.push(c));
    await post({ session_id: 's1', cwd: '/work/cwd-project', hook_event_name: 'SessionStart' }, { [PROJECT_ROOT_HEADER]: value });
    expect(contexts[0]?.projectRoot).toBeUndefined();
    const projects = (await app.inject({ url: '/api/projects' })).json<Project[]>();
    expect(projects.map((p) => p.cwd)).toEqual(['/work/cwd-project']);
  });

  const git = (root: string) => ({ [PROJECT_ROOT_HEADER]: b64(root), [PROJECT_ROOT_KIND_HEADER]: 'git' });
  const dir = (root: string) => ({ [PROJECT_ROOT_HEADER]: b64(root), [PROJECT_ROOT_KIND_HEADER]: 'dir' });
  const start = (sid: string, cwd: string, headers: Record<string, string> = {}) => post({ session_id: sid, cwd, hook_event_name: 'SessionStart' }, headers);
  const cwds = async () => (await snapshot()).projects.map((p) => p.cwd).sort();
  const projectOf = async (sid: string) => (await snapshot()).sessions.find((s) => s.id === sid)?.projectId;

  it('floors fold only into a CONFIRMED git root: unconfirmed ancestors stay separate floors', async () => {
    app = await buildTestApp();
    await start('s1', '/work/p/repo'); // cwd only: source 'cwd'
    await start('s2', '/work/p/repo/apps/web');
    await start('s3', '/work/p/repo/apps/api', dir('/work/p/repo/apps/api'));
    expect(await cwds()).toEqual(['/work/p/repo', '/work/p/repo/apps/api', '/work/p/repo/apps/web']);
  });

  it('a git-confirmed root absorbs later sessions below it (cwd or dir-kind), but not a nested git repo or a prefix sibling', async () => {
    app = await buildTestApp();
    await start('s1', '/work/p/repo', git('/work/p/repo'));
    await start('s2', '/work/p/repo/apps/web');
    await start('s3', '/work/p/repo/apps/api', dir('/work/p/repo/apps/api'));
    await start('s4', '/work/p/repo/vendor/lib', git('/work/p/repo/vendor/lib')); // separate nested repo
    await start('s5', '/work/p/repo/vendor/lib/src');
    await start('s6', '/work/p/repo-other');
    expect(await cwds()).toEqual(['/work/p/repo', '/work/p/repo-other', '/work/p/repo/vendor/lib']);
    const root = await projectOf('s1');
    expect(await projectOf('s2')).toBe(root);
    expect(await projectOf('s3')).toBe(root);
    expect(await projectOf('s5')).toBe(await projectOf('s4'));
    expect(await projectOf('s4')).not.toBe(root);
  });

  it('a runtime merge announces each folded floor (project.merged) before the parent upsert', async () => {
    app = await buildTestApp();
    await start('s2', '/work/p/repo/apps/web');
    const child = (await projectOf('s2'))!;
    const seen: string[] = [];
    const { bus } = app.diContainer.cradle;
    bus.on('project.merged', (m) => seen.push(`merged:${m.from}>${m.into}`));
    bus.on('project.upserted', (p) => seen.push(`upsert:${p.id}`));
    await start('s1', '/work/p/repo', git('/work/p/repo'));
    await app.diContainer.cradle.projectsService.mergesSettled();
    const root = (await projectOf('s1'))!;
    expect(await projectOf('s2')).toBe(root);
    expect(seen.slice(-2)).toEqual([`merged:${child}>${root}`, `upsert:${root}`]);
  });

  it('a git header whose root does not contain the payload cwd is a dir header: it confirms nothing and absorbs nothing', async () => {
    app = await buildTestApp();
    await start('s1', '/work/p/repo/apps/web'); // an old nested floor
    await start('s2', '/elsewhere/x', git('/work/p/repo')); // foreign cwd claims the repo
    await app.diContainer.cradle.projectsService.mergesSettled();
    const records = app.diContainer.cradle.projectsRepository.listRecords();
    expect(records.find((r) => r.cwd === '/work/p/repo')?.rootSource).toBe('dir');
    expect(records.some((r) => r.cwd === '/work/p/repo/apps/web')).toBe(true); // not merged by the foreign claim
    await start('s3', '/work/p/repo/apps/web', git('/work/p/repo')); // cwd inside the root: the claim holds
    await app.diContainer.cradle.projectsService.mergesSettled();
    expect(app.diContainer.cradle.projectsRepository.listRecords().find((r) => r.cwd === '/work/p/repo')?.rootSource).toBe('git');
    expect(await cwds()).toEqual(['/work/p/repo']);
  });

  it('~ and /home (shallow roots) never absorb, even when a git header confirms them', async () => {
    app = await buildTestApp();
    await start('s1', '/home/u', git('/home/u'));
    await start('s2', '/home/u/proj');
    await start('s5', '/home/u/code', git('/home/u/code'));
    await start('s6', '/home/u/code/x');
    await start('s3', '/home', git('/home'));
    await start('s4', '/home/other/proj');
    expect(await cwds()).toEqual(['/home', '/home/other/proj', '/home/u', '/home/u/code', '/home/u/code/x', '/home/u/proj']);
  });

  it('an archived git root absorbs nothing', async () => {
    app = await buildTestApp();
    await start('s1', '/work/p/repo', git('/work/p/repo'));
    const id = (await projectOf('s1'))!;
    app.diContainer.cradle.projectsService.update(id, { archived: true });
    await start('s2', '/work/p/repo/apps/web');
    expect(await cwds()).toEqual(['/work/p/repo', '/work/p/repo/apps/web']);
  });

  it('equal normalised paths are one project (trailing slash, doubled slash, Windows case and separators)', async () => {
    app = await buildTestApp();
    await start('s1', '/work/p/repo/');
    await start('s2', '/work/p//repo');
    await start('s3', 'C:\\Work\\Proj\\Repo');
    await start('s4', 'c:/work/proj/repo');
    await start('s5', 'c:\\work\\proj\\repo.'); // Windows drops the trailing dot
    expect((await snapshot()).projects).toHaveLength(2);
    expect(await projectOf('s2')).toBe(await projectOf('s1'));
    expect(await projectOf('s4')).toBe(await projectOf('s3'));
    expect(await projectOf('s5')).toBe(await projectOf('s3'));
  });

  it.each([
    ['relative', 'work/repo'],
    ['dot-dot', '/work/../etc'],
    ['filesystem root', '/'],
    ['control char', '/work/re\u0001po'],
    ['bidi override', '/work/re\u202Epo'],
    ['Windows ADS colon', 'C:\\work\\repo:stream'],
    ['oversized', `/${'a'.repeat(5000)}`],
  ])('an invalid payload cwd (%s) is treated as missing', async (_n, cwd) => {
    app = await buildTestApp();
    await start('s1', cwd);
    expect(await cwds()).toEqual(['(unknown)']);
  });

  it('the first git event merges the old nested floor into its repo (backup first, once), even from a pinned session', async () => {
    const dbDir = makeTempDir('tagconn-merge-');
    app = await buildTestApp({ dbPath: join(dbDir, 'office.db') });
    await start('old', '/work/p/ovor/apps/platform'); // pre-upgrade floor: created from a cd'd cwd
    await start('other', '/work/p/ovor'); // the repo floor, not yet confirmed
    expect(await cwds()).toEqual(['/work/p/ovor', '/work/p/ovor/apps/platform']);

    // The pinned session's next event now carries the git header: ovor is confirmed and absorbs the child.
    const contexts: HookContext[] = [];
    app.diContainer.cradle.bus.on('hook.received', (c) => contexts.push(c));
    await post({ session_id: 'old', cwd: '/work/p/ovor/apps/platform', hook_event_name: 'UserPromptSubmit', prompt: 'x' }, git('/work/p/ovor'));
    await app.diContainer.cradle.projectsService.mergesSettled();
    const snap = await snapshot();
    expect(snap.projects.map((p) => p.cwd)).toEqual(['/work/p/ovor']);
    expect(snap.sessions.map((s) => s.projectId)).toEqual(snap.sessions.map(() => snap.projects[0]!.id));

    const backups = readdirSync(dbDir).filter((f) => f.includes('.pre-merge-'));
    expect(backups).toHaveLength(1);
    expect(existsSync(join(dbDir, backups[0]!))).toBe(true);

    // A merge later takes its own fresh backup (the file name carries the timestamp, so move the clock).
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3 * 3_600_000 });
    try {
      await start('o2', '/work/p/two/a');
      await start('o3', '/work/p/two');
      await post({ session_id: 'o3', cwd: '/work/p/two', hook_event_name: 'Stop' }, git('/work/p/two'));
      await app.diContainer.cradle.projectsService.mergesSettled();
    } finally {
      vi.useRealTimers();
    }
    expect((await snapshot()).projects.map((p) => p.cwd).sort()).toEqual(['/work/p/ovor', '/work/p/two']);
    const all = readdirSync(dbDir).filter((f) => f.includes('.pre-merge-'));
    expect(all).toHaveLength(2);
    for (const f of all) expect(statSync(join(dbDir, f)).mode & 0o077).toBe(0);
  });

  it('a git header for an existing project upgrades it in place; a later dir header never downgrades it', async () => {
    app = await buildTestApp();
    await start('s1', '/work/p/repo'); // source 'cwd'
    await start('s2', '/work/p/repo', git('/work/p/repo'));
    await start('s3', '/work/p/repo/sub', dir('/work/p/repo/sub'));
    expect(await cwds()).toEqual(['/work/p/repo']); // s3 folded: the repo is now a confirmed git root
    expect(await projectOf('s3')).toBe(await projectOf('s1'));
  });

  it('path helpers: POSIX and Windows-style prefixes, nearest ancestor', () => {
    expect(isStrictlyUnder('/a/b/c', '/a/b')).toBe(true);
    expect(isStrictlyUnder('/a/b', '/a/b')).toBe(false);
    expect(isStrictlyUnder('/a/bc', '/a/b')).toBe(false);
    expect(isStrictlyUnder('/a/b/', '/a/b')).toBe(false);
    expect(isStrictlyUnder('C:\\Repo\\apps\\web', 'c:\\repo')).toBe(true);
    expect(isStrictlyUnder('C:\\Repo2', 'C:\\Repo')).toBe(false);
    expect(isStrictlyUnder('/a', '/')).toBe(false);
    expect(nearestAncestor('/a/b/c/d', [{ cwd: '/a' }, { cwd: '/a/b/c' }, { cwd: '/a/b' }])).toEqual({ cwd: '/a/b/c' });
  });
});
