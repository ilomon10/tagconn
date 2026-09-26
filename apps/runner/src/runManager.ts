// Orchestrates one run end to end: validate -> build argv -> spawn -> stream events -> watchdog ->
// end. Ties together validate.ts, argv.ts, spawnPlan.ts, runProcess.ts, watchdog.ts, ledger.ts and
// buffer.ts. See docs/design/runner-and-helpdesk.md §2 and §4.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type ReceptionistScope,
  type RunEnd,
  type RunEndReason,
  type RunEvent,
  type RunEventEnvelope,
  type RunnerCapabilities,
  type RunStartCommand,
  type RunStopCommand,
} from '@tagconn/shared';
import { assertRequiredCapabilities, assertRestrictedCapability, buildQuestArgv, buildReceptionistArgv } from './argv.js';
import { detectMergedUsr, guessTranscriptKey, type BwrapPaths } from './bwrap.js';
import { checkOutputCap, createOutputCapState, type RunOutputCap, type RunOutputCapState } from './buffer.js';
import type { ResolvedRunnerConfig } from './config.js';
import { buildRunEnv } from './env.js';
import { canResume, computeFingerprint, recordSession, saveLedger, type Ledger } from './ledger.js';
import type { Logger } from './logger.js';
import { questSpawnSpec, receptionistSpawnSpec } from './spawnPlan.js';
import { spawnRun, type RunProcessHandle } from './runProcess.js';
import { checkAllowedDir } from './trust.js';
import { validateQuestStart } from './validate.js';
import { checkInitWatchdog, checkToolUseWatchdog } from './watchdog.js';

export interface ActiveRun {
  runId: string;
  kind: 'quest' | 'receptionist';
  handle: RunProcessHandle;
  seq: number;
  capState: RunOutputCapState;
  cap: RunOutputCap;
  ended: boolean;
  /** Set by stop() before killing the process, so the eventual exit is reported as the INTENDED
   *  outcome (stopped_by_user / timeout / runner_shutdown) rather than a generic exit/failed. The
   *  server also sends reason 'timeout' when its own event caps trip; that's a normal stop too. */
  stopRequested?: { status: 'stopped' | 'timeout'; reason: RunEndReason };
  /** SC5 M2: the runner's OWN timeout, enforced even if the server never sends run:stop (e.g. it
   *  crashed or the runner is offline). Cleared on any normal end. */
  timeoutTimer?: NodeJS.Timeout;
}

export interface RunManagerDeps {
  cfg: ResolvedRunnerConfig;
  caps: RunnerCapabilities;
  ledger: Ledger;
  ledgerPath: string;
  claudeJsonPath: string;
  /** Realpath of the resolved claude binary (capabilities.resolveClaudePath), for bwrap's --ro-bind. */
  claudeBinRealPath?: string;
  logger: Logger;
  /** H2: startup audit of the user's OWN ~/.claude/settings.json (userSettingsAudit.ts). Advisory for
   *  logging; `bareWebFetchAllowed` additionally drops WebFetch from a Receptionist turn. */
  userSettingsRisk?: { bareWebFetchAllowed: boolean };
  /** Forwards one event to the server (or the offline queue when disconnected). */
  emitEvent(env: RunEventEnvelope): void;
  emitEnd(end: RunEnd): void;
}

