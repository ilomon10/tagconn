import type { OfficeSnapshot, Run } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp } from '../../../../test/helpers.js';
import { projectIdFor } from '../../projects/index.js';

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_RUN_ID = '22222222-3333-4333-8444-555555555555';
const SESSION = 'run-link-session';
const CWD = '/tmp/run-link-project';
const OTHER_CWD = '/tmp/run-link-other-project';

const baseRun = (overrides: Partial<Run>): Run => ({
  id: RUN_ID,
  kind: 'quest',
  threadId: RUN_ID,
  status: 'running',
  prompt: 'do the thing',
  permissionMode: 'acceptEdits',
  model: 'sonnet',
  createdBy: 'admin-session-1',
  createdAt: Date.now(),
  eventCount: 0,
  truncated: false,
  ...overrides,
});

describe('sessions <-> runs linking (M8 8k, S5, §2.6 "Hint")', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('links a session to a known, project-matching quest run from the x-tagconn-run-id header', async () => {
    app = await buildTestApp();
    const projectId = projectIdFor(CWD);
    app.diContainer.cradle.runsRepository.insert(baseRun({ projectId }));

    const linked: { runId: string; sessionId: string }[] = [];
    app.diContainer.cradle.bus.on('run.linked', (e) => linked.push(e));

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { 'x-tagconn-run-id': RUN_ID },
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' },
    });
    expect(res.statusCode).toBe(202);

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const session = snap.sessions.find((s) => s.id === SESSION);
    expect(session?.runId).toBe(RUN_ID);
    expect(session?.origin).toBe('quest');

    // The runs module's own side of the link (run.sessionId + run.linked), via the runLinker port.
    expect(linked).toContainEqual({ runId: RUN_ID, sessionId: SESSION, projectId });
    expect(app.diContainer.cradle.runsRepository.get(RUN_ID)?.sessionId).toBe(SESSION);
  });

  it('never trusts a run id across projects: a mismatch is ignored and the session falls back to cli', async () => {
    app = await buildTestApp();
    // The run belongs to a DIFFERENT project than the session's cwd.
    app.diContainer.cradle.runsRepository.insert(baseRun({ id: OTHER_RUN_ID, threadId: OTHER_RUN_ID, projectId: projectIdFor(OTHER_CWD) }));

    const linked: unknown[] = [];
    app.diContainer.cradle.bus.on('run.linked', (e) => linked.push(e));

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { 'x-tagconn-run-id': OTHER_RUN_ID },
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' },
    });
    expect(res.statusCode).toBe(202);

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const session = snap.sessions.find((s) => s.id === SESSION);
    expect(session?.runId).toBeUndefined();
    expect(session?.origin).toBe('cli');
    expect(linked).toHaveLength(0);
    expect(app.diContainer.cradle.runsRepository.get(OTHER_RUN_ID)?.sessionId).toBeUndefined();
  });

  it('defaults a plain CLI session (no run id header) to origin cli', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' },
    });
    expect(res.statusCode).toBe(202);

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const session = snap.sessions.find((s) => s.id === SESSION);
    expect(session?.runId).toBeUndefined();
    expect(session?.origin).toBe('cli');
  });

  it('ignores an unknown (not-yet-seen or already-pruned) run id: falls back to cli', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { 'x-tagconn-run-id': RUN_ID },
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' },
    });
    expect(res.statusCode).toBe(202);

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const session = snap.sessions.find((s) => s.id === SESSION);
    expect(session?.runId).toBeUndefined();
    expect(session?.origin).toBe('cli');
  });

  it('does not link a terminal (already-ended) run', async () => {
    app = await buildTestApp();
    const projectId = projectIdFor(CWD);
    app.diContainer.cradle.runsRepository.insert(baseRun({ projectId, status: 'succeeded', endedAt: Date.now() }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { 'x-tagconn-run-id': RUN_ID },
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' },
    });
    expect(res.statusCode).toBe(202);

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const session = snap.sessions.find((s) => s.id === SESSION);
    expect(session?.runId).toBeUndefined();
    expect(session?.origin).toBe('cli');
  });
});
