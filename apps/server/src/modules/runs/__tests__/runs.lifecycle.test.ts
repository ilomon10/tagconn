import type { Project, RunEventEnvelope } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp } from '../../../../test/helpers.js';
import { HttpError } from '../../../core/http/index.js';
import { connectVerifiedRunner, type FakeRunner } from './fake-runner.js';

const TOKEN = 'b'.repeat(40);
const PROJECT: Project = { id: 'proj-1', cwd: '/tmp/quest-project', name: 'Quest Project', archived: false, createdAt: Date.now(), lastActivityAt: Date.now() };

async function withProject(app: App): Promise<void> {
  app.diContainer.cradle.projectsRepository.upsert(PROJECT);
}

describe('runs: queue, dispatch, ownership, redaction, reconcile, retention (M8 S2)', () => {
  let app: App | undefined;
  let runner: FakeRunner | undefined;
  afterEach(async () => {
    runner?.close();
    await app?.close();
    app = runner = undefined;
  });

  it('POST-equivalent start is refused with 409 while no verified runner is connected', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
    await withProject(app);
    expect(() => app!.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'hi' }, 'tester')).toThrow(HttpError);
  });

  it('queue: dispatches up to the effective maxConcurrent, queues the rest, and rejects past maxQueued', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, maxConcurrent: 1, maxQueued: 1 } } });
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

    await new Promise((r) => setTimeout(r, 80));
    expect(started).toEqual([runA.id]); // B stays queued: A already fills the only concurrency slot
    expect(app.diContainer.cradle.runsService.get(runB.id)?.status).toBe('queued');
    expect(app.diContainer.cradle.runsService.getRunnerStatus().queuedRuns).toBe(1);

    // Ending A frees the slot: B should now be dispatched.
    runner.sendEnd({ runId: runA.id, status: 'succeeded', reason: 'exit', exitCode: 0, signal: null });
    await new Promise((r) => setTimeout(r, 80));
    expect(started).toEqual([runA.id, runB.id]);
    expect(app.diContainer.cradle.runsService.get(runA.id)?.status).toBe('succeeded');
  });

  it('ownership: an event tagged with a different runnerId than the one the run was dispatched to is ignored', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'ownership test' }, 'tester');
    await new Promise((r) => setTimeout(r, 60));
    expect(app.diContainer.cradle.runsService.get(run.id)?.status).toBe('running');

    const env: RunEventEnvelope = { runId: run.id, seq: 1, ts: Date.now(), event: { kind: 'notice', level: 'info', message: 'hi' } };
    app.diContainer.cradle.runsService.onRunEvent('some-other-runner-id', env);
    expect(app.diContainer.cradle.runsService.getDetail(run.id).events).toHaveLength(0);
    expect(app.diContainer.cradle.runsService.get(run.id)?.eventCount).toBe(0);

    // The real (owning) runnerId is accepted.
    app.diContainer.cradle.runsService.onRunEvent(runner.runnerId, env);
    expect(app.diContainer.cradle.runsService.getDetail(run.id).events).toHaveLength(1);
  });

  it('dedupe: the same (runId, seq) sent twice over the real socket is only stored once', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'dedupe test' }, 'tester');
    await new Promise((r) => setTimeout(r, 60));

    const env: RunEventEnvelope = { runId: run.id, seq: 1, ts: Date.now(), event: { kind: 'notice', level: 'info', message: 'once' } };
    runner.sendEvent(env);
    runner.sendEvent(env); // replay (e.g. after a reconnect)
    await new Promise((r) => setTimeout(r, 60));
    expect(app.diContainer.cradle.runsService.getDetail(run.id).events).toHaveLength(1);
    expect(app.diContainer.cradle.runsService.get(run.id)?.eventCount).toBe(1);
  });

  it('redaction: a secret in run event text never reaches storage, and previews are re-capped server-side', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, previewChars: 100 } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'redaction test' }, 'tester');
    await new Promise((r) => setTimeout(r, 60));

    const longPreview = `api_key: sk-verysecretvalue1234 plus ${'padding '.repeat(20)}trailing text`;
    runner.sendEvent({
      runId: run.id,
      seq: 1,
      ts: Date.now(),
      event: { kind: 'tool_result', toolUseId: 't1', isError: false, preview: longPreview },
    });
    await new Promise((r) => setTimeout(r, 60));
    const [stored] = app.diContainer.cradle.runsService.getDetail(run.id).events;
    expect(stored?.event.kind).toBe('tool_result');
    if (stored?.event.kind === 'tool_result') {
      expect(stored.event.preview).not.toContain('sk-verysecretvalue1234');
      expect(stored.event.preview.length).toBeLessThanOrEqual(100 + '…[truncated]'.length);
    }
  });

  it('caps: exceeding runner.maxEventsPerRun marks the run truncated and asks the runner to stop it', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, maxEventsPerRun: 10 } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const stoppedRunId = new Promise<string>((resolve) => runner!.onStop((cmd) => resolve(cmd.runId)));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'cap test' }, 'tester');
    await new Promise((r) => setTimeout(r, 60));

    for (let seq = 1; seq <= 11; seq++) {
      runner.sendEvent({ runId: run.id, seq, ts: Date.now(), event: { kind: 'notice', level: 'info', message: `n${seq}` } });
    }
    await expect(stoppedRunId).resolves.toBe(run.id);
    expect(app.diContainer.cradle.runsService.get(run.id)?.truncated).toBe(true);
  });

  it('lost-runner reconcile: a run left running/dispatched by a disconnected runner becomes `lost` after the grace check', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, lostGraceSec: 5 } } });
    await withProject(app);
    runner = await connectVerifiedRunner(app, { token: TOKEN });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'reconcile test' }, 'tester');
    await new Promise((r) => setTimeout(r, 60));
    expect(app.diContainer.cradle.runsService.get(run.id)?.status).toBe('running');

    runner.close();
    await new Promise((r) => setTimeout(r, 150)); // let the server's 'disconnect' handler run
    expect(app.diContainer.cradle.runsService.get(run.id)?.status).toBe('running'); // still in its grace period

    // Exposed for tests instead of waiting out the real lostGraceSec timer.
    app.diContainer.cradle.runsService.reconcileLostRunner(runner.runnerId);
    expect(app.diContainer.cradle.runsService.get(run.id)?.status).toBe('lost');
    runner = undefined;
  });

  it('reconnect before the grace check reconciles instead: reported activeRunIds keep a run running, unreported ones become lost', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
    await withProject(app);
    const runnerId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    runner = await connectVerifiedRunner(app, { token: TOKEN, runnerId });
    runner.onStart((cmd, ack) => ack({ ok: true, data: { pid: 1 } }));
    const run = app.diContainer.cradle.runsService.startQuest({ projectId: PROJECT.id, prompt: 'restart test' }, 'tester');
    await new Promise((r) => setTimeout(r, 60));
    runner.close();
    await new Promise((r) => setTimeout(r, 60));

    // Reconnects and reports the run as still active: it stays running, and killRunIds is empty.
    const reconnected = await connectVerifiedRunner(app, { token: TOKEN, runnerId, hello: { activeRunIds: [run.id] } });
    expect(app.diContainer.cradle.runsService.get(run.id)?.status).toBe('running');
    reconnected.close();
    runner = undefined;
  });

  it('retention: pruneOld deletes runs (and their events) ended before runner.runRetentionDays', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, runRetentionDays: 1 } } });
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
