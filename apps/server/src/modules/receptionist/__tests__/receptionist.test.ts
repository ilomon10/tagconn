import { OFFICE_NAMESPACE, type Project, type RunStartCommand } from '@tagconn/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { adminHeaders, adminSocketAuth, buildTestApp } from '../../../../test/helpers.js';
import { HttpError } from '../../../core/http/index.js';
import { connectVerifiedRunner, type FakeRunner } from '../../runs/__tests__/fake-runner.js';

const TOKEN = 'c'.repeat(40);
const ALLOWED_ROOT = '/tmp/receptionist-allowed';
const IN_PROJECT: Project = { id: 'proj-in', cwd: `${ALLOWED_ROOT}/repo`, name: 'In-scope', archived: false, createdAt: Date.now(), lastActivityAt: Date.now() };
const OUT_PROJECT: Project = { id: 'proj-out', cwd: '/tmp/somewhere-else/repo', name: 'Out-of-scope', archived: false, createdAt: Date.now(), lastActivityAt: Date.now() };

async function withProjects(app: App): Promise<void> {
  app.diContainer.cradle.projectsRepository.upsert(IN_PROJECT);
  app.diContainer.cradle.projectsRepository.upsert(OUT_PROJECT);
}

describe('receptionist module (M8 8l, S3)', () => {
  let app: App | undefined;
  let runner: FakeRunner | undefined;
  afterEach(async () => {
    runner?.close();
    await app?.close();
    app = runner = undefined;
  });

  // ---------------------------------------------------------------- enabled gate

  it('receptionist.enabled=false refuses every operation (404-shaped)', async () => {
    app = await buildTestApp({ settings: { receptionist: { enabled: false } } });
    const { receptionistService } = app.diContainer.cradle;
    expect(() => receptionistService.list()).toThrow(HttpError);
    expect(() => receptionistService.create({ scope: 'general' }, 'tester')).toThrow(/not found/i);

    const res = await app.inject({ method: 'GET', url: '/api/receptionist/conversations', headers: adminHeaders(app) });
    expect(res.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------- scope rules

  it('scope "project" is refused for an unregistered project', async () => {
    app = await buildTestApp({ settings: { runner: { allowedProjectDirs: [ALLOWED_ROOT] } } });
    const { receptionistService } = app.diContainer.cradle;
    expect(() => receptionistService.create({ scope: 'project', projectId: 'no-such-project' }, 'tester')).toThrow(HttpError);
  });

  it('scope "project" is refused when the registered project\'s cwd is outside runner.allowedProjectDirs', async () => {
    app = await buildTestApp({ settings: { runner: { allowedProjectDirs: [ALLOWED_ROOT] } } });
    await withProjects(app);
    const { receptionistService } = app.diContainer.cradle;
    expect(() => receptionistService.create({ scope: 'project', projectId: OUT_PROJECT.id }, 'tester')).toThrow(/outside/i);
  });

  it('scope "project" succeeds for a registered project inside runner.allowedProjectDirs', async () => {
    app = await buildTestApp({ settings: { runner: { allowedProjectDirs: [ALLOWED_ROOT] } } });
    await withProjects(app);
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'project', projectId: IN_PROJECT.id }, 'tester');
    expect(conversation.scope).toBe('project');
    expect(conversation.projectId).toBe(IN_PROJECT.id);
  });

  it('scope "general" rejects a projectId', async () => {
    app = await buildTestApp();
    const { receptionistService } = app.diContainer.cradle;
    expect(() => receptionistService.create({ scope: 'general', projectId: 'anything' }, 'tester')).toThrow(HttpError);
  });

  it('send() re-checks project scope allow-list at send time, not just at create time', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN, allowedProjectDirs: [ALLOWED_ROOT] } } });
    await withProjects(app);
    const { receptionistService, projectsRepository } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'project', projectId: IN_PROJECT.id }, 'tester');
    // The project's registered cwd moves outside the allowlist after the conversation was created
    // (runner.allowedProjectDirs is GUI-immutable, so this is the realistic way the check can change).
    projectsRepository.upsert({ ...IN_PROJECT, cwd: '/tmp/somewhere-else-entirely/repo' });
    expect(() => receptionistService.send({ conversationId: conversation.id, text: 'hi' }, 'tester')).toThrow(/outside/i);
  });

  // ---------------------------------------------------------------- bounds

  it('receptionist.maxConversations: creating over the cap evicts the oldest non-busy conversation', async () => {
    app = await buildTestApp({ settings: { receptionist: { maxConversations: 2 } } });
    const { receptionistService } = app.diContainer.cradle;
    const a = receptionistService.create({ scope: 'general', title: 'A' }, 'tester');
    await new Promise((r) => setTimeout(r, 5));
    const b = receptionistService.create({ scope: 'general', title: 'B' }, 'tester');
    await new Promise((r) => setTimeout(r, 5));
    const c = receptionistService.create({ scope: 'general', title: 'C' }, 'tester'); // over cap: evicts A (oldest, not busy)

    const ids = receptionistService.list().map((x) => x.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id);
  });

  it('receptionist.maxMessagesPerConversation: sending prunes the oldest messages past the cap', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN }, receptionist: { maxMessagesPerConversation: 2 } } });
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');

    receptionistService.send({ conversationId: conversation.id, text: 'first' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));
    // First turn's run never ends in this test, so send() on the same conversation would 409;
    // simulate the run ending so a second turn can start.
    const first = app.diContainer.cradle.runsService.list({ limit: 10 })[0]!;
    runner.sendEnd({ runId: first.id, status: 'succeeded', reason: 'exit', exitCode: 0, signal: null });
    await new Promise((r) => setTimeout(r, 40));

    receptionistService.send({ conversationId: conversation.id, text: 'second' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));

    const { messages } = receptionistService.get(conversation.id);
    expect(messages.length).toBeLessThanOrEqual(2);
    expect(messages.some((m) => m.text.includes('first'))).toBe(false); // pruned
    expect(messages.some((m) => m.text.includes('second'))).toBe(true);
  });

  // ---------------------------------------------------------------- one turn at a time

  it('send() while the conversation is busy is refused with 409', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN } } });
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');

    receptionistService.send({ conversationId: conversation.id, text: 'first' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));
    expect(receptionistService.get(conversation.id).conversation.busy).toBe(true);
    expect(() => receptionistService.send({ conversationId: conversation.id, text: 'second' }, 'tester')).toThrow(/turn in flight/i);
  });

  it('busy clears once the run ends, allowing the next turn', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN } } });
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');

    const msg = receptionistService.send({ conversationId: conversation.id, text: 'first' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));
    runner.sendEnd({ runId: msg.runId!, status: 'succeeded', reason: 'exit', exitCode: 0, signal: null });
    await new Promise((r) => setTimeout(r, 40));

    expect(receptionistService.get(conversation.id).conversation.busy).toBe(false);
    expect(() => receptionistService.send({ conversationId: conversation.id, text: 'second' }, 'tester')).not.toThrow();
  });

  // ---------------------------------------------------------------- webFetch domain passing rules

  it('webFetch domains are only ever sent for general scope, and only when receptionist.webFetch is "allowlist"', async () => {
    app = await buildTestApp({
      settings: {
        runner: { enabled: true, token: TOKEN, allowedProjectDirs: [ALLOWED_ROOT] },
        receptionist: { webFetch: 'allowlist', webFetchAllowDomains: ['example.com'] },
      },
    });
    await withProjects(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    const commands: RunStartCommand[] = [];
    runner.onStart((cmd, ack) => {
      commands.push(cmd);
      ack({ ok: true, data: { pid: 1 } });
    });
    const { receptionistService } = app.diContainer.cradle;

    const general = receptionistService.create({ scope: 'general' }, 'tester');
    receptionistService.send({ conversationId: general.id, text: 'general question' }, 'tester');
    const project = receptionistService.create({ scope: 'project', projectId: IN_PROJECT.id }, 'tester');
    receptionistService.send({ conversationId: project.id, text: 'project question' }, 'tester');
    await new Promise((r) => setTimeout(r, 60));

    expect(commands).toHaveLength(2);
    const generalCmd = commands.find((c) => c.projectDir === null)!;
    const projectCmd = commands.find((c) => c.projectDir !== null)!;
    expect(generalCmd.webFetchDomains).toEqual(['example.com']);
    expect(projectCmd.webFetchDomains).toEqual([]); // project scope: always --restricted, never WebFetch
  });

  it('webFetch domains are never sent when receptionist.webFetch is "never" (the default), even in general scope', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN } } });
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    let captured: RunStartCommand | undefined;
    runner.onStart((cmd, ack) => {
      captured = cmd;
      ack({ ok: true, data: { pid: 1 } });
    });
    const { receptionistService } = app.diContainer.cradle;
    const general = receptionistService.create({ scope: 'general' }, 'tester');
    receptionistService.send({ conversationId: general.id, text: 'hi' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));
    expect(captured?.webFetchDomains).toEqual([]);
  });

  // ---------------------------------------------------------------- resume id stored

  it('stores the runner-created session id from `init` on the conversation, for the next --resume', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN } } });
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    const commands: RunStartCommand[] = [];
    runner.onStart((cmd, ack) => {
      commands.push(cmd);
      ack({ ok: true, data: { pid: 1 } });
    });
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');
    const msg = receptionistService.send({ conversationId: conversation.id, text: 'first' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));
    expect(commands[0]?.resumeSessionId).toBeUndefined(); // nothing to resume yet

    const sessionId = 'a'.repeat(40);
    runner.sendEvent({ runId: msg.runId!, seq: 1, ts: Date.now(), event: { kind: 'init', sessionId, tools: ['Read', 'Grep', 'Glob'], mcpServers: [] } });
    await new Promise((r) => setTimeout(r, 40));
    expect(receptionistService.get(conversation.id).conversation.sessionId).toBe(sessionId);

    runner.sendEnd({ runId: msg.runId!, status: 'succeeded', reason: 'exit', exitCode: 0, signal: null });
    await new Promise((r) => setTimeout(r, 40));
    receptionistService.send({ conversationId: conversation.id, text: 'follow up' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));
    expect(commands).toHaveLength(2);
    expect(commands[1]?.resumeSessionId).toBe(sessionId); // the follow-up turn resumes the stored session
  });

  // ---------------------------------------------------------------- streaming + redaction

  it('accumulates streamed assistant text onto the message and finalizes it from the result event', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN } } });
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');
    const userMsg = receptionistService.send({ conversationId: conversation.id, text: 'hi' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));

    runner.sendEvent({ runId: userMsg.runId!, seq: 1, ts: Date.now(), event: { kind: 'text', partial: true, text: 'Hel' } });
    runner.sendEvent({ runId: userMsg.runId!, seq: 2, ts: Date.now(), event: { kind: 'text', partial: true, text: 'lo!' } });
    await new Promise((r) => setTimeout(r, 40));
    let { messages } = receptionistService.get(conversation.id);
    const assistant = messages.find((m) => m.role === 'assistant')!;
    expect(assistant.text).toBe('Hello!');

    runner.sendEvent({
      runId: userMsg.runId!,
      seq: 3,
      ts: Date.now(),
      event: { kind: 'result', subtype: 'success', isError: false, text: 'Hello! Final.', costUsd: 0.01 },
    });
    await new Promise((r) => setTimeout(r, 40));
    ({ messages } = receptionistService.get(conversation.id));
    expect(messages.find((m) => m.role === 'assistant')!.text).toBe('Hello! Final.');
  });

  it('redacts a secret in the user message text and in streamed assistant text', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN } } });
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');
    const userMsg = receptionistService.send({ conversationId: conversation.id, text: 'my api_key: sk-verysecretvalue1234' }, 'tester');
    expect(userMsg.text).not.toContain('sk-verysecretvalue1234');

    runner.sendEvent({
      runId: userMsg.runId!,
      seq: 1,
      ts: Date.now(),
      event: { kind: 'text', partial: false, text: 'here is a token: Bearer sk-anothersecret9999' },
    });
    await new Promise((r) => setTimeout(r, 40));
    const { messages } = receptionistService.get(conversation.id);
    const assistant = messages.find((m) => m.role === 'assistant')!;
    expect(assistant.text).not.toContain('sk-anothersecret9999');
  });

  it('a rejected/failed turn leaves a non-empty fallback message instead of a blank one', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN } } });
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');
    const userMsg = receptionistService.send({ conversationId: conversation.id, text: 'hi' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));
    runner.sendEnd({ runId: userMsg.runId!, status: 'failed', reason: 'spawn_failed', exitCode: null, signal: null, message: 'boom' });
    await new Promise((r) => setTimeout(r, 40));
    const { conversation: updated, messages } = receptionistService.get(conversation.id);
    expect(updated.busy).toBe(false);
    expect(messages.find((m) => m.role === 'assistant')!.text.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- stop / delete

  it('stop() asks the runner to stop the conversation\'s active run', async () => {
    app = await buildTestApp({ settings: { runner: { enabled: true, token: TOKEN } } });
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const stopped = new Promise<string>((resolve) => runner!.onStop((cmd) => resolve(cmd.runId)));
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');
    const msg = receptionistService.send({ conversationId: conversation.id, text: 'hi' }, 'tester');
    await new Promise((r) => setTimeout(r, 40));
    receptionistService.stop(conversation.id);
    await expect(stopped).resolves.toBe(msg.runId);
  });

  it('stop() on a non-busy conversation is a no-op', async () => {
    app = await buildTestApp();
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');
    expect(() => receptionistService.stop(conversation.id)).not.toThrow();
  });

  it('delete() removes the conversation and its messages', async () => {
    app = await buildTestApp();
    const { receptionistService } = app.diContainer.cradle;
    const conversation = receptionistService.create({ scope: 'general' }, 'tester');
    receptionistService.delete(conversation.id);
    expect(() => receptionistService.get(conversation.id)).toThrow(/not found/i);
  });

  // ---------------------------------------------------------------- access gating (S1)

  it('REST: every /api/receptionist* route needs an admin session', async () => {
    app = await buildTestApp();
    const noAuth = await app.inject({ method: 'GET', url: '/api/receptionist/conversations' });
    expect(noAuth.statusCode).toBe(401);

    const created = await app.inject({
      method: 'POST',
      url: '/api/receptionist/conversations',
      payload: { scope: 'general' },
      headers: adminHeaders(app),
    });
    expect(created.statusCode).toBe(201);

    const authed = await app.inject({ method: 'GET', url: '/api/receptionist/conversations', headers: adminHeaders(app) });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toHaveLength(1);
  });

  it('socket: receptionist:* events are gated even though they are not in the writes list (S1 default-gating)', async () => {
    app = await buildTestApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`;

    // A denied (unauthenticated) packet never reaches the handler at all (core/realtime/admin-guard.ts'
    // `socket.use` calls `next(new Error(...))`, which never invokes the ack) — so, like
    // admin-guard.test.ts, "the ack never arrives within a short window" IS the assertion here.
    const anon: Socket = connect(base, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve, reject) => {
      anon.on('connect', () => resolve());
      anon.on('connect_error', reject);
    });
    const anonOutcome = await new Promise<'acked' | 'timed-out'>((resolve) => {
      const timer = setTimeout(() => resolve('timed-out'), 300);
      anon.emit('receptionist:list', () => {
        clearTimeout(timer);
        resolve('acked');
      });
    });
    expect(anonOutcome).toBe('timed-out');
    anon.disconnect();

    const admin: Socket = connect(base, { transports: ['websocket'], forceNew: true, auth: adminSocketAuth(app) });
    await new Promise<void>((resolve, reject) => {
      admin.on('connect', () => resolve());
      admin.on('connect_error', reject);
    });
    const adminAck = await new Promise<{ ok: boolean; data?: unknown }>((resolve) => admin.emit('receptionist:list', resolve));
    expect(adminAck.ok).toBe(true);
    admin.disconnect();
  });
});
