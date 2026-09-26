import {
  DEFAULT_QUEST_MAX_ALLOWED_TOOLS,
  RUN_PERMISSION_MODES,
  type Run,
  type RunEndReason,
  type RunEventEnvelope,
  type RunFollowUpRequest,
  type RunStartRequest,
  type RunnerCapabilities,
  type RunnerStatus,
} from '@tagconn/shared';

/**
 * Demo mode (`/?demo=1`) has no server and no runner at all, so a quest is simulated entirely client
 * side: a fabricated `Run` plus a short, believable stream-json-shaped event sequence (init → text →
 * tool_use/tool_result → result) played out on a timer, feeding straight into `stores/runsStore.ts`'s
 * own setters — the same functions a live socket push would call. Kept separate from `lib/mock.ts`
 * (the office/demo team's file): this module is quests-only and is only ever imported from
 * `stores/runsStore.ts`.
 */

export interface DemoRunHooks {
  upsertRun(r: Run): void;
  applyEvent(e: RunEventEnvelope): void;
}

export interface DemoFollowUpHooks extends DemoRunHooks {
  getRun(id: string): Run | undefined;
}

let idSeq = 0;
const nextRunId = () => `demo-run-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;
const nextSessionId = () => `demo-session-${Date.now().toString(36)}${(idSeq++).toString(36)}`;

const DEMO_CAPABILITIES: RunnerCapabilities = {
  stdinPrompt: true,
  includePartialMessages: true,
  settingSources: true,
  strictMcpConfig: true,
  tools: true,
  permissionPrompts: true,
  disableSlashCommands: true,
  restricted: true,
  safeMode: true,
  permissionModes: [...RUN_PERMISSION_MODES],
  bwrap: true,
  systemdScope: true,
};

/** A believable "connected, healthy" runner status — enough for the banner and the New Quest form's
 *  mode/containment logic to behave the same way it would against a real host. */
export function demoRunnerStatus(): RunnerStatus {
  return {
    connected: true,
    verified: true,
    runnerId: 'demo-runner',
    hostname: 'demo-host',
    version: '0.2.0',
    claudeVersion: '2.1.282',
    capabilities: DEMO_CAPABILITIES,
    maxConcurrent: 2,
    maxPermissionMode: 'acceptEdits',
    activeRuns: 0,
    queuedRuns: 0,
    connectedAt: Date.now(),
    allowedProjectDirs: ['/home/demo/projects/tagconn'],
    questMaxAllowedTools: [...DEFAULT_QUEST_MAX_ALLOWED_TOOLS],
    receptionistSandbox: 'bwrap',
    receptionistFlags: { restricted: true, safeModeProjectScope: false },
  };
}

function makeEvent(runId: string, seq: number, event: RunEventEnvelope['event']): RunEventEnvelope {
  return { runId, seq, ts: Date.now(), event };
}

/** Plays a run from `queued` to a terminal `succeeded`, pushing events through `hooks` on a short
 *  timer chain. Intentionally simple — this only needs to look like a real quest, not behave like one. */
function playDemoQuest(run: Run, prompt: string, hooks: DemoRunHooks): void {
  let seq = 0;
  const sessionId = nextSessionId();
  const push = (event: RunEventEnvelope['event']) => hooks.applyEvent(makeEvent(run.id, ++seq, event));
  const update = (patch: Partial<Run>) => hooks.upsertRun({ ...run, ...patch });

  const steps: Array<{ delayMs: number; run: () => void }> = [
    { delayMs: 250, run: () => update({ status: 'dispatched' }) },
    {
      delayMs: 600,
      run: () => {
        update({ status: 'running', startedAt: Date.now(), sessionId });
        push({ kind: 'init', sessionId, model: `claude-${run.model}`, cwd: run.projectId, permissionMode: run.permissionMode, tools: [...DEFAULT_QUEST_MAX_ALLOWED_TOOLS], mcpServers: [] });
      },
    },
    { delayMs: 1100, run: () => push({ kind: 'text', partial: false, text: `Looking at the request: "${prompt.slice(0, 120)}"` }) },
    { delayMs: 1600, run: () => push({ kind: 'tool_use', toolUseId: 'demo-tool-1', name: 'Read', inputPreview: 'README.md' }) },
    { delayMs: 1900, run: () => push({ kind: 'tool_result', toolUseId: 'demo-tool-1', isError: false, preview: '# tagconn\n\nPixel Office observer…' }) },
    { delayMs: 2400, run: () => push({ kind: 'text', partial: false, text: 'This is a **demo** quest — nothing actually ran on your machine.' }) },
    {
      delayMs: 2800,
      run: () => {
        push({
          kind: 'result',
          subtype: 'success',
          isError: false,
          text: 'Demo quest complete.',
          sessionId,
          costUsd: 0.012,
          durationMs: 2800,
          numTurns: 2,
          usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheCreationTokens: 0 },
        });
        update({
          status: 'succeeded',
          endedAt: Date.now(),
          exitCode: 0,
          eventCount: seq,
          result: { isError: false, subtype: 'success', text: 'Demo quest complete.', costUsd: 0.012, durationMs: 2800, numTurns: 2, usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheCreationTokens: 0 } },
        });
      },
    },
  ];
  for (const step of steps) setTimeout(step.run, step.delayMs);
}

export function startDemoQuest(req: RunStartRequest, createdBy: string, hooks: DemoRunHooks): Run {
  const id = nextRunId();
  const run: Run = {
    id,
    kind: 'quest',
    projectId: req.projectId,
    threadId: id,
    heroId: req.heroId,
    status: 'queued',
    prompt: req.prompt.slice(0, 2000),
    permissionMode: req.permissionMode ?? 'acceptEdits',
    model: req.model ?? 'sonnet',
    createdBy,
    createdAt: Date.now(),
    eventCount: 0,
    truncated: false,
  };
  hooks.upsertRun(run);
  playDemoQuest(run, req.prompt, hooks);
  return run;
}

export function followUpDemoQuest(req: RunFollowUpRequest, hooks: DemoFollowUpHooks): Run {
  const original = hooks.getRun(req.runId);
  if (!original) throw new Error(`Unknown demo run "${req.runId}"`);
  const id = nextRunId();
  const run: Run = {
    ...original,
    id,
    threadId: original.threadId,
    parentRunId: original.id,
    status: 'queued',
    endReason: undefined,
    prompt: req.prompt.slice(0, 2000),
    resumeSessionId: original.sessionId,
    sessionId: undefined,
    createdAt: Date.now(),
    startedAt: undefined,
    endedAt: undefined,
    exitCode: undefined,
    error: undefined,
    result: undefined,
    eventCount: 0,
    truncated: false,
  };
  hooks.upsertRun(run);
  playDemoQuest(run, req.prompt, hooks);
  return run;
}

export function stopDemoQuest(runId: string, hooks: Pick<DemoFollowUpHooks, 'upsertRun' | 'getRun'>): Run {
  const run = hooks.getRun(runId);
  if (!run) throw new Error(`Unknown demo run "${runId}"`);
  const reason: RunEndReason = 'stopped_by_user';
  const stopped: Run = { ...run, status: 'stopped', endReason: reason, endedAt: Date.now(), exitCode: null };
  hooks.upsertRun(stopped);
  return stopped;
}
