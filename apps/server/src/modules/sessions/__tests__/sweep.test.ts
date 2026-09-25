import type { HookPayload, OfficeSnapshot } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp } from '../../../../test/helpers.js';
import { mainAgentId } from '../../agents/index.js';

const SESSION = 'sweep-session';
const CWD = '/tmp/sweep-project';

describe('session idle/ended sweep', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('marks a quiet session idle after idleAfterSec, then ended after endAfterSec with no live agents', async () => {
    app = await buildTestApp({ settings: { sessions: { idleAfterSec: 10, endAfterSec: 200 } } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' } as HookPayload,
    });
    expect(res.statusCode).toBe(202);

    let snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.sessions.find((s) => s.id === SESSION)?.status).toBe('active');

    // Past idleAfterSec (10s), still well short of the ended threshold (endAfterSec: 200s).
    app.diContainer.cradle.sessionsService.sweep(Date.now() + 15_000);
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.sessions.find((s) => s.id === SESSION)?.status).toBe('idle');

    // Past the ended threshold; the session's only agent (main) is equally stale, so "no live agents".
    app.diContainer.cradle.sessionsService.sweep(Date.now() + 10 * 60 * 1000);
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const swept = snap.sessions.find((s) => s.id === SESSION);
    expect(swept?.status).toBe('ended');
    expect(swept?.endedAt).toBeDefined();
  });

  it('does not end a session whose agent is still recently active', async () => {
    app = await buildTestApp({ settings: { sessions: { idleAfterSec: 10 } } });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' } as HookPayload,
    });
    // Touch the agent (and session) again right before sweeping far into the future relative to the
    // FIRST event, but sweep() itself is called with `now` close to real time, so nothing is stale.
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'UserPromptSubmit', prompt: 'hi' } as HookPayload,
    });
    app.diContainer.cradle.sessionsService.sweep(Date.now());
    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.sessions.find((s) => s.id === SESSION)?.status).toBe('active');
  });

  it('removes a crashed session\'s main agent from the floor too (no SessionEnd hook ever arrives)', async () => {
    app = await buildTestApp({ settings: { sessions: { endAfterSec: 200 }, agents: { doneLingerSec: 0 } } });
    const removed: string[] = [];
    app.diContainer.cradle.bus.on('agent.removed', ({ id }) => removed.push(id));
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' } as HookPayload,
    });

    app.diContainer.cradle.sessionsService.sweep(Date.now() + 10 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 20)); // doneLingerSec: 0 removal timer, scheduled by the finish

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.sessions.find((s) => s.id === SESSION)?.status).toBe('ended');
    expect(removed).toContain(mainAgentId(SESSION));
    expect(snap.agents.find((a) => a.id === mainAgentId(SESSION))).toBeUndefined();
  });
});
