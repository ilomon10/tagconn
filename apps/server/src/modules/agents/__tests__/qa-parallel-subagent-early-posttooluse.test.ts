import type { Agent, HookPayload, OfficeSnapshot, Task } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp } from '../../../../test/helpers.js';

/**
 * QA regression test: reproduces an event ORDER that is not covered by
 * apps/server/src/modules/agents/__tests__/parallel-subagents.test.ts and that a real, live
 * `claude -p` run with two parallel general-purpose subagents actually produced against the
 * sandboxed server during manual QA on 2026-09-25.
 *
 * Real observed order for two parallel `Agent` tool calls (from GET /api/events on a live run):
 *   PreToolUse(T1, "list files")
 *   PostToolUse(T1, tool_response.agentId=A1)      <-- arrives BEFORE SubagentStart(A1)
 *   SubagentStart(A1)
 *   PreToolUse(T2, "read readme")
 *   SubagentStart(A2)                               <-- arrives BEFORE PostToolUse(T2)
 *   PostToolUse(T2, tool_response.agentId=A2)
 *
 * The existing unit tests only cover "SubagentStart before PostToolUse" (both agents) and
 * "PostToolUse long after SubagentStop" (both agents). Neither covers a PostToolUse landing
 * BEFORE its own agent's SubagentStart, which is exactly what happened for A1 above.
 *
 * Expected: both A1 and A2 end up with the correct `description` (mirroring the task titles,
 * which ARE correct for both). Previously (before the fix), A1's description was silently
 * dropped and stayed undefined forever, because:
 *   - PreToolUse(T1) queues a pending call {toolUseId: T1, description: "task A"}.
 *   - PostToolUse(T1) ran `linkAgentCall`, which unconditionally called `dropPending(T1)`
 *     (agents.service.ts `linkAgentCall`), removing the pending entry, then tried
 *     `agentsRepository.get(A1)` — but A1 did not exist yet (SubagentStart hadn't run), so the
 *     `if (sub) ...` guard skipped the description write entirely. The description was now
 *     nowhere: not applied, and no longer pending.
 *   - SubagentStart(A1) then ran `matchPending`, but the pending entry for T1 was already
 *     consumed/dropped by the early PostToolUse, so there was nothing left to match. A1 was
 *     created with no description and never got one.
 *
 * Fixed in apps/server/src/modules/agents/agents.service.ts: `linkAgentCall` now stashes the
 * (toolUseId, description) pair in an `earlyLinks` map keyed by agentId when the agent record does
 * not exist yet, and `linkStart` (called from SubagentStart) consults that map first — authoritative
 * — before falling back to the FIFO `matchPending` guess.
 */
describe('QA regression: PostToolUse(Agent) arriving before its own SubagentStart', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const SESSION = 'qa-early-posttooluse-session';
  const CWD = '/tmp/qa-early-posttooluse-project';
  const T1 = 'toolu_qa_A';
  const T2 = 'toolu_qa_B';
  const A1 = 'qa-agent-one';
  const A2 = 'qa-agent-two';

  const hook = (p: Partial<HookPayload>): HookPayload =>
    ({ session_id: SESSION, cwd: CWD, hook_event_name: 'PreToolUse', ...p }) as HookPayload;

  async function send(app: App, payload: HookPayload) {
    const res = await app.inject({ method: 'POST', url: '/api/hooks', payload });
    expect(res.statusCode).toBe(202);
  }

  // Fixed: agents.service.ts `linkAgentCall` now stashes an "early link" (agentId → {toolUseId,
  // description}) when PostToolUse(Agent) arrives before its own SubagentStart, and `linkStart`
  // consults it (authoritative) before falling back to the FIFO `matchPending` guess.
  it('reproduces a real live-session hook order and expects both agents to keep their description', async () => {
    app = await buildTestApp();

    // T1: PreToolUse -> PostToolUse -> SubagentStart (PostToolUse arrives first, matching the real run)
    await send(
      app,
      hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_use_id: T1,
        tool_input: { description: 'task A', subagent_type: 'general-purpose' },
      }),
    );
    await send(
      app,
      hook({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_use_id: T1,
        tool_input: { description: 'task A', subagent_type: 'general-purpose' },
        tool_response: { agentId: A1 },
      }),
    );
    await send(app, hook({ hook_event_name: 'SubagentStart', agent_id: A1, agent_type: 'general-purpose' }));

    // T2: PreToolUse -> SubagentStart -> PostToolUse (the "normal", already-covered order)
    await send(
      app,
      hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_use_id: T2,
        tool_input: { description: 'task B', subagent_type: 'general-purpose' },
      }),
    );
    await send(app, hook({ hook_event_name: 'SubagentStart', agent_id: A2, agent_type: 'general-purpose' }));
    await send(
      app,
      hook({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_use_id: T2,
        tool_input: { description: 'task B', subagent_type: 'general-purpose' },
        tool_response: { agentId: A2 },
      }),
    );

    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    const a1 = snap.agents.find((a: Agent) => a.id === A1);
    const a2 = snap.agents.find((a: Agent) => a.id === A2);

    // a2 (the already-covered ordering) is expected to pass.
    expect(a2?.description).toBe('task B');

    // a1 reproduces the live-run bug: this currently fails (a1?.description is undefined).
    expect(a1?.description).toBe('task A');

    const t1 = snap.tasks.find((t: Task) => t.id === T1);
    const t2 = snap.tasks.find((t: Task) => t.id === T2);
    // Task titles are unaffected by this bug (set directly from PreToolUse tool_input.description).
    expect(t1).toMatchObject({ title: 'task A', assigneeAgentId: A1 });
    expect(t2).toMatchObject({ title: 'task B', assigneeAgentId: A2 });
  });
});