export function createRunManager(deps: RunManagerDeps) {
  const active = new Map<string, ActiveRun>();

  /**
   * SC5 re-review (HIGH, real-CLI QA): the standard native-installer layout makes `~/.local/bin/claude`
   * a SYMLINK into `~/.local/share/claude/versions/<ver>/claude`. bwrap only ro-binds
   * `dirname(claudeBinRealPath)` (the symlink's REAL target dir) into the sandbox — never
   * `~/.local/bin` itself (an empty tmpfs `$HOME` covers it) — so spawning the bare name `claude` and
   * relying on the sandboxed child's own PATH search to find it fails outright: `bwrap: execvp claude:
   * No such file or directory`. Execing the RESOLVED ABSOLUTE PATH instead needs no PATH search at all
   * (the exact dir it lives in is exactly what's bound), so this is used as argv[0] for every spawn —
   * quests (plain and systemd-scope) too, not just the bwrapped Receptionist: an absolute path is
   * strictly more precise than a bare name resolved via whatever PATH the child process ends up with,
   * with no downside when `resolveClaudePath` (main.ts, at startup) succeeded. Falls back to the
   * configured (possibly bare) `claudePath` only if that resolution failed.
   */
  function claudeExecPath(): string {
    return deps.claudeBinRealPath ?? deps.cfg.claudePath;
  }

  function nextSeq(runId: string): number {
    const run = active.get(runId);
    if (!run) return 1;
    run.seq += 1;
    return run.seq;
  }

  function forward(runId: string, event: RunEvent): void {
    const run = active.get(runId);
    if (!run || run.ended) return;
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    const capResult = checkOutputCap(run.capState, run.cap, bytes);
    if (capResult === 'over') return;
    deps.emitEvent({ runId, seq: nextSeq(runId), ts: Date.now(), event });
    if (capResult === 'capped') {
      deps.emitEvent({ runId, seq: nextSeq(runId), ts: Date.now(), event: { kind: 'notice', level: 'warn', message: 'output cap reached' } });
      endRun(runId, { status: 'stopped', reason: 'output_cap', exitCode: null, signal: null });
      run.handle.stop();
    }
  }

  function endRun(runId: string, partial: Omit<RunEnd, 'runId'>): void {
    const run = active.get(runId);
    if (!run || run.ended) return;
    run.ended = true;
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    deps.emitEnd({ runId, ...partial });
    active.delete(runId);
  }

  /** L5: kills a receptionist run whose init.tools/mcpServers, or a later tool_use, violates policy. */
  function watchReceptionistEvent(runId: string, expectedToolSet: readonly string[], event: RunEvent): void {
    const run = active.get(runId);
    if (!run) return;
    let violation: string | undefined;
    if (event.kind === 'init') violation = checkInitWatchdog(event, expectedToolSet);
    else if (event.kind === 'tool_use') violation = checkToolUseWatchdog(event.name, expectedToolSet);
    if (violation) {
      deps.logger.error('receptionist policy_violation', { runId, violation });
      forward(runId, { kind: 'notice', level: 'error', message: `policy_violation: ${violation}` });
      run.handle.stop();
      endRun(runId, { status: 'failed', reason: 'policy_violation', exitCode: null, signal: null, message: violation });
    }
  }

  function rejectStart(runId: string, reason: RunEndReason, message?: string): { pid: number | null } {
    deps.emitEnd({ runId, status: 'rejected', reason, exitCode: null, signal: null, message });
    return { pid: null };
  }

  function startQuest(cmd: RunStartCommand): { pid: number | null } {
    // L1: refuse outright, per run, if the probe never confirmed the flags every spawn relies on
    // (settingSources, strictMcpConfig, permissionPrompts, and now `tools` for the H2 --tools list).
    // main.ts also logs this once at startup, but that log alone never stopped a spawn (dead code).
    try {
      assertRequiredCapabilities(deps.caps);
    } catch (err) {
      return rejectStart(cmd.runId, 'capability_missing', err instanceof Error ? err.message : String(err));
    }
    if (cmd.projectDir === null) return rejectStart(cmd.runId, 'dir_not_allowed', 'quests require a project directory');
    const check = validateQuestStart(
      {
        projectDir: cmd.projectDir,
        permissionMode: cmd.permissionMode,
        allowedTools: cmd.allowedTools,
        disallowedTools: cmd.disallowedTools,
        resumeSessionId: cmd.resumeSessionId,
      },
      deps.cfg,
      deps.caps,
      deps.claudeJsonPath,
      deps.ledger,
    );
    if (!check.ok) return rejectStart(cmd.runId, check.failure);

    const argv = buildQuestArgv({
      claudePath: claudeExecPath(),
      model: cmd.model,
      mode: cmd.permissionMode,
      maxTurns: cmd.maxTurns,
      resumeSessionId: cmd.resumeSessionId,
      allowedTools: cmd.allowedTools,
      disallowedTools: check.disallowedTools,
      toolSet: check.toolSet,
      questMcpConfigPath: deps.cfg.questMcpConfigPath,
      partialMessages: cmd.partialMessages,
      stdinPrompt: deps.caps.stdinPrompt,
      prompt: cmd.prompt,
      disableSlashCommands: deps.caps.disableSlashCommands,
    });
    const env = buildRunEnv({ runId: cmd.runId, runKind: 'quest', passEnv: deps.cfg.passEnv });
    const spec = questSpawnSpec(
      argv,
      cmd.runId,
      check.realDir,
      env,
      check.requiresScope,
      { memoryMax: deps.cfg.memoryMax, tasksMax: deps.cfg.tasksMax },
      deps.caps.stdinPrompt ? cmd.prompt : undefined,
    );

    // M2: capped at the runner's own local limit, enforced regardless of the server.
    const timeoutSec = Math.min(cmd.timeoutSec, deps.cfg.questTimeoutCapSec);
    return spawnAndTrack(cmd, spec, check.fingerprint, undefined, timeoutSec);
  }

  function startReceptionist(cmd: RunStartCommand, opts: { scope: ReceptionistScope; addDirDocs?: string }): { pid: number | null } {
    // L1: same per-run capability gate as quests, plus --restricted specifically for project scope
    // (design §2.1: "restricted for project-scope Receptionist runs").
    try {
      assertRequiredCapabilities(deps.caps);
      if (opts.scope === 'project') assertRestrictedCapability(deps.caps);
    } catch (err) {
      return rejectStart(cmd.runId, 'capability_missing', err instanceof Error ? err.message : String(err));
    }

    // Defense in depth (T6): project scope only inside allowedProjectDirs, even though the server
    // (S3, receptionist module) already restricts this to a registered project.
    let projectRealDir: string | undefined;
    if (opts.scope === 'project') {
      if (!cmd.projectDir) return rejectStart(cmd.runId, 'dir_not_allowed', 'project-scope receptionist requires a project directory');
      const dirCheck = checkAllowedDir(cmd.projectDir, deps.cfg.allowedProjectDirs);
      if (!dirCheck.ok || !dirCheck.realDir) return rejectStart(cmd.runId, 'dir_not_allowed');
      projectRealDir = dirCheck.realDir;
    }

    // L2: honor runner.json receptionistSandbox. 'bwrap' = required (refuse rather than silently
    // fall back to an unsandboxed turn); 'none' = never sandbox even if bwrap is available; 'auto' =
    // the previous behavior (use it when the probe confirmed it).
    const bwrapProbed = deps.caps.bwrap && !!deps.claudeBinRealPath;
    const sandboxSetting = deps.cfg.receptionistSandbox;
    if (sandboxSetting === 'bwrap' && !bwrapProbed) {
      return rejectStart(cmd.runId, 'isolation_unavailable', 'receptionistSandbox=bwrap but bubblewrap is unavailable');
    }
    const sandboxAvailable = sandboxSetting === 'none' ? false : bwrapProbed;

    // H2: a bare WebFetch allow rule in the user's OWN ~/.claude/settings.json would also apply here
    // (--setting-sources=user), potentially widening the general-scope WebFetch variant past its
    // domain allowlist. Drop WebFetch for this turn rather than trust the CLI to still confine it.
    const webFetchDomains = deps.userSettingsRisk?.bareWebFetchAllowed ? [] : cmd.webFetchDomains;

    const built = buildReceptionistArgv({
      claudePath: claudeExecPath(),
      scope: opts.scope,
      model: cmd.model,
      maxTurns: cmd.maxTurns ?? 30,
      resumeSessionId: cmd.resumeSessionId,
      webSearch: cmd.allowWebSearch,
      webFetchDomains,
      sandboxed: sandboxAvailable,
      safeMode: cmd.safeMode,
      addDirDocs: opts.addDirDocs,
      extraDisallowedTools: cmd.disallowedTools,
      stdinPrompt: deps.caps.stdinPrompt,
      prompt: cmd.prompt,
    });
    const fingerprint = computeFingerprint({ tools: built.toolSet, mode: 'plan', restricted: built.restricted, safeMode: cmd.safeMode, webFetchDomains });
    if (cmd.resumeSessionId && !canResume(deps.ledger, cmd.resumeSessionId, fingerprint)) {
      return rejectStart(cmd.runId, 'resume_not_allowed');
    }

    const env = buildRunEnv({ runId: cmd.runId, runKind: 'receptionist', passEnv: [], attributionOff: true });
    const cwd = projectRealDir ?? join(deps.cfg.stateDir, 'receptionist');
    mkdirSync(cwd, { recursive: true });

    let bwrapPaths: BwrapPaths | undefined;
    const sandboxed = sandboxAvailable;
    if (sandboxed && deps.claudeBinRealPath) {
      const home = homedir();
      const runDir = join(deps.cfg.stateDir, 'runs', cmd.runId);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const disposableClaudeJson = join(runDir, 'claude.json');
      writeFileSync(disposableClaudeJson, '{}', { mode: 0o600 });
      const transcriptDir = join(home, '.claude', 'projects', guessTranscriptKey(cwd));
      mkdirSync(transcriptDir, { recursive: true });
      bwrapPaths = {
        home,
        claudeBinDir: dirname(deps.claudeBinRealPath),
        claudeDir: join(home, '.claude'),
        transcriptDir,
        credentialsPath: join(home, '.claude', '.credentials.json'),
        disposableClaudeJsonPath: disposableClaudeJson,
        bindDir: cwd,
        docsDir: opts.addDirDocs,
        cwd,
      };
    }
    const spec = receptionistSpawnSpec(built.argv, cwd, env, sandboxed, bwrapPaths, sandboxed ? detectMergedUsr() : undefined, deps.caps.stdinPrompt ? cmd.prompt : undefined);

    // M2: receptionist turns get the (shorter) receptionist timeout cap.
    const timeoutSec = Math.min(cmd.timeoutSec, deps.cfg.receptionistTimeoutCapSec);
    return spawnAndTrack(cmd, spec, fingerprint, built.toolSet, timeoutSec);
  }

  function spawnAndTrack(
    cmd: RunStartCommand,
    spec: Parameters<typeof spawnRun>[0],
    fingerprint: string,
    receptionistToolSet: readonly string[] | undefined,
    timeoutSec: number,
  ): { pid: number | null } {
    const cap: RunOutputCap = { maxEvents: cmd.limits.maxEvents, maxEventBytes: cmd.limits.maxEventBytes };
    const record: ActiveRun = {
      runId: cmd.runId,
      kind: cmd.kind,
      handle: undefined as unknown as RunProcessHandle,
      seq: 0,
      capState: createOutputCapState(),
      cap,
      ended: false,
    };
    active.set(cmd.runId, record);

    // M2: the runner's own timeout, independent of the server (which may be unreachable). Reuses the
    // exact stop() path a server-sent run:stop{reason:'timeout'} would take.
    record.timeoutTimer = setTimeout(() => stop({ runId: cmd.runId, reason: 'timeout' }), timeoutSec * 1000);

    let handle: RunProcessHandle;
    try {
      handle = spawnRun(
        spec,
        { previewChars: cmd.limits.previewChars, maxStderrLines: deps.cfg.maxStderrLines, maxLineBytes: deps.cfg.maxLineBytes },
        deps.cfg.killGraceMs,
        {
          onEvent: (event) => {
            if (receptionistToolSet) watchReceptionistEvent(cmd.runId, receptionistToolSet, event);
            // L6: watchReceptionistEvent may have just ended THIS run (policy_violation) on this very
            // 'init' event (init.tools/mcpServers mismatch) — never record a resumable ledger session
            // for a run that was killed for violating policy on arrival.
            const rec = active.get(cmd.runId);
            if (event.kind === 'init' && rec && !rec.ended) {
              recordSession(deps.ledger, event.sessionId, fingerprint, deps.cfg.sessionLedgerSize);
              saveLedger(deps.ledgerPath, deps.ledger);
            }
            forward(cmd.runId, event);
          },
          onExit: ({ exitCode, signal }) => {
            const rec = active.get(cmd.runId);
            if (!rec || rec.ended) return;
            if (rec.stopRequested) {
              endRun(cmd.runId, { status: rec.stopRequested.status, reason: rec.stopRequested.reason, exitCode, signal });
              return;
            }
            const status = exitCode === 0 ? 'succeeded' : 'failed';
            endRun(cmd.runId, { status, reason: 'exit', exitCode, signal });
          },
          onParseError: (line) => deps.logger.warn('unparseable stream-json line', { runId: cmd.runId, line: line.slice(0, 200) }),
        },
      );
    } catch (err) {
      // SC5 re-review (recommended): node:child_process's `spawn()` can throw SYNCHRONOUSLY (as
      // opposed to the far more common async 'error' event runProcess.ts now also handles) for some
      // invalid options. `record` was already registered in `active` (with its M2 timeout timer
      // already running) above, before this call — endRun() cleans both up and reports the run ended,
      // instead of leaking an active-run entry / timer for a process that was never actually spawned.
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error('spawn() threw synchronously', { runId: cmd.runId, message });
      endRun(cmd.runId, { status: 'failed', reason: 'spawn_failed', exitCode: null, signal: null, message });
      return { pid: null };
    }
    record.handle = handle;
    return { pid: handle.pid ?? null };
  }

  function stop(cmd: RunStopCommand): void {
    const run = active.get(cmd.runId);
    if (!run) return;
    run.stopRequested = { status: cmd.reason === 'timeout' ? 'timeout' : 'stopped', reason: cmd.reason };
    run.handle.stop();
  }

  function activeRunIds(): string[] {
    return Array.from(active.keys());
  }

  function activeCount(): number {
    return active.size;
  }

  return { startQuest, startReceptionist, stop, activeRunIds, activeCount };
}

export type RunManager = ReturnType<typeof createRunManager>;
