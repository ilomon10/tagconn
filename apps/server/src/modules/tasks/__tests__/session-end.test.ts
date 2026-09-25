import type { HookPayload, OfficeSnapshot, Task } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp } from '../../../../test/helpers.js';

const SESSION = 'session-end-session';
const CWD = '/tmp/session-end-project';
const AGENT_TASK = 'toolu_open_agent_call';

const hook = (p: Partial<HookPayload>): HookPayload => ({ session_id: SESSION, cwd: CWD, hook_event_name: 'PreToolUse', ...p }) as HookPayload;

describe('SessionEnd closes still-open tasks', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function send(app: App, payload: HookPayload) {
    const res = await app.inject({ method: 'POST', url: '/api/hooks', payload });
    expect(res.statusCode).toBe(202);
  }

  it('fails a still-doing agent-call task whose subagent never stopped, leaves todo tasks alone', async () => {
    app = await buildTestApp();
    await send(app, hook({ hook_event_name: 'SessionStart' }));
    // An Agent tool call whose subagent never reports SubagentStart/Stop before the session ends.
    await send(
      app,
      hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: AGENT_TASK, tool_input: { description: 'orphaned task', subagent_type: 'general-purpose' } }),
    );
    // A todo-list item that should be left exactly as-is.
    await send(app, hook({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'write docs', status: 'pending' }] } }));

    let snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.tasks.find((t) => t.id === AGENT_TASK)).toMatchObject({ status: 'doing', source: 'agent-call' });
    const todoBefore = snap.tasks.find((t: Task) => t.source === 'todo');
    expect(todoBefore).toMatchObject({ status: 'todo' });

    await send(app, hook({ hook_event_name: 'SessionEnd' }));

    snap = (await app.inject({ url: '/api/snapshot?projectId=*' })).json<OfficeSnapshot>();
    expect(snap.tasks.find((t) => t.id === AGENT_TASK)).toMatchObject({ status: 'failed', source: 'agent-call' });
    const todoAfter = snap.tasks.find((t) => t.id === todoBefore?.id);
    expect(todoAfter).toMatchObject({ status: 'todo' }); // untouched
  });

  it('leaves an already-finished agent-call task alone', async () => {
    app = await buildTestApp();
    const AGENT_ID = 'finished-agent';
    await send(app, hook({ hook_event_name: 'SessionStart' }));
    await send(
      app,
      hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_done', tool_input: { description: 'finished task', subagent_type: 'general-purpose' } }),
    );
    await send(app, hook({ hook_event_name: 'SubagentStart', agent_id: AGENT_ID, agent_type: 'general-purpose' }));
    await send(
      app,
      hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_done', tool_input: { description: 'finished task', subagent_type: 'general-purpose' }, tool_response: { agentId: AGENT_ID } }),
    );
    await send(app, hook({ hook_event_name: 'SubagentStop', agent_id: AGENT_ID, agent_type: 'general-purpose', last_assistant_message: '```handoff\nstatus: done\nsummary: ok\nfiles: none\ntests: none\nnext: none\n```' }));

    let snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const finished = snap.tasks.find((t) => t.id === 'toolu_done');
    expect(finished?.status).toBe('done');

    await send(app, hook({ hook_event_name: 'SessionEnd' }));
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.tasks.find((t) => t.id === 'toolu_done')?.status).toBe('done'); // unchanged, not clobbered to failed
  });
});
