import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookPayload } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp, makeTempDir } from '../../../../test/helpers.js';

const CWD = '/tmp/hardening-project';

const assistantLine = (id: string, usage: Record<string, number>, model = 'claude-sonnet-5') =>
  `${JSON.stringify({ type: 'assistant', message: { id, model, usage } })}\n`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wave-2 code-review/security regression tests that don't fit `integration.test.ts`'s single
 * end-to-end scenario: session/agent id validation, cross-session hijack rejection, the
 * `maxTrackedFiles` LRU cap, and the removed-agent guard on `applyAgentUsage`.
 */
describe('transcripts: hardening', () => {
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const post = (payload: HookPayload) => app!.inject({ method: 'POST', url: '/api/hooks', payload });

  it('rejects a session_id that looks like a path traversal attempt before ever building a path from it', async () => {
    const projectsDir = join(makeTempDir(), 'projects');
    mkdirSync(projectsDir, { recursive: true });
    app = await buildTestApp({ settings: { paths: { projectsDir }, transcripts: { debounceMs: 100 } } });

    const evilSession = '../../../../etc';
    const projectDir = join(projectsDir, 'proj-slug');
    mkdirSync(projectDir, { recursive: true });
    // A real, existing, in-bounds file — if id validation didn't run, this content would happily be
    // picked up (resolveHookTranscriptPath's own containment check has nothing to reject here).
    const mainPath = join(projectDir, 'session.jsonl');
    writeFileSync(mainPath, assistantLine('msg1', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));

    await post({ session_id: evilSession, cwd: CWD, hook_event_name: 'SessionStart', transcript_path: mainPath } as HookPayload);
    await post({ session_id: evilSession, cwd: CWD, hook_event_name: 'UserPromptSubmit', transcript_path: mainPath, prompt: 'hi' } as HookPayload);
    await wait(160);

    expect(app.diContainer.cradle.agentsRepository.get(`main:${evilSession}`)?.usage).toBeUndefined();
  });

  it('rejects an agent_id that looks like a path traversal attempt', async () => {
    const projectsDir = join(makeTempDir(), 'projects');
    mkdirSync(projectsDir, { recursive: true });
    app = await buildTestApp({ settings: { paths: { projectsDir }, transcripts: { debounceMs: 100 } } });

    const session = 'traversal-agent-id-session';
    const evilAgentId = '../../../../etc/passwd';
    const projectDir = join(projectsDir, 'proj-slug');
    mkdirSync(projectDir, { recursive: true });
    const subDir = join(projectDir, session, 'subagents');
    mkdirSync(subDir, { recursive: true });
    const subPath = join(subDir, 'agent-x.jsonl'); // not even reachable via evilAgentId; just needs to exist
    writeFileSync(subPath, assistantLine('sub1', { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));

    await post({ session_id: session, cwd: CWD, hook_event_name: 'SubagentStart', agent_id: evilAgentId, agent_type: 'general-purpose', agent_transcript_path: subPath } as HookPayload);
    await wait(160);

    expect(app.diContainer.cradle.agentsRepository.get(evilAgentId)?.usage).toBeUndefined();
  });

  it('never applies usage from a different session onto an agent_id that belongs to another session (cross-session hijack)', async () => {
    const projectsDir = join(makeTempDir(), 'projects');
    mkdirSync(projectsDir, { recursive: true });
    app = await buildTestApp({ settings: { paths: { projectsDir }, transcripts: { debounceMs: 100 } } });

    const sessionA = 'hijack-session-a';
    const sessionB = 'hijack-session-b';
    const sharedAgentId = 'shared-agent-id'; // Claude's agent_id has no cross-session uniqueness guarantee
    const dirA = join(projectsDir, 'proj-a', sessionA, 'subagents');
    const dirB = join(projectsDir, 'proj-b', sessionB, 'subagents');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const fileA = join(dirA, `agent-${sharedAgentId}.jsonl`);
    const fileB = join(dirB, `agent-${sharedAgentId}.jsonl`);
    writeFileSync(fileA, assistantLine('a-msg1', { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    writeFileSync(fileB, assistantLine('b-msg1', { input_tokens: 999_999, output_tokens: 999_999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));

    // Session A legitimately owns this agent_id: establish its real usage first.
    await post({ session_id: sessionA, cwd: CWD, hook_event_name: 'SubagentStart', agent_id: sharedAgentId, agent_type: 'general-purpose', agent_transcript_path: fileA } as HookPayload);
    await wait(160);
    const before = app.diContainer.cradle.agentsRepository.get(sharedAgentId);
    expect(before?.usage).toMatchObject({ inputTokens: 3, outputTokens: 7 });
    expect(before?.sessionId).toBe(sessionA);

    // Session B reuses the same agent_id, pointing at a completely different (huge-usage) transcript.
    await post({ session_id: sessionB, cwd: CWD, hook_event_name: 'PreToolUse', agent_id: sharedAgentId, agent_transcript_path: fileB, tool_name: 'Bash' } as HookPayload);
    await wait(160);

    const after = app.diContainer.cradle.agentsRepository.get(sharedAgentId);
    expect(after?.sessionId).toBe(sessionA); // ownership never moved
    expect(after?.usage).toMatchObject({ inputTokens: 3, outputTokens: 7 }); // session B's numbers never applied
  });

  it('caps concurrently tracked files at transcripts.maxTrackedFiles, evicting least-recently-used', async () => {
    const projectsDir = join(makeTempDir(), 'projects');
    mkdirSync(projectsDir, { recursive: true });
    app = await buildTestApp({ settings: { paths: { projectsDir }, transcripts: { debounceMs: 300, maxTrackedFiles: 2 } } });

    const session = 'lru-session';
    const dir = join(projectsDir, 'proj-slug', session, 'subagents');
    mkdirSync(dir, { recursive: true });
    const agents = ['agent-1', 'agent-2', 'agent-3'];
    const files = new Map(agents.map((id) => [id, join(dir, `agent-${id}.jsonl`)]));
    for (const [id, path] of files) {
      writeFileSync(path, assistantLine(`${id}-msg1`, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    }

    // No transcript_path on the main session (kept out of the cap on purpose), agent-1/2/3 tracked
    // back to back with no delay: agent-3 pushes the cap (2), evicting the least-recently-used entry
    // (agent-1, never touched again after it was created) before its own debounced read ever fires.
    for (const id of agents) {
      await post({ session_id: session, cwd: CWD, hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'general-purpose', agent_transcript_path: files.get(id) } as HookPayload);
    }
    await wait(400);

    expect(app.diContainer.cradle.agentsRepository.get('agent-1')?.usage).toBeUndefined();
    expect(app.diContainer.cradle.agentsRepository.get('agent-2')?.usage).toMatchObject({ inputTokens: 1, outputTokens: 1 });
    expect(app.diContainer.cradle.agentsRepository.get('agent-3')?.usage).toMatchObject({ inputTokens: 1, outputTokens: 1 });
  });

  it('never emits agent:upsert usage for an agent that is already removed, even as its transcript keeps growing', async () => {
    const projectsDir = join(makeTempDir(), 'projects');
    mkdirSync(projectsDir, { recursive: true });
    app = await buildTestApp({ settings: { paths: { projectsDir }, transcripts: { debounceMs: 100 } } });

    const session = 'removed-agent-session';
    const agentId = 'soon-removed';
    const dir = join(projectsDir, 'proj-slug', session, 'subagents');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `agent-${agentId}.jsonl`);
    writeFileSync(file, assistantLine('msg1', { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));

    await post({ session_id: session, cwd: CWD, hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: file } as HookPayload);
    await wait(160);
    const baseline = app.diContainer.cradle.agentsRepository.get(agentId);
    if (!baseline) throw new Error('setup failed: agent row missing');
    expect(baseline.usage).toMatchObject({ inputTokens: 3, outputTokens: 7 });

    // Simulate the agent having already lingered past `agents.doneLingerSec` and been taken off the
    // floor (what `agentsService.remove()` does), without waiting on the real timer.
    app.diContainer.cradle.agentsRepository.upsert({ ...baseline, removed: true });
    app.diContainer.cradle.bus.emit('agent.removed', { id: agentId, projectId: baseline.projectId });

    // The transcript keeps growing after removal (a late/racing write), and another hook for the same
    // agent_id arrives (SubagentStop is deliberately excluded from agents' own "resumed" un-remove
    // logic, so `removed` stays true here).
    appendFileSync(file, assistantLine('msg2', { input_tokens: 5_000, output_tokens: 5_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    await post({ session_id: session, cwd: CWD, hook_event_name: 'SubagentStop', agent_id: agentId, agent_transcript_path: file, last_assistant_message: 'done' } as HookPayload);
    await wait(160);

    const after = app.diContainer.cradle.agentsRepository.get(agentId);
    expect(after?.removed).toBe(true);
    expect(after?.usage).toMatchObject({ inputTokens: 3, outputTokens: 7 }); // unchanged: msg2 never applied
  });
});
