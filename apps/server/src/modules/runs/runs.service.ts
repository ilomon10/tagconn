import { randomUUID } from 'node:crypto';
import {
  type AttributionWriteCommand,
  type AttributionWriteResult,
  CLAUDE_SESSION_ID_RE,
  isTerminalRunStatus,
  type Run,
  type RunDetail,
  type RunDispatcher,
  type RunEnd,
  type RunEvent,
  type RunEventEnvelope,
  type RunFollowUpRequest,
  type RunKind,
  type RunnerHello,
  type RunnerStatus,
  type RunStartCommand,
  RunStartCommandSchema,
  type RunStartRequest,
  type RunStopCommand,
  type Settings,
} from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { HttpError, notFound } from '../../core/http/index.js';
import { redactValue } from '../../core/redact/index.js';
import type { RunListFilter } from './runs.repository.js';
import {
  assertProjectDirAllowed,
  assertPromptWithinLimit,
  buildQuestAllowedTools,
  buildQuestDisallowedTools,
  resolvePermissionMode,
} from './runs.validate.js';

/** Display-only prompt preview stored on the `Run` row (never the full prompt sent to the runner). */
const PROMPT_PREVIEW_CHARS = 2_000;
/** `RunResultSummary.text` is a preview; the full text lives in the (already redacted) run events. */
const RESULT_TEXT_PREVIEW_CHARS = 8_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_SWEEP_MS = 60 * 60 * 1000;
/** M5: upper bound when re-summing a run's stored event bytes at boot (`settings.runner.maxEventsPerRun` tops out at 100_000). */
const MAX_EVENTS_TO_SEED = 200_000;

