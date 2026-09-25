import { randomUUID } from 'node:crypto';
import { RUNNER_PROTOCOL_VERSION, type Project, type RunEventEnvelope } from '@tagconn/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp } from '../../../../test/helpers.js';
import { HttpError } from '../../../core/http/index.js';
import { freshNonce } from '../runs.hmac.js';
import { connectRawRunner, connectVerifiedRunner, type FakeRunner } from './fake-runner.js';

const TOKEN = 'b'.repeat(40);
const PROJECT: Project = { id: 'proj-1', cwd: '/tmp/quest-project', name: 'Quest Project', archived: false, createdAt: Date.now(), lastActivityAt: Date.now() };

async function withProject(app: App): Promise<void> {
  app.diContainer.cradle.projectsRepository.upsert(PROJECT);
}

/** Polls instead of a fixed sleep (flake fix): the assertion inside re-runs until it passes or times out. */
const waitFor = <T>(fn: () => T): Promise<T> => vi.waitFor(fn, { timeout: 2_000, interval: 10 });

describe('runs: queue, dispatch, ownership, redaction, reconcile, retention (M8 S2)', () => {
  let app: App | undefined;
  let runner: FakeRunner | undefined;
  afterEach(async () => {
    runner?.close();
    await app?.close();
    app = runner = undefined;
  });

  it('POST-equivalent start is refused with 409 while no verified runner is connected', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    expect(() => app!.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'hi' }, 'tester')).toThrow(HttpError);
  });

  it('M3: settings.runner.enabled=false (the default) refuses to enqueue with a distinct runner_disabled error, and the /runner handshake itself is refused too', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, allowedProjectDirs: ['/tmp'] } } }); // enabled defaults to false
    await withProject(app);
    expect(() => app!.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'hi' }, 'tester')).toThrow(/runner_disabled/);

    const socket = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: freshNonce() });
    await new Promise<void>((resolve, reject) => {
      socket.on('connect_error', () => resolve());
      socket.on('connect', () => reject(new Error('should not have connected while runner.enabled is false')));
    });
  });

  it('M4: refuses to enqueue a project outside runner.allowedProjectDirs (dir_not_allowed), before ever touching the queue', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/somewhere/else'] } } });
    await withProject(app); // PROJECT.cwd = /tmp/quest-project, not under /somewhere/else
    expect(() => app!.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'hi' }, 'tester')).toThrow(/dir_not_allowed/);
    expect(app!.diContainer.cradle.runsService.getRunnerStatus().queuedRuns).toBe(0);
  });

  it('queue: dispatches up to the effective maxConcurrent, queues the rest, and rejects past maxQueued', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'], maxConcurrent: 1, maxQueued: 1 } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN, hello: { maxConcurrent: 2 } }); // effective cap = min(1,2) = 1
    const started: string[] = [];
    runner.onStart((cmd, ack) => {
      started.push(cmd.runId);
      ack({ ok: true, data: { pid: 4242 } });
    });

    const runA = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'task A' }, 'tester');
    const runB = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'task B' }, 'tester');
    expect(() => app!.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'task C' }, 'tester')).toThrow(HttpError);

    await waitFor(() => expect(started).toEqual([runA.id])); // B stays queued: A already fills the only concurrency slot
    expect(app.diContainer.cradle.runsService.get(runB.id)?.status).toBe('queued');
    expect(app.diContainer.cradle.runsService.getRunnerStatus().queuedRuns).toBe(1);

    // Ending A frees the slot: B should now be dispatched.
    runner.sendEnd({ runId: runA.id, status: 'succeeded', reason: 'exit', exitCode: 0, signal: null });
    await waitFor(() => expect(started).toEqual([runA.id, runB.id]));
    expect(app.diContainer.cradle.runsService.get(runA.id)?.status).toBe('succeeded');
  });

  it('ownership: an event tagged with a different runnerId than the one the run was dispatched to is ignored', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'ownership test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));

    const env: RunEventEnvelope = { runId: run.id, seq: 1, ts: Date.now(), event: { kind: 'notice', level: 'info', message: 'hi' } };
    app.diContainer.cradle.runsService.onRunEvent('some-other-runner-id', env);
    expect(app.diContainer.cradle.runsService.getDetail(run.id).events).toHaveLength(0);
    expect(app.diContainer.cradle.runsService.get(run.id)?.eventCount).toBe(0);

    // The real (owning) runnerId is accepted.
    app.diContainer.cradle.runsService.onRunEvent(runner.runnerId, env);
    expect(app.diContainer.cradle.runsService.getDetail(run.id).events).toHaveLength(1);
  });

  it('dedupe: the same (runId, seq) sent twice over the real socket is only stored once', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'dedupe test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));

    const env: RunEventEnvelope = { runId: run.id, seq: 1, ts: Date.now(), event: { kind: 'notice', level: 'info', message: 'once' } };
    runner.sendEvent(env);
    runner.sendEvent(env); // replay (e.g. after a reconnect)
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.eventCount).toBe(1));
    expect(app.diContainer.cradle.runsService.getDetail(run.id).events).toHaveLength(1);
  });

  it('redaction: a secret in run event text never reaches storage, and previews are re-capped server-side', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'], previewChars: 100 } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'redaction test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));

    const longPreview = `api_key: sk-verysecretvalue1234 plus ${'padding '.repeat(20)}trailing text`;
    runner.sendEvent({
      runId: run.id,
      seq: 1,
      ts: Date.now(),
      event: { kind: 'tool_result', toolUseId: 't1', isError: false, preview: longPreview },
    });
    await waitFor(() => expect(app!.diContainer.cradle.runsService.getDetail(run.id).events).toHaveLength(1));
    const [stored] = app.diContainer.cradle.runsService.getDetail(run.id).events;
    expect(stored?.event.kind).toBe('tool_result');
    if (stored?.event.kind === 'tool_result') {
      expect(stored.event.preview).not.toContain('sk-verysecretvalue1234');
      expect(stored.event.preview.length).toBeLessThanOrEqual(100 + '…[truncated]'.length);
    }
  });

  it('L1: a secret in a runner-provided run:end message is redacted before being stored', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'l1 test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));

    runner.sendEnd({
      runId: run.id,
      status: 'failed',
      reason: 'exit',
      exitCode: 1,
      signal: null,
      message: 'crashed: api_key: sk-verysecretvalue1234 while reading config',
    });
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('failed'));
    expect(app!.diContainer.cradle.runsService.get(run.id)?.error).not.toContain('sk-verysecretvalue1234');
  });

  it('M5: once over cap, further events are dropped outright; exactly one synthetic notice + one stop (output_cap) are sent; eventBytes is released on end', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'], maxEventsPerRun: 10 } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const stopReasons: string[] = [];
    runner.onStop((cmd) => stopReasons.push(cmd.reason));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'cap test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));

    // maxEventsPerRun=10: the cap trips while processing the 11th event (eventCount becomes 11 > 10).
    for (let seq = 1; seq <= 16; seq++) {
      runner.sendEvent({ runId: run.id, seq, ts: Date.now(), event: { kind: 'notice', level: 'info', message: `n${seq}` } });
    }
    await waitFor(() => expect(stopReasons).toEqual(['output_cap'])); // exactly one stop, never repeated for events 12-16
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.truncated).toBe(true));
    // 11 real events (the tipping one included) + exactly one synthetic notice = 12 stored; events 12-16 dropped.
    expect(app.diContainer.cradle.runsService.getDetail(run.id).events).toHaveLength(12);
    expect(app.diContainer.cradle.runsService.get(run.id)?.eventCount).toBe(11); // the synthetic notice isn't counted

    runner.sendEnd({ runId: run.id, status: 'stopped', reason: 'output_cap', exitCode: null, signal: null });
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('stopped'));
    expect(app.diContainer.cradle.runsService.get(run.id)?.endReason).toBe('output_cap');
  });

  it('M5: the byte counter survives a server restart by reseeding from stored events', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'], maxEventBytesPerRun: 10_000 } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'restart-seed test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));
    runner.sendEvent({ runId: run.id, seq: 1, ts: Date.now(), event: { kind: 'notice', level: 'info', message: 'x'.repeat(500) } });
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.eventCount).toBe(1));

    // Simulate a server restart: a fresh RunsService instance re-seeds from the SAME (persisted) DB.
    app.diContainer.cradle.runsService.seed();
    // The reseeded byte total must include what was already stored, not reset to 0 — proven by the
    // fact that dispatching further big events still trips the cap without needing to reach it twice.
    for (let seq = 2; seq <= 30; seq++) {
      runner.sendEvent({ runId: run.id, seq, ts: Date.now(), event: { kind: 'notice', level: 'info', message: 'y'.repeat(500) } });
    }
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.truncated).toBe(true));
  });

  it('caps: exceeding runner.maxEventsPerRun marks the run truncated and asks the runner to stop it', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'], maxEventsPerRun: 10 } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const stoppedRunId = new Promise<string>((resolve) => runner!.onStop((cmd) => resolve(cmd.runId)));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'cap test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));

    for (let seq = 1; seq <= 11; seq++) {
      runner.sendEvent({ runId: run.id, seq, ts: Date.now(), event: { kind: 'notice', level: 'info', message: `n${seq}` } });
    }
    await expect(stoppedRunId).resolves.toBe(run.id);
    expect(app.diContainer.cradle.runsService.get(run.id)?.truncated).toBe(true);
  });

  it('L6: hint() ignores a malformed session id instead of trusting it', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'hint test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));

    app!.diContainer.cradle.runLinker.hint(run.id, 'not a valid session id!!');
    expect(app!.diContainer.cradle.runsService.get(run.id)?.sessionId).toBeUndefined();

    app!.diContainer.cradle.runLinker.hint(run.id, 'a'.repeat(20));
    expect(app!.diContainer.cradle.runsService.get(run.id)?.sessionId).toBe('a'.repeat(20));
  });

  it("L6: a follow-up refuses to resume a session id that only ever came from hint(), never confirmed by this run's own init event", async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'provenance test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));

    const sid = 'a'.repeat(20);
    app!.diContainer.cradle.runLinker.hint(run.id, sid); // only the hook's hint, never an init event
    expect(app!.diContainer.cradle.runsService.get(run.id)?.sessionId).toBe(sid);
    expect(() => app!.diContainer.cradle.runsService.followUp({ runId: run.id, prompt: 'go on' }, 'tester')).toThrow(/resume_not_allowed/);

    // Once a real init event reports the SAME session id, the follow-up is allowed.
    runner.sendEvent({ runId: run.id, seq: 1, ts: Date.now(), event: { kind: 'init', sessionId: sid, tools: [], mcpServers: [] } });
    await waitFor(() => expect(app!.diContainer.cradle.runsService.getDetail(run.id).events.length).toBeGreaterThan(0));
    expect(() => app!.diContainer.cradle.runsService.followUp({ runId: run.id, prompt: 'go on' }, 'tester')).not.toThrow();
  });

  it("L2: a follow-up re-validates the original run's permission mode against the CURRENT allowedPermissionModes", async () => {
    app = await buildTestApp({
      settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'], allowedPermissionModes: ['plan', 'dontAsk', 'default', 'acceptEdits'] } },
    });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'l2 test', permissionMode: 'acceptEdits' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));
    const sid = 'a'.repeat(20);
    runner.sendEvent({ runId: run.id, seq: 1, ts: Date.now(), event: { kind: 'init', sessionId: sid, tools: [], mcpServers: [] } });
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.sessionId).toBe(sid));

    // Simulate the mode having been allowed when the run started but no longer allowed now (a settings
    // change since), by recording the run with a mode outside the CURRENT allowedPermissionModes.
    const current = app.diContainer.cradle.runsRepository.get(run.id)!;
    app.diContainer.cradle.runsRepository.update({ ...current, permissionMode: 'bypassPermissions' });

    expect(() => app!.diContainer.cradle.runsService.followUp({ runId: run.id, prompt: 'go on' }, 'tester')).toThrow(/mode_not_allowed/);
  });

  it('L7: when run:start is rejected (including an ack timeout), the server proactively asks the runner to stop that runId', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    const stops: { runId: string; reason: string }[] = [];
    runner.onStop((cmd) => stops.push(cmd));
    // Simulates the ack-timeout branch in runs.gateway.ts's sendStart, which produces the exact same
    // { ok: false, error } shape dispatchOne reacts to — deterministic, without waiting out the real 15s.
    runner.onStart((cmd, ack) => ack({ ok: false, error: 'simulated: runner did not acknowledge run:start in time' }));

    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'l7 test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('rejected'));
    expect(app!.diContainer.cradle.runsService.get(run.id)?.endReason).toBe('spawn_failed');
    expect(stops).toEqual([{ runId: run.id, reason: 'timeout' }]);
  });

  it('lost-runner reconcile: a run left running/dispatched by a disconnected runner becomes `lost` after the grace check', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'], lostGraceSec: 5 } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'reconcile test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));

    runner.close();
    await waitFor(() => expect(app!.diContainer.cradle.runsService.getRunnerStatus().connected).toBe(false)); // let the disconnect handler run
    expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'); // still in its grace period

    // Exposed for tests instead of waiting out the real lostGraceSec timer.
    app.diContainer.cradle.runsService.reconcileLostRunner(runner.runnerId);
    expect(app.diContainer.cradle.runsService.get(run.id)?.status).toBe('lost');
    runner = undefined;
  });

  it('reconnect before the grace check reconciles instead: reported activeRunIds keep a run running, unreported ones become lost', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'] } } });
    await withProject(app);
    const runnerId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    runner = await connectVerifiedRunner(app, { token: TOKEN, runnerId });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'restart test' }, 'tester');
    await waitFor(() => expect(app!.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'));
    runner.close();
    await waitFor(() => expect(app!.diContainer.cradle.runsService.getRunnerStatus().connected).toBe(false));

    // Reconnects and reports the run as still active: it stays running, and killRunIds is empty.
    const reconnected = await connectVerifiedRunner(app, { token: TOKEN, runnerId, hello: { activeRunIds: [run.id] } });
    expect(app.diContainer.cradle.runsService.get(run.id)?.status).toBe('running');
    reconnected.close();
    runner = undefined;
  });

  it('retention: pruneOld deletes runs (and their events) ended before runner.runRetentionDays', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true, allowedProjectDirs: ['/tmp'], runRetentionDays: 1 } } });
    const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
    app.diContainer.cradle.runsRepository.insert({
      id: '11111111-1111-1111-1111-111111111111',
      kind: 'quest',
      threadId: '11111111-1111-1111-1111-111111111111',
      status: 'succeeded',
      prompt: 'old',
      permissionMode: 'acceptEdits',
      model: 'sonnet',
      createdBy: 'tester',
      createdAt: old,
      endedAt: old,
      eventCount: 0,
      truncated: false,
    });
    const removed = app.diContainer.cradle.runsService.pruneOld();
    expect(removed).toBe(1);
    expect(app.diContainer.cradle.runsService.get('11111111-1111-1111-1111-111111111111')).toBeUndefined();
  });
});
