import type { Agent, HookPayload, OfficeSnapshot, Project } from '@tagconn/shared';
import { PROJECT_ROOT_HEADER } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp, loadFixture } from '../../../../test/helpers.js';
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
    await post({ session_id: 's1', cwd: '/work/repo/apps/web', hook_event_name: 'SessionStart' }, { [PROJECT_ROOT_HEADER]: b64('/work/repo') });
    expect(contexts[0]?.projectRoot).toBe('/work/repo');
    const projects = (await app.inject({ url: '/api/projects' })).json<Project[]>();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ cwd: '/work/repo', name: 'repo' });
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

  it('a new session whose root lies under an existing project joins that ancestor project', async () => {
    app = await buildTestApp();
    await post({ session_id: 's1', cwd: '/work/repo', hook_event_name: 'SessionStart' });
    await post({ session_id: 's2', cwd: '/work/repo/apps/web', hook_event_name: 'SessionStart' });
    await post({ session_id: 's3', cwd: '/work/repo-other', hook_event_name: 'SessionStart' }); // prefix without separator: not a child
    const snap = await snapshot();
    expect(snap.projects.map((p) => p.cwd).sort()).toEqual(['/work/repo', '/work/repo-other']);
    const s1 = snap.sessions.find((s) => s.id === 's1');
    expect(snap.sessions.find((s) => s.id === 's2')?.projectId).toBe(s1?.projectId);
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