const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…[truncated]` : s);

/** Same byte accounting `onRunEvent` uses, applied to already-stored events (M5: reseeded at boot so
 * the cap survives a server restart instead of resetting to 0). */
const sumEventBytes = (events: readonly RunEventEnvelope[]): number =>
  events.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e.event)), 0);

/** Implemented by `RunnerGateway` once a runner has completed the HMAC handshake and sent `runner:hello`. */
export interface RunnerConnection {
  runnerId: string;
  hello: RunnerHello;
  sendStart(cmd: RunStartCommand, cb: (res: { ok: true; data: { pid: number | null } } | { ok: false; error: string }) => void): void;
  sendStop(cmd: RunStopCommand): void;
  /** `modules/attribution`'s explicit "save profile to project" (§6.4). */
  sendAttributionWrite(cmd: AttributionWriteCommand, cb: (res: { ok: true; data: AttributionWriteResult } | { ok: false; error: string }) => void): void;
}

interface PendingDispatch {
  command: RunStartCommand;
}

type RunsDeps = Deps<'runsRepository' | 'projectsRepository' | 'heroesRepository' | 'settings' | 'bus' | 'logger'>;

/**
 * Port consumed by `modules/ingest`/`modules/sessions` (S5, §2.6 "Hint"): the hook's
 * `x-tagconn-run-id` header only ever links an existing, non-terminal, unlinked QUEST run.
 */
export interface RunLinker {
  hint(runId: string, sessionId: string): void;
}

/**
 * Queue, dispatch and lifecycle for runner-backed runs (quests + receptionist turns), M8 8k.
 * See docs/design/runner-and-helpdesk.md §2.7 and §9 (S2). Implements `RunDispatcher` (the port
 * `modules/receptionist`, S3, reuses) and `RunLinker` (S5, above).
 */
export class RunsService implements RunDispatcher, RunLinker {
  /** FIFO of queued run ids, capped at `settings.runner.maxQueued`. */
  private queue: string[] = [];
  private pendingDispatch = new Map<string, PendingDispatch>();
  /** Bytes forwarded per run so far (defense-in-depth re-cap; event count is tracked on the `Run` row itself). */
  private eventBytes = new Map<string, number>();
  private runner?: RunnerConnection;
  private connectedAt?: number;
  private graceTimers = new Map<string, NodeJS.Timeout>();
  private retentionTimer?: NodeJS.Timeout;

  constructor(private readonly deps: RunsDeps) {}

  /** Boot: a run left `queued` can never be redispatched (its command lived only in memory, see
   * `enqueue`), so it is immediately `lost`. A run left `dispatched`/`running` waits `lostGraceSec`
   * for its runner to reconnect and say otherwise — exactly like a live disconnect (§2.2 step 5). */
  seed(now = Date.now()): void {
    const orphanedRunnerIds = new Set<string>();
    for (const run of this.deps.runsRepository.list({ limit: 100_000 })) {
      if (run.status === 'queued') {
        this.markEnded(run, 'lost', undefined, now);
      } else if ((run.status === 'dispatched' || run.status === 'running') && run.runnerId) {
        orphanedRunnerIds.add(run.runnerId);
        // M5: reseed the byte counter from what's already stored, so a restart mid-run doesn't reset
        // the output cap back to 0 and let the run double its allowance across the restart.
        this.eventBytes.set(run.id, sumEventBytes(this.deps.runsRepository.listEvents(run.id, MAX_EVENTS_TO_SEED)));
      }
    }
    for (const runnerId of orphanedRunnerIds) this.scheduleLostGraceCheck(runnerId, now);
  }

  /** Hourly run retention sweep (`settings.runner.runRetentionDays`), same pattern as `EventsService`. */
  start(): void {
    const run = () => {
      try {
        this.pruneOld();
      } catch (err) {
        this.deps.logger.error({ err }, 'run retention failed');
      }
    };
    run();
    this.retentionTimer = setInterval(run, RETENTION_SWEEP_MS);
    this.retentionTimer.unref?.();
  }

  /** Module teardown: stop the retention timer and any pending lost-runner grace timers. */
  shutdown(): void {
    clearInterval(this.retentionTimer);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
  }

  // -------------------------------------------------------------- quest board (REST + socket)

  startQuest(req: RunStartRequest, createdBy: string): Run {
    const project = this.deps.projectsRepository.get(req.projectId);
    if (!project) throw notFound(`Project ${req.projectId}`);
    const { runner: runnerCfg } = this.deps.settings.get();
    assertProjectDirAllowed(project.cwd, runnerCfg.allowedProjectDirs);
    assertPromptWithinLimit(req.prompt, runnerCfg.maxPromptChars);
    const permissionMode = resolvePermissionMode(req.permissionMode, runnerCfg);
    const model = req.model ?? runnerCfg.defaultModel;

    let dispatchPrompt = req.prompt;
    let heroRole: string | undefined;
    if (req.heroId) {
      const hero = this.deps.heroesRepository.get(req.heroId);
      if (!hero) throw new HttpError(400, `Unknown heroId "${req.heroId}"`);
      heroRole = hero.role;
      dispatchPrompt = `Delegate this task to the "${heroRole}" subagent. ${req.prompt}`;
    }

    const id = randomUUID();
    const run = this.buildRun({
      id,
      kind: 'quest',
      projectId: req.projectId,
      threadId: id,
      heroId: req.heroId,
      prompt: req.prompt,
      permissionMode,
      model,
      createdBy,
    });
    const command = this.buildQuestCommand(run.id, project.cwd, dispatchPrompt, permissionMode, model, runnerCfg);
    this.enqueue(run, command);
    if (req.heroId) this.deps.bus.emit('run.heroRequested', { runId: run.id, projectId: req.projectId, heroId: req.heroId, role: heroRole! });
    return run;
  }

  followUp(req: RunFollowUpRequest, createdBy: string): Run {
    const original = this.requireRun(req.runId);
    if (original.kind !== 'quest') throw new HttpError(400, 'runs:followUp only accepts quest runs');
    if (!original.sessionId) throw new HttpError(409, 'This run has no session yet to resume');
    // L6: a follow-up may only resume a session id this run's OWN `init` event actually reported —
    // never one that only ever came from the `x-tagconn-run-id` hook hint (runLinker.hint), which is a
    // correlation guess, not the CLI's own authoritative session id.
    if (!this.sessionIdConfirmedByInit(original)) {
      throw new HttpError(409, "resume_not_allowed: this run's session id was never confirmed by its own init event");
    }
    if (!original.projectId) throw new HttpError(409, 'This run has no project to resume into');
    const project = this.deps.projectsRepository.get(original.projectId);
    if (!project) throw notFound(`Project ${original.projectId}`);
    const { runner: runnerCfg } = this.deps.settings.get();
    assertProjectDirAllowed(project.cwd, runnerCfg.allowedProjectDirs);
    assertPromptWithinLimit(req.prompt, runnerCfg.maxPromptChars);
    // L2: the mode chosen for the original run may no longer be allowed (settings changed since); a
    // follow-up must re-check it, not just trust what was recorded on the original run.
    const permissionMode = resolvePermissionMode(original.permissionMode, runnerCfg);

    const id = randomUUID();
    const run = this.buildRun({
      id,
      kind: 'quest',
      projectId: original.projectId,
      threadId: original.threadId,
      parentRunId: original.id,
      heroId: original.heroId,
      resumeSessionId: original.sessionId,
      prompt: req.prompt,
      permissionMode,
      model: original.model,
      createdBy,
    });
    const command = this.buildQuestCommand(run.id, project.cwd, req.prompt, permissionMode, original.model, runnerCfg, original.sessionId);
    this.enqueue(run, command);
    return run;
  }

  /** L6: true only if `run.sessionId` was actually reported by this run's own `init` event (persisted
   * in `run_events`, so this survives a server restart) — never merely set by `hint()`'s hook
   * correlation. */
  private sessionIdConfirmedByInit(run: Run): boolean {
    if (!run.sessionId) return false;
    return this.deps.runsRepository
      .listEvents(run.id, MAX_EVENTS_TO_SEED)
      .some((e) => e.event.kind === 'init' && e.event.sessionId === run.sessionId);
  }

  stopQuest(runId: string, _createdBy: string): Run {
    const run = this.requireRun(runId);
    if (run.kind !== 'quest') throw new HttpError(400, 'runs:stop only accepts quest runs');
    return this.stopRun(runId, 'stopped_by_user');
  }

  list(filter: RunListFilter): Run[] {
    return this.deps.runsRepository.list(filter);
  }

  getDetail(runId: string): RunDetail {
    const run = this.requireRun(runId);
    return { run, events: this.deps.runsRepository.listEvents(runId) };
  }

  getRunnerStatus(): RunnerStatus {
    const { runner: runnerCfg } = this.deps.settings.get();
    if (!this.runner) {
      return {
        connected: false,
        verified: false,
        maxConcurrent: runnerCfg.maxConcurrent,
        activeRuns: 0,
        queuedRuns: this.queue.length,
        allowedProjectDirs: [],
        questMaxAllowedTools: [],
      };
    }
    const { runnerId, hello } = this.runner;
    return {
      connected: true,
      verified: true,
      runnerId,
      hostname: hello.hostname,
      version: hello.version,
      claudeVersion: hello.claudeVersion,
      capabilities: hello.capabilities,
      maxConcurrent: Math.min(runnerCfg.maxConcurrent, hello.maxConcurrent),
      maxPermissionMode: hello.maxPermissionMode,
      activeRuns: this.deps.runsRepository.activeForRunner(runnerId).length,
      queuedRuns: this.queue.length,
      connectedAt: this.connectedAt,
      allowedProjectDirs: hello.allowedProjectDirs,
      questMaxAllowedTools: hello.questMaxAllowedTools,
      receptionistSandbox: hello.receptionistSandbox,
      receptionistFlags: hello.receptionistFlags,
    };
  }

  // -------------------------------------------------------------- attribution (M8 8k/8l, §6.4)

  /**
   * Forwards an explicit "save profile to project" to the verified runner's `attribution:write`,
   * which re-checks everything by realpath (T6 defense in depth) before writing. Same server-side
   * gates as a quest start: `runner.enabled` and `cmd.projectDir` inside `runner.allowedProjectDirs`.
   * `modules/attribution` builds `cmd` (the profile content) and calls this instead of importing
   * `RunnerConnection`/socket internals directly.
   */
  async sendAttributionWrite(cmd: AttributionWriteCommand): Promise<AttributionWriteResult> {
    const { runner: runnerCfg } = this.deps.settings.get();
    if (!runnerCfg.enabled) throw new HttpError(409, 'runner_disabled: settings.runner.enabled is false');
    assertProjectDirAllowed(cmd.projectDir, runnerCfg.allowedProjectDirs);
    if (!this.runner) throw new HttpError(409, 'No verified runner is connected');
    const runner = this.runner;
    return new Promise<AttributionWriteResult>((resolve, reject) => {
      runner.sendAttributionWrite(cmd, (res) => {
        if (!res.ok) return reject(new HttpError(502, res.error));
        resolve(res.data);
      });
    });
  }

  // -------------------------------------------------------------- RunDispatcher (S3 receptionist port)

  startReceptionistTurn(input: {
    conversationId: string;
    projectId: string | null;
    prompt: string;
    resumeSessionId?: string;
    createdBy: string;
  }): Run {
    const { receptionist, runner: runnerCfg } = this.deps.settings.get();
    let cwd: string | null = null;
    if (input.projectId) {
      const project = this.deps.projectsRepository.get(input.projectId);
      if (!project) throw notFound(`Project ${input.projectId}`);
      assertProjectDirAllowed(project.cwd, runnerCfg.allowedProjectDirs);
      cwd = project.cwd;
    }
    const id = randomUUID();
    const run = this.buildRun({
      id,
      kind: 'receptionist',
      projectId: input.projectId ?? undefined,
      conversationId: input.conversationId,
      threadId: id,
      resumeSessionId: input.resumeSessionId,
      prompt: input.prompt,
      permissionMode: 'plan',
      model: receptionist.model,
      createdBy: input.createdBy,
    });
    const command: RunStartCommand = {
      runId: run.id,
      kind: 'receptionist',
      projectDir: cwd,
      prompt: input.prompt,
      permissionMode: 'plan',
      model: receptionist.model,
      resumeSessionId: input.resumeSessionId,
      allowedTools: [],
      disallowedTools: buildQuestDisallowedTools(runnerCfg),
      maxTurns: receptionist.maxTurns,
      timeoutSec: receptionist.timeoutSec,
      readOnly: true,
      addTagconnDocs: !input.projectId && receptionist.allowTagconnDocs,
      allowWebSearch: receptionist.webSearch,
      webFetchDomains: !input.projectId && receptionist.webFetch === 'allowlist' ? receptionist.webFetchAllowDomains : [],
      safeMode: Boolean(input.projectId) && receptionist.projectSafeMode,
      partialMessages: runnerCfg.partialMessages,
      limits: { maxEvents: runnerCfg.maxEventsPerRun, maxEventBytes: runnerCfg.maxEventBytesPerRun, previewChars: runnerCfg.previewChars },
    };
    this.enqueue(run, command);
    return run;
  }

  /** `RunDispatcher.stop`: also used directly by the runner-gateway's own cleanup paths. */
  stop(runId: string, reason: 'stopped_by_user'): Run {
    return this.stopRun(runId, reason);
  }

  /** `RunDispatcher.get`: unlike `getDetail`, never throws. */
  get(runId: string): Run | undefined {
    return this.deps.runsRepository.get(runId);
  }

  // -------------------------------------------------------------- runLinker (S5 hook: x-tagconn-run-id)

  /** Links only an existing, non-terminal, unlinked QUEST run. `init` (see `onRunEvent`) always wins:
   * it overwrites whatever this hint set, since it is the authoritative Claude session id. */
  hint(runId: string, sessionId: string): void {
    if (!CLAUDE_SESSION_ID_RE.test(sessionId)) return; // L6: malformed id, never trusted
    const run = this.deps.runsRepository.get(runId);
    if (!run || run.kind !== 'quest' || isTerminalRunStatus(run.status) || run.sessionId) return;
    const updated: Run = { ...run, sessionId };
    this.deps.runsRepository.update(updated);
    this.deps.bus.emit('run.upserted', updated);
    this.deps.bus.emit('run.linked', { runId, sessionId, projectId: run.projectId });
  }

  // -------------------------------------------------------------- runner gateway callbacks

  /** `runner:hello` verified. Reconciles per §2.2 step 5 and returns the run ids the runner must
   * kill (it reports them active; the server does not, or knows them as already-ended). */
  runnerConnected(connection: RunnerConnection): { killRunIds: string[] } {
    this.clearGraceTimer(connection.runnerId);
    this.runner = connection;
    this.connectedAt = Date.now();
    const known = this.deps.runsRepository.activeForRunner(connection.runnerId);
    const reported = new Set(connection.hello.activeRunIds);
    const knownActiveIds = new Set<string>();
    for (const run of known) {
      if (reported.has(run.id)) knownActiveIds.add(run.id);
      else this.markEnded(run, 'lost');
    }
    const killRunIds = connection.hello.activeRunIds.filter((id) => !knownActiveIds.has(id));
    this.deps.bus.emit('runner.status', this.getRunnerStatus());
    this.tryDispatch();
    return { killRunIds };
  }

  /** Socket dropped. Runs stay `dispatched`/`running` for `lostGraceSec` in case it reconnects
   * (§2.7); `runnerConnected`'s hello reconcile supersedes this if it does. */
  runnerDisconnected(runnerId: string): void {
    if (this.runner?.runnerId === runnerId) {
      this.runner = undefined;
      this.connectedAt = undefined;
    }
    this.deps.bus.emit('runner.status', this.getRunnerStatus());
    this.scheduleLostGraceCheck(runnerId);
  }

  private scheduleLostGraceCheck(runnerId: string, since = Date.now()): void {
    this.clearGraceTimer(runnerId);
    const graceSec = this.deps.settings.get().runner.lostGraceSec;
    const delayMs = Math.max(0, graceSec * 1000 - (Date.now() - since));
    const timer = setTimeout(() => this.reconcileLostRunner(runnerId), delayMs);
    timer.unref?.();
    this.graceTimers.set(runnerId, timer);
  }

  private clearGraceTimer(runnerId: string): void {
    const t = this.graceTimers.get(runnerId);
    if (t) {
      clearTimeout(t);
      this.graceTimers.delete(runnerId);
    }
  }

  /** What a grace timer firing does; exposed so tests can trigger it without waiting on real timers. */
  reconcileLostRunner(runnerId: string): void {
    this.graceTimers.delete(runnerId);
    if (this.runner?.runnerId === runnerId) return; // reconnected in the meantime
    for (const run of this.deps.runsRepository.activeForRunner(runnerId)) this.markEnded(run, 'lost');
  }

  /** Ownership + dedupe + caps + redaction (§2.5 "Server side"). M5: once a run has tripped the cap
   * (`run.truncated`), every further event is dropped outright — no more storage, no more repeated
   * stop commands — instead of quietly continuing to grow past the limit until `run:end` arrives. */
  onRunEvent(runnerId: string, env: RunEventEnvelope): void {
    const run = this.deps.runsRepository.get(env.runId);
    if (!run || run.runnerId !== runnerId || isTerminalRunStatus(run.status)) return; // not ours, or too late
    if (run.truncated) return; // already over cap: the single stop + synthetic notice were already sent
    const { ingest, runner: runnerCfg } = this.deps.settings.get();
    const redacted = redactValue(env.event, ingest.redactPatterns);
    const capped = capPreviews(redacted, runnerCfg.previewChars);
    const stored = this.deps.runsRepository.appendEvent({ ...env, event: capped });
    if (!stored) return; // (runId, seq) already stored: runner replay after a reconnect

    const bytes = (this.eventBytes.get(run.id) ?? 0) + Buffer.byteLength(JSON.stringify(capped));
    this.eventBytes.set(run.id, bytes);
    const eventCount = run.eventCount + 1;
    const overCap = eventCount > runnerCfg.maxEventsPerRun || bytes > runnerCfg.maxEventBytesPerRun;

    let updated: Run = { ...run, eventCount, truncated: overCap };
    if (capped.kind === 'init') updated = { ...updated, sessionId: capped.sessionId };
    if (capped.kind === 'result') {
      updated = {
        ...updated,
        result: {
          isError: capped.isError,
          subtype: capped.subtype,
          text: capped.text !== undefined ? truncate(capped.text, RESULT_TEXT_PREVIEW_CHARS) : undefined,
          costUsd: capped.costUsd,
          durationMs: capped.durationMs,
          numTurns: capped.numTurns,
          usage: capped.usage,
        },
      };
    }
    this.deps.runsRepository.update(updated);
    this.deps.bus.emit('run.upserted', updated);
    this.deps.bus.emit('run.event', { ...env, event: capped });
    if (capped.kind === 'init') this.deps.bus.emit('run.linked', { runId: run.id, sessionId: capped.sessionId, projectId: run.projectId });

    if (overCap) {
      // M5: exactly one synthetic notice, then exactly one stop (reason: output_cap) — never again for
      // this run, since `run.truncated` is now true and every future event returns at the top.
      const notice: RunEventEnvelope = {
        runId: run.id,
        seq: env.seq + 1,
        ts: Date.now(),
        event: { kind: 'notice', level: 'warn', message: 'output cap exceeded (runner.maxEventsPerRun/maxEventBytesPerRun); stopping the run' },
      };
      if (this.deps.runsRepository.appendEvent(notice)) this.deps.bus.emit('run.event', notice);
      if (this.runner && run.runnerId === this.runner.runnerId) this.runner.sendStop({ runId: run.id, reason: 'output_cap' });
    }
  }

  onRunEnd(runnerId: string, end: RunEnd): void {
    const run = this.deps.runsRepository.get(end.runId);
    if (!run || run.runnerId !== runnerId || isTerminalRunStatus(run.status)) return;
    this.markEnded(run, end.status, end.reason, undefined, end.exitCode, end.message);
    this.tryDispatch();
  }

  // -------------------------------------------------------------- retention

  pruneOld(now = Date.now()): number {
    const days = this.deps.settings.get().runner.runRetentionDays;
    const removed = this.deps.runsRepository.pruneEndedBefore(now - days * DAY_MS);
    if (removed > 0) this.deps.logger.info({ removed, days }, 'pruned old runs');
    return removed;
  }

  // -------------------------------------------------------------- internals

  private requireRun(id: string): Run {
    const run = this.deps.runsRepository.get(id);
    if (!run) throw notFound(`Run ${id}`);
    return run;
  }

  private buildRun(input: {
    id: string;
    kind: RunKind;
    projectId?: string;
    conversationId?: string;
    threadId: string;
    parentRunId?: string;
    heroId?: string;
    resumeSessionId?: string;
    prompt: string;
    permissionMode: Run['permissionMode'];
    model: Run['model'];
    createdBy: string;
  }): Run {
    const now = Date.now();
    const redactedPrompt = redactValue(input.prompt, this.deps.settings.get().ingest.redactPatterns);
    const run: Run = {
      id: input.id,
      kind: input.kind,
      projectId: input.projectId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      parentRunId: input.parentRunId,
      heroId: input.heroId,
      status: 'queued',
      prompt: truncate(redactedPrompt, PROMPT_PREVIEW_CHARS),
      permissionMode: input.permissionMode,
      model: input.model,
      resumeSessionId: input.resumeSessionId,
      createdBy: input.createdBy,
      createdAt: now,
      eventCount: 0,
      truncated: false,
    };
    this.deps.runsRepository.insert(run);
    this.deps.bus.emit('run.upserted', run);
    return run;
  }

  private buildQuestCommand(
    runId: string,
    projectDir: string,
    prompt: string,
    permissionMode: Run['permissionMode'],
    model: Run['model'],
    runnerCfg: Settings['runner'],
    resumeSessionId?: string,
  ): RunStartCommand {
    return {
      runId,
      kind: 'quest',
      projectDir,
      prompt,
      permissionMode,
      model,
      resumeSessionId,
      allowedTools: buildQuestAllowedTools(runnerCfg),
      disallowedTools: buildQuestDisallowedTools(runnerCfg),
      maxTurns: runnerCfg.maxTurns,
      timeoutSec: runnerCfg.runTimeoutSec,
      readOnly: false,
      addTagconnDocs: false,
      allowWebSearch: true,
      webFetchDomains: [],
      safeMode: false,
      partialMessages: runnerCfg.partialMessages,
      limits: { maxEvents: runnerCfg.maxEventsPerRun, maxEventBytes: runnerCfg.maxEventBytesPerRun, previewChars: runnerCfg.previewChars },
    };
  }

  private enqueue(run: Run, command: RunStartCommand): void {
    // M3: settings.runner.enabled defaults to false; the installer turns it on (OFFICE_RUNNER__ENABLED=true)
    // once it has written a runner.json + token. The /runner namespace itself refuses handshakes the
    // same way (runs.gateway.ts), so this is what actually surfaces the 409 to the browser.
    if (!this.deps.settings.get().runner.enabled) throw new HttpError(409, 'runner_disabled: settings.runner.enabled is false');
    if (!this.runner) throw new HttpError(409, 'No verified runner is connected');
    if (this.queue.length >= this.deps.settings.get().runner.maxQueued) {
      throw new HttpError(429, 'Run queue is full (runner.maxQueued)');
    }
    this.pendingDispatch.set(run.id, { command });
    this.queue.push(run.id);
    this.tryDispatch();
  }

  private tryDispatch(): void {
    if (!this.runner) return;
    const runner = this.runner;
    const max = Math.min(this.deps.settings.get().runner.maxConcurrent, runner.hello.maxConcurrent);
    while (this.queue.length > 0 && this.deps.runsRepository.activeForRunner(runner.runnerId).length < max) {
      const runId = this.queue.shift();
      if (runId === undefined) break;
      this.dispatchOne(runId, runner);
    }
  }

  private dispatchOne(runId: string, runner: RunnerConnection): void {
    const pending = this.pendingDispatch.get(runId);
    const run = this.deps.runsRepository.get(runId);
    this.pendingDispatch.delete(runId);
    if (!pending || !run || run.status !== 'queued') return; // stopped/cancelled while queued

    // M4: parse the fully-built command against its own contract before it is ever put on the wire —
    // catches a server-side bug in the builders above rather than shipping a malformed command.
    const parsedCommand = RunStartCommandSchema.safeParse(pending.command);
    if (!parsedCommand.success) {
      this.deps.logger.error({ err: parsedCommand.error, runId }, 'built RunStartCommand failed its own schema; refusing to dispatch');
      this.markEnded(run, 'rejected', 'invalid_command');
      this.tryDispatch();
      return;
    }

    const dispatched: Run = { ...run, status: 'dispatched', runnerId: runner.runnerId, startedAt: Date.now() };
    this.deps.runsRepository.update(dispatched);
    this.deps.bus.emit('run.upserted', dispatched);

    runner.sendStart(parsedCommand.data, (res) => {
      const current = this.deps.runsRepository.get(runId);
      if (!current || current.status !== 'dispatched') return; // stopped/ended already
      if (!res.ok || res.data.pid === null) {
        // L7: the ack can fail or time out right as a newer runner connection replaces this one, after
        // the older connection already forwarded run:start. Ask it to stop proactively in case it's
        // still the live socket and actually spawned something; if that socket is already gone, the
        // next runner:hello's reconcile (runnerConnected's killRunIds) catches the orphan instead,
        // since this run is terminal by the time that hello arrives and so never counts as "known active".
        runner.sendStop({ runId, reason: 'timeout' });
        this.markEnded(current, 'rejected', 'spawn_failed', undefined, null, res.ok ? undefined : res.error);
        this.tryDispatch();
        return;
      }
      const running: Run = { ...current, status: 'running' };
      this.deps.runsRepository.update(running);
      this.deps.bus.emit('run.upserted', running);
    });
  }

  private stopRun(runId: string, reason: 'stopped_by_user'): Run {
    const run = this.requireRun(runId);
    if (isTerminalRunStatus(run.status)) return run;
    if (run.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== runId);
      this.pendingDispatch.delete(runId);
      return this.markEnded(run, 'stopped', reason);
    }
    if (this.runner && run.runnerId === this.runner.runnerId) {
      this.runner.sendStop({ runId, reason });
    }
    return run; // final status arrives via `run:end`
  }

  private markEnded(
    run: Run,
    status: Run['status'],
    endReason?: Run['endReason'],
    now = Date.now(),
    exitCode: number | null = null,
    error?: string,
  ): Run {
    // L1: `error` is either the runner's free-text `run:end.message` or a runner ack error string —
    // neither is redacted upstream, so redact it here before it's ever stored or broadcast.
    const redactedError = error && redactValue(error, this.deps.settings.get().ingest.redactPatterns);
    const updated: Run = {
      ...run,
      status,
      endReason,
      endedAt: now,
      exitCode: exitCode ?? undefined,
      error: redactedError ? truncate(redactedError, RESULT_TEXT_PREVIEW_CHARS) : undefined,
    };
    this.deps.runsRepository.update(updated);
    this.deps.bus.emit('run.upserted', updated);
    this.eventBytes.delete(run.id); // M5: every terminal path releases the per-run byte counter here, once
    return updated;
  }
}

/** Server-side re-truncation of tool_use/tool_result previews to `settings.runner.previewChars`
 * (defense in depth: the runner already truncates to the same limit it was given). */
export function capPreviews(event: RunEvent, previewChars: number): RunEvent {
  if (event.kind === 'tool_use') return { ...event, inputPreview: truncate(event.inputPreview, previewChars) };
  if (event.kind === 'tool_result') return { ...event, preview: truncate(event.preview, previewChars) };
  return event;
}
