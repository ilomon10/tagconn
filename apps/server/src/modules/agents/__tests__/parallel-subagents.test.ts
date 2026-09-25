import type { Agent, HookPayload, OfficeSnapshot, Task } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp } from '../../../../test/helpers.js';

const SESSION = 'parallel-session';
const CWD = '/tmp/parallel-project';
const T1 = 'toolu_task_A';
const T2 = 'toolu_task_B';
const AGENT_1 = 'agent-one'; // really spawned for T1 ("task A")
const AGENT_2 = 'agent-two'; // really spawned for T2 ("task B")

const hook = (p: Partial<HookPayload>): HookPayload =>
  ({ session_id: SESSION, cwd: CWD, hook_event_name: 'PreToolUse', ...p }) as HookPayload;

/**
 * Two same-type ("general-purpose") subagents started back to back. Claude Code's own event order
 * only guarantees each PreToolUse pairs with its PostToolUse by tool_use_id and each SubagentStart
 * pairs with its SubagentStop by agent_id; the SubagentStart *order* relative to the PreToolUse Agent
 * calls is not guaranteed, so the initial FIFO guess (oldest pending call ↔ next SubagentStart) can
 * — and here does — match the wrong pair. The authoritative PostToolUse (tool_use_id ⇄
 * tool_response.agentId ⇄ tool_input.description) must correct it.
 */
