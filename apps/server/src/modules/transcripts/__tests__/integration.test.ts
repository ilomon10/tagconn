import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, ClientToServerEvents, HookPayload, OfficeSnapshot, ServerToClientEvents } from '@tagconn/shared';
import { OFFICE_NAMESPACE } from '@tagconn/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp, makeTempDir } from '../../../../test/helpers.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SESSION = 'ts-integration-session';
const AGENT_ID = 'sub-agent-1';
const CWD = '/tmp/ts-integration-project';
const SLUG = '-tmp-ts-integration-project'; // arbitrary; only resolveHookTranscriptPath's marker split matters

const assistantLine = (id: string, usage: Record<string, number>, model: string) =>
  `${JSON.stringify({ type: 'assistant', message: { id, model, usage } })}\n`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('transcripts: reads token usage from JSONL and mirrors it onto agent/session usage', () => {
  let app: App | undefined;
  let socket: ClientSocket | undefined;

  afterEach(async () => {
    socket?.disconnect();
    await app?.close();
    app = socket = undefined;
  });

  it('tracks main + subagent usage incrementally, forces a final read on SubagentStop/SessionEnd, and broadcasts agent:upsert', async () => {
    const projectsDir = join(makeTempDir(), 'projects');
    mkdirSync(projectsDir, { recursive: true });
    app = await buildTestApp({ settings: { paths: { projectsDir }, transcripts: { debounceMs: 100 } } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const client: ClientSocket = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, { transports: ['websocket'], forceNew: true });
    socket = client;
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });
    await new Promise<void>((resolve) => client.emit('office:subscribe', '*', () => resolve()));

    // Real transcript files, laid out exactly like Claude Code writes them under projectsDir.
    const projectDir = join(projectsDir, SLUG);
    mkdirSync(projectDir, { recursive: true });
    const mainLocalPath = join(projectDir, `${SESSION}.jsonl`);
    const subDir = join(projectDir, SESSION, 'subagents');
    mkdirSync(subDir, { recursive: true });
    const subLocalPath = join(subDir, `agent-${AGENT_ID}.jsonl`);

    // What the hook actually reports: a host-style path that doesn't exist on this filesystem, forcing
    // the projectsDir-mapping branch of resolveHookTranscriptPath (as under Docker).
    const hostMainPath = `/home/testuser/.claude/projects/${SLUG}/${SESSION}.jsonl`;
    const hostSubPath = `/home/testuser/.claude/projects/${SLUG}/${SESSION}/subagents/agent-${AGENT_ID}.jsonl`;

    writeFileSync(mainLocalPath, assistantLine('main-msg-1', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'claude-opus-5'));

    const post = (payload: HookPayload) => app!.inject({ method: 'POST', url: '/api/hooks', payload });

    await post({ session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart', transcript_path: hostMainPath } as HookPayload);

    const mainUsageUpsert = new Promise<Agent>((resolve) => {
      const handler = (a: Agent) => {
        if (a.id === `main:${SESSION}` && a.usage) {
          client.off('agent:upsert', handler);
          resolve(a);
        }
      };
      client.on('agent:upsert', handler);
    });
    await post({ session_id: SESSION, cwd: CWD, hook_event_name: 'UserPromptSubmit', transcript_path: hostMainPath, prompt: 'do things' } as HookPayload);

    const mainAgentUpserted = await mainUsageUpsert;
    expect(mainAgentUpserted.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, messages: 1, model: 'claude-opus-5' });

    let snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === `main:${SESSION}`)?.usage).toMatchObject({ inputTokens: 10, outputTokens: 20 });
    expect(snap.sessions.find((s) => s.id === SESSION)?.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, messages: 1 });

    // Spawn a subagent; its transcript exists before the events that make us track/read it.
    writeFileSync(subLocalPath, assistantLine('sub-msg-1', { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'claude-haiku-5'));

    await post({
      session_id: SESSION,
      cwd: CWD,
      hook_event_name: 'PreToolUse',
      transcript_path: hostMainPath,
      tool_name: 'Agent',
      tool_use_id: 'tool-1',
      tool_input: { description: 'sub task', subagent_type: 'general-purpose' },
    } as HookPayload);
    await post({ session_id: SESSION, cwd: CWD, hook_event_name: 'SubagentStart', transcript_path: hostMainPath, agent_id: AGENT_ID, agent_type: 'general-purpose' } as HookPayload);
    await post({ session_id: SESSION, cwd: CWD, hook_event_name: 'PreToolUse', transcript_path: hostMainPath, agent_id: AGENT_ID, tool_name: 'Bash' } as HookPayload);
    await post({ session_id: SESSION, cwd: CWD, hook_event_name: 'PostToolUse', transcript_path: hostMainPath, agent_id: AGENT_ID, tool_name: 'Bash' } as HookPayload);

    await wait(160); // past the 100ms debounce
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === AGENT_ID)?.usage).toMatchObject({ inputTokens: 3, outputTokens: 7, messages: 1 });
    expect(snap.sessions.find((s) => s.id === SESSION)?.usage).toMatchObject({
      inputTokens: 13,
      outputTokens: 27,
      messages: 2,
      model: 'claude-opus-5', // session.usage.model/contextTokens come from the MAIN agent, not the latest write
    });

    // Append more lines to both files; SubagentStop must force one final synchronous read (no debounce wait).
    appendFileSync(mainLocalPath, assistantLine('main-msg-2', { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'claude-opus-5'));
    appendFileSync(subLocalPath, assistantLine('sub-msg-2', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'claude-haiku-5'));

    await post({
      session_id: SESSION,
      cwd: CWD,
      hook_event_name: 'SubagentStop',
      transcript_path: hostMainPath,
      agent_id: AGENT_ID,
      agent_transcript_path: hostSubPath,
      last_assistant_message: 'done',
    } as HookPayload);

    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === AGENT_ID)?.usage).toMatchObject({ inputTokens: 4, outputTokens: 9, messages: 2 });

    await post({ session_id: SESSION, cwd: CWD, hook_event_name: 'Stop', transcript_path: hostMainPath } as HookPayload);
    await post({ session_id: SESSION, cwd: CWD, hook_event_name: 'SessionEnd', transcript_path: hostMainPath } as HookPayload);

    // SessionEnd also forces a final synchronous read (of the main transcript here) before untracking.
    snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === `main:${SESSION}`)?.usage).toMatchObject({ inputTokens: 14, outputTokens: 26, messages: 2 });
    expect(snap.sessions.find((s) => s.id === SESSION)?.usage).toMatchObject({ inputTokens: 18, outputTokens: 35, messages: 4 });
  });

  it('does not track or read transcripts when transcripts.enabled is false', async () => {
    const projectsDir = join(makeTempDir(), 'projects');
    mkdirSync(projectsDir, { recursive: true });
    app = await buildTestApp({ settings: { paths: { projectsDir }, transcripts: { enabled: false, debounceMs: 100 } } });
    const projectDir = join(projectsDir, SLUG);
    mkdirSync(projectDir, { recursive: true });
    const mainLocalPath = join(projectDir, `${SESSION}.jsonl`);
    writeFileSync(mainLocalPath, assistantLine('main-msg-1', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'claude-opus-5'));
    const hostMainPath = `/home/testuser/.claude/projects/${SLUG}/${SESSION}.jsonl`;

    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart', transcript_path: hostMainPath } as HookPayload,
    });
    await wait(160);
    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.agents.find((a) => a.id === `main:${SESSION}`)?.usage).toBeUndefined();
  });
});
