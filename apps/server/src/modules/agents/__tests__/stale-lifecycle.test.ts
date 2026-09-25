import { join } from 'node:path';
import type { HookPayload, OfficeSnapshot } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp, makeTempDir } from '../../../../test/helpers.js';
import { mainAgentId } from '../index.js';

const SESSION = 'stale-session';
const CWD = '/tmp/stale-project';
const SUBAGENT = 'sub-1';

/** Minimal, hand-built hook payloads (no fixture needed): control exactly which events fire. */
const hook = (p: Partial<HookPayload> & { hook_event_name: string }): HookPayload => ({ session_id: SESSION, ...p }) as HookPayload;

describe('8a: stale subagent + idle PM lifecycle', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('marks a subagent whose SubagentStop was lost as done+removed after staleAfterSec, then it returns on a later event', async () => {
    app = await buildTestApp({ settings: { agents: { staleAfterSec: 100, doneLingerSec: 0 } } });
    const removed: string[] = [];
    app.diContainer.cradle.bus.on('agent.removed', ({ id }) => removed.push(id));

    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_use_id: 't1',
        tool_input: { description: 'do work', subagent_type: 'general-purpose' },
      }),
    });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: SUBAGENT, agent_type: 'general-purpose' }),
    });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'PreToolUse', agent_id: SUBAGENT, tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'echo hi' } }),
    });
    // No PostToolUse / SubagentStop ever follows: the subagent (or its stream) was killed/lost.

    let snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === SUBAGENT)).toMatchObject({ status: 'active' });

    app.diContainer.cradle.agentsService.sweep(Date.now() + 200_000);
    await new Promise((r) => setTimeout(r, 20)); // doneLingerSec: 0 removal timer

    expect(removed).toContain(SUBAGENT);
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === SUBAGENT)).toBeUndefined();
    // The main agent (recently touched) is unaffected.
    expect(snap.agents.find((a) => a.id === mainAgentId(SESSION))).toBeDefined();

    // A later event for the same agent_id: it returns, active, back on the floor.
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'PostToolUse', agent_id: SUBAGENT, tool_name: 'Bash', tool_use_id: 't2', tool_response: {} }),
    });
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === SUBAGENT)).toMatchObject({ status: 'active' });
  });

  it('an idle PM with no live subagents leaves the floor after pmIdleLeaveSec, and returns on the session\'s next event', async () => {
    app = await buildTestApp({ settings: { sessions: { pmIdleLeaveSec: 50 } } });
    const removed: string[] = [];
    app.diContainer.cradle.bus.on('agent.removed', ({ id }) => removed.push(id));
    const mainId = mainAgentId(SESSION);

    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    let snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === mainId)).toBeDefined();

    app.diContainer.cradle.agentsService.sweep(Date.now() + 100_000);
    expect(removed).toContain(mainId);
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === mainId)).toBeUndefined();

    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }) });
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === mainId)).toMatchObject({ status: 'active' });
  });

  it('a PM stays on the floor while it still has a live subagent, even past pmIdleLeaveSec', async () => {
    app = await buildTestApp({ settings: { sessions: { pmIdleLeaveSec: 50 } } });
    const removed: string[] = [];
    app.diContainer.cradle.bus.on('agent.removed', ({ id }) => removed.push(id));
    const mainId = mainAgentId(SESSION);

    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: SUBAGENT, agent_type: 'general-purpose' }),
    });
    // Keep the subagent fresh while the PM itself goes quiet (delegating, "waiting on 1 agent").
    app.diContainer.cradle.agentsService.sweep(Date.now() + 100_000);

    expect(removed).not.toContain(mainId);
    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === mainId)).toBeDefined();
  });

  it('boot recovery: applies staleAfterSec immediately on restart to rows left over from before', async () => {
    const dbPath = join(makeTempDir(), 'office.db');
    let before: App | undefined;
    try {
      before = await buildTestApp({ dbPath, settings: { agents: { staleAfterSec: 900 } } });
      await before.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
      await before.inject({
        method: 'POST',
        url: '/api/hooks',
        payload: hook({ hook_event_name: 'SubagentStart', agent_id: SUBAGENT, agent_type: 'general-purpose' }),
      });
      // Back-date it as if it had already been silent for a long time before the restart (the live
      // bug this fixes: 8 agents like this, up to 135 min old, stuck on the floor forever).
      const repo = before.diContainer.cradle.agentsRepository;
      const stale = repo.get(SUBAGENT);
      if (!stale) throw new Error('subagent not found');
      repo.upsert({ ...stale, updatedAt: Date.now() - 20 * 60 * 1000 });
    } finally {
      await before?.close();
    }

    app = await buildTestApp({ dbPath, settings: { agents: { staleAfterSec: 900, doneLingerSec: 0 } } });
    await app.ready(); // onReady runs agentsService.start(), which sweeps once immediately
    await new Promise((r) => setTimeout(r, 20)); // doneLingerSec: 0 removal timer

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === SUBAGENT)).toBeUndefined();
  });
});