describe('parallel same-type subagents: authoritative PostToolUse overrides the FIFO guess', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function send(app: App, payload: HookPayload) {
    const res = await app.inject({ method: 'POST', url: '/api/hooks', payload });
    expect(res.statusCode).toBe(202);
  }

  it('background agents: PostToolUse arrives right after each SubagentStart, in reversed order', async () => {
    app = await buildTestApp();

    await send(app, hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: T1, tool_input: { description: 'task A', subagent_type: 'general-purpose' } }));
    await send(app, hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: T2, tool_input: { description: 'task B', subagent_type: 'general-purpose' } }));

    // Reversed: the SECOND call's subagent (AGENT_2) reports its SubagentStart first, so the FIFO
    // guess wrongly pairs it with T1 (the oldest pending call).
    await send(app, hook({ hook_event_name: 'SubagentStart', agent_id: AGENT_2, agent_type: 'general-purpose' }));
    await send(app, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: T2, tool_input: { description: 'task B', subagent_type: 'general-purpose' }, tool_response: { agentId: AGENT_2 } }));

    await send(app, hook({ hook_event_name: 'SubagentStart', agent_id: AGENT_1, agent_type: 'general-purpose' }));
    await send(app, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: T1, tool_input: { description: 'task A', subagent_type: 'general-purpose' }, tool_response: { agentId: AGENT_1 } }));

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const a1 = snap.agents.find((a: Agent) => a.id === AGENT_1);
    const a2 = snap.agents.find((a: Agent) => a.id === AGENT_2);
    expect(a1?.description).toBe('task A');
    expect(a2?.description).toBe('task B');

    const t1 = snap.tasks.find((t: Task) => t.id === T1);
    const t2 = snap.tasks.find((t: Task) => t.id === T2);
    expect(t1).toMatchObject({ title: 'task A', assigneeAgentId: AGENT_1 });
    expect(t2).toMatchObject({ title: 'task B', assigneeAgentId: AGENT_2 });
  });

  it('foreground agents: PostToolUse only arrives after both SubagentStops, agents already removed', async () => {
    app = await buildTestApp({ settings: { agents: { doneLingerSec: 0 } } });

    await send(app, hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: T1, tool_input: { description: 'task A', subagent_type: 'general-purpose' } }));
    await send(app, hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: T2, tool_input: { description: 'task B', subagent_type: 'general-purpose' } }));
    // Same reversed-order guess as above.
    await send(app, hook({ hook_event_name: 'SubagentStart', agent_id: AGENT_2, agent_type: 'general-purpose' }));
    await send(app, hook({ hook_event_name: 'SubagentStart', agent_id: AGENT_1, agent_type: 'general-purpose' }));
    await send(app, hook({ hook_event_name: 'SubagentStop', agent_id: AGENT_2, agent_type: 'general-purpose', last_assistant_message: 'done' }));
    await send(app, hook({ hook_event_name: 'SubagentStop', agent_id: AGENT_1, agent_type: 'general-purpose', last_assistant_message: 'done' }));

    // With doneLingerSec: 0, each SubagentStop already scheduled an (almost) immediate removal;
    // let it fire before the late, authoritative PostToolUse arrives.
    await new Promise((r) => setTimeout(r, 20));
    expect(app.diContainer.cradle.agentsRepository.get(AGENT_1)?.removed).toBe(true);
    expect(app.diContainer.cradle.agentsRepository.get(AGENT_2)?.removed).toBe(true);

    await send(app, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: T1, tool_input: { description: 'task A', subagent_type: 'general-purpose' }, tool_response: { agentId: AGENT_1 } }));
    await send(app, hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: T2, tool_input: { description: 'task B', subagent_type: 'general-purpose' }, tool_response: { agentId: AGENT_2 } }));

    // Removed agents are off the live-floor repository listing but their rows (and tasks) still exist.
    const a1 = app.diContainer.cradle.agentsRepository.get(AGENT_1);
    const a2 = app.diContainer.cradle.agentsRepository.get(AGENT_2);
    expect(a1?.description).toBe('task A');
    expect(a2?.description).toBe('task B');

    const t1 = app.diContainer.cradle.tasksRepository.get(T1);
    const t2 = app.diContainer.cradle.tasksRepository.get(T2);
    expect(t1?.assigneeAgentId).toBe(AGENT_1);
    expect(t2?.assigneeAgentId).toBe(AGENT_2);
  });

  /**
   * Three same-type subagents, all three relative Start/Post orderings shuffled together in one
   * session: T1/A1 is "normal" (Start before Post), T2/A2 is the QA-report ordering (Post before
   * Start — see qa-parallel-subagent-early-posttooluse.test.ts), and T3/A3's SubagentStart arrives
   * out of FIFO order relative to T1's, so the initial `matchPending` guess for both A1 and A3 is
   * wrong and must be corrected by the later, authoritative PostToolUse for each. Every event fires
   * exactly once, but the *order* they arrive in is deliberately interleaved rather than grouped by
   * agent, to mirror how independent subagents' hooks actually interleave in a live run.
   */
  it('three same-type subagents: Start-before-Post, Post-before-Start and FIFO-reversal orderings all in one session, plus task assignees', async () => {
    app = await buildTestApp();
    const T3 = 'toolu_task_C';
    const AGENT_3 = 'agent-three'; // really spawned for T3 ("task C")

    const agentCall = (event: 'PreToolUse' | 'PostToolUse', toolUseId: string, description: string, agentId?: string) =>
      hook({
        hook_event_name: event,
        tool_name: 'Agent',
        tool_use_id: toolUseId,
        tool_input: { description, subagent_type: 'general-purpose' },
        ...(agentId ? { tool_response: { agentId } } : {}),
      });
    const start = (agentId: string) => hook({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'general-purpose' });

    await send(app, agentCall('PreToolUse', T1, 'task A'));
    await send(app, agentCall('PreToolUse', T2, 'task B'));
    await send(app, agentCall('PreToolUse', T3, 'task C'));

    // T2's PostToolUse arrives before ANY SubagentStart: stashed as an early link for A2.
    await send(app, agentCall('PostToolUse', T2, 'task B', AGENT_2));

    // A3 starts first even though its Agent call (T3) was queued last: the FIFO guess wrongly
    // consumes the oldest pending entry (T1, "task A").
    await send(app, start(AGENT_3));
    // A1 starts next: only T3 is left pending, so the FIFO guess wrongly consumes it too.
    await send(app, start(AGENT_1));
    // A2 starts last: its early link (T2, "task B") is authoritative and correct immediately.
    await send(app, start(AGENT_2));

    // The authoritative PostToolUse for T1 and T3 now correct both wrong FIFO guesses.
    await send(app, agentCall('PostToolUse', T1, 'task A', AGENT_1));
    await send(app, agentCall('PostToolUse', T3, 'task C', AGENT_3));

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const a1 = snap.agents.find((a: Agent) => a.id === AGENT_1);
    const a2 = snap.agents.find((a: Agent) => a.id === AGENT_2);
    const a3 = snap.agents.find((a: Agent) => a.id === AGENT_3);
    expect(a1?.description).toBe('task A');
    expect(a2?.description).toBe('task B');
    expect(a3?.description).toBe('task C');

    const t1 = snap.tasks.find((t: Task) => t.id === T1);
    const t2 = snap.tasks.find((t: Task) => t.id === T2);
    const t3 = snap.tasks.find((t: Task) => t.id === T3);
    expect(t1).toMatchObject({ title: 'task A', assigneeAgentId: AGENT_1 });
    expect(t2).toMatchObject({ title: 'task B', assigneeAgentId: AGENT_2 });
    expect(t3).toMatchObject({ title: 'task C', assigneeAgentId: AGENT_3 });
  });
});
