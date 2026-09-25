import type { Agent, OfficeSnapshot, Task } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp, loadFixture } from '../../../../test/helpers.js';

const SESSION = '5948c2cf-049b-4e78-b056-afb89ccf8c59';
const SUBAGENT = 'ad90ad52fc9581bdf';
const AGENT_CALL = 'toolu_01Bw5JoauZyfdV4WKG3r76vf';

describe('fixture replay: main session spawning one general-purpose subagent', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('builds the expected office state', async () => {
    app = await buildTestApp();
    const agentStates: Agent[] = [];
    app.diContainer.cradle.bus.on('agent.upserted', (a) => agentStates.push(a));

    for (const payload of loadFixture()) {
      const res = await app.inject({ method: 'POST', url: '/api/hooks', payload });
      expect(res.statusCode).toBe(202);
    }

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.projects).toHaveLength(1);
    expect(snap.projects[0]?.id).toMatch(/^work-[0-9a-f]{6}$/);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]).toMatchObject({ id: SESSION, status: 'ended' });

    const main = snap.agents.find((a) => a.id === `main:${SESSION}`);
    expect(main).toMatchObject({ isMain: true, agentType: 'main', role: 'pm', status: 'done' });

    const sub = snap.agents.find((a) => a.id === SUBAGENT);
    expect(sub).toMatchObject({
      isMain: false,
      agentType: 'general-purpose',
      role: 'developer',
      description: 'list files',
      status: 'done',
      activity: 'done',
      zone: 'entrance',
      toolCount: 2,
    });
    expect(sub?.lastMessage).toContain('a.txt');
    expect(snap.agents).toHaveLength(2);

    const task = snap.tasks.find((t: Task) => t.id === AGENT_CALL);
    expect(task).toMatchObject({ title: 'list files', status: 'done', source: 'agent-call', assigneeAgentId: SUBAGENT, role: 'developer' });

    // Intermediate states: subagent typed/read at its desk, main delegated then waited.
    const subActivities = agentStates.filter((a) => a.id === SUBAGENT).map((a) => a.activity);
    expect(subActivities).toEqual(expect.arrayContaining(['thinking', 'running', 'reading', 'done']));
    const mainStates = agentStates.filter((a) => a.isMain);
    expect(mainStates.some((a) => a.activity === 'delegating' && a.zone === 'meeting-room')).toBe(true);
    expect(mainStates.some((a) => a.status === 'waiting' && a.bubble === 'Waiting on 1 agent')).toBe(true);

    const events = (await app.inject({ url: '/api/events?limit=500' })).json<unknown[]>();
    expect(events).toHaveLength(loadFixture().length);
  });

  it('drops disabled events and enforces the hook token', async () => {
    app = await buildTestApp({ settings: { server: { hookToken: 's3cret' }, ingest: { enabledEvents: ['SessionStart'] } } });
    const [start, prompt] = loadFixture();
    expect((await app.inject({ method: 'POST', url: '/api/hooks', payload: start })).statusCode).toBe(401);
    const headers = { 'x-office-token': 's3cret' };
    expect((await app.inject({ method: 'POST', url: '/api/hooks', payload: start, headers })).statusCode).toBe(202);
    const ignored = await app.inject({ method: 'POST', url: '/api/hooks', payload: prompt, headers });
    expect(ignored.json()).toMatchObject({ ok: true, ignored: 'event disabled' });
    expect((await app.inject({ method: 'POST', url: '/api/hooks', payload: { nope: 1 }, headers })).statusCode).toBe(400);
  });

  it('redacts secrets before they reach bubbles and events', async () => {
    app = await buildTestApp();
    const [start] = loadFixture();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: start });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { ...start, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'export API_KEY=abc123' } },
    });
    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const main = snap.agents.find((a) => a.isMain);
    expect(main?.bubble).toBe('$ export [redacted]');
    expect(JSON.stringify(snap.events)).not.toContain('abc123');
  });

  it('sweeps idle agents to the lounge and removes finished ones after the linger time', async () => {
    app = await buildTestApp({ settings: { agents: { doneLingerSec: 0, idleAfterSec: 10 } } });
    const removed: string[] = [];
    app.diContainer.cradle.bus.on('agent.removed', ({ id }) => removed.push(id));
    const fixture = loadFixture();
    // Up to the subagent's first tool call: main is waiting, subagent active.
    for (const payload of fixture.slice(0, 6)) await app.inject({ method: 'POST', url: '/api/hooks', payload });

    app.diContainer.cradle.agentsService.sweep(Date.now() + 60_000);
    let snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === SUBAGENT)).toMatchObject({ status: 'active', activity: 'idle', zone: 'lounge' });

    for (const payload of fixture.slice(6)) await app.inject({ method: 'POST', url: '/api/hooks', payload });
    await new Promise((r) => setTimeout(r, 20));
    expect(removed).toEqual(expect.arrayContaining([SUBAGENT, `main:${SESSION}`]));
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents).toEqual([]);
  });
});
