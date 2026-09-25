import { z } from 'zod';
import type { AttributionWriteCommand, AttributionWriteResult } from './attribution.js';
import type { Ack } from './socket.js';

/**
 * M8 orchestrator runner (8k). Contract between the server, the host runner daemon (`apps/runner`)
 * and the browser. See docs/design/runner-and-helpdesk.md.
 *
 * Direction summary:
 *   browser --(REST / socket /office, admin session)--> server --(socket /runner, runner token)--> runner
 *   runner spawns `claude -p` (stream-json), normalizes each line into a RunEvent, and streams it back.
 */

// ------------------------------------------------------------------ constants

/** socket.io namespace the host runner connects to (outbound from the host). */
export const RUNNER_NAMESPACE = '/runner';
/** Bumped on any breaking change to the runner <-> server protocol. */
export const RUNNER_PROTOCOL_VERSION = 1;
/** Header carrying the runner token (used by `pnpm office:pair` to mint pairing codes). */
export const RUNNER_TOKEN_HEADER = 'x-tagconn-runner-token';
/** Optional header the hook adds when TAGCONN_RUN_ID is set: a correlation hint, never authority. */
export const RUN_ID_HEADER = 'x-tagconn-run-id';

/** Environment variables the runner sets on every spawned `claude` (inherited by hooks). */
export const RUN_ENV = {
  runId: 'TAGCONN_RUN_ID',
  runKind: 'TAGCONN_RUN_KIND',
  /** "off" makes office-hook.sh skip the .tagconn attribution write (receptionist runs). */
  attribution: 'TAGCONN_ATTRIBUTION',
} as const;

/** Env vars the runner always removes before spawning, so runs use the subscription login only. */
export const RUN_ENV_STRIP_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_BEARER_TOKEN_BEDROCK'] as const;

/** Runner token format (same shape as the hook token the installer generates). */
export const RUNNER_TOKEN_RE = /^[0-9a-f]{32,128}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Claude session ids are UUIDs today; keep this permissive but shell/argv safe. */
export const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
/**
 * One Claude Code permission rule, e.g. `Read`, `Bash(git diff:*)`, `Read(~/.ssh/**)`, `mcp__srv__tool`.
 * No commas (lists are passed comma-joined), no newlines, no nested parentheses.
 */
export const TOOL_RULE_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^\n\r(),]{1,180}\))?$/;

export const RUN_KINDS = ['quest', 'receptionist'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'bypassPermissions'] as const;
export type RunPermissionMode = (typeof RUN_PERMISSION_MODES)[number];

/** Ordering used for caps: a run's mode must rank <= the runner's `maxPermissionMode`. */
export const PERMISSION_MODE_RANK: Record<RunPermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
};
export const permissionModeWithin = (mode: RunPermissionMode, max: RunPermissionMode): boolean =>
  PERMISSION_MODE_RANK[mode] <= PERMISSION_MODE_RANK[max];

export const RUN_MODELS = ['opus', 'sonnet', 'haiku'] as const;
export type RunModel = (typeof RUN_MODELS)[number];

export const RUN_STATUSES = [
  'queued', // accepted by the server, waiting for a runner slot
  'dispatched', // sent to the runner, not yet spawned
  'running', // process alive
  'succeeded',
  'failed',
  'stopped', // user pressed Stop
  'timeout',
  'rejected', // runner or server refused (dir/mode/capability/policy)
  'lost', // runner disconnected or server restarted and the runner no longer knows the run
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'stopped', 'timeout', 'rejected', 'lost'] as const;
export const isTerminalRunStatus = (s: RunStatus): boolean => (TERMINAL_RUN_STATUSES as readonly string[]).includes(s);

export const RUN_END_REASONS = [
  'exit',
  'stopped_by_user',
  'timeout',
  'dir_not_allowed',
  'mode_not_allowed',
  'concurrency',
  'spawn_failed',
  'capability_missing',
  'policy_violation', // receptionist used a tool outside its allowlist -> killed
  'output_cap',
  'runner_shutdown',
  'invalid_command',
] as const;
export type RunEndReason = (typeof RUN_END_REASONS)[number];

// ------------------------------------------------------------------ browser -> server requests

const PromptSchema = z.string().trim().min(1).max(100_000); // server also enforces runner.maxPromptChars

export const RunStartRequestSchema = z.strictObject({
  /** Target floor. The server resolves the project's host cwd; the browser never sends a path. */
  projectId: z.string().min(1).max(200),
  prompt: PromptSchema,
  /** Optional hero (8i) to hand the quest to; see "Assigning to a hero" in the design doc. */
  heroId: z.string().min(1).max(200).optional(),
  /** Must be in settings.runner.allowedPermissionModes; defaults to settings.runner.permissionMode. */
  permissionMode: z.enum(RUN_PERMISSION_MODES).optional(),
  model: z.enum(RUN_MODELS).optional(),
});
export type RunStartRequest = z.infer<typeof RunStartRequestSchema>;

export const RunFollowUpRequestSchema = z.strictObject({
  runId: z.string().regex(UUID_RE),
  prompt: PromptSchema,
});
export type RunFollowUpRequest = z.infer<typeof RunFollowUpRequestSchema>;

export const RunListQuerySchema = z.strictObject({
  projectId: z.string().min(1).max(200).optional(),
  kind: z.enum(RUN_KINDS).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type RunListQuery = z.input<typeof RunListQuerySchema>;

// ------------------------------------------------------------------ run events (runner -> server -> browser)

export const RunUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheCreationTokens: z.number().int().min(0),
});
export type RunUsage = z.infer<typeof RunUsageSchema>;

const Str = (max: number) => z.string().max(max);

/**
 * One normalized stream-json line. The runner maps raw CLI output to these kinds and truncates
 * previews to the limits in RunStartCommand.limits; the server redacts every string again before
 * storing or broadcasting (settings.ingest.redactPatterns).
 */
export const RunEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('init'),
    sessionId: z.string().regex(CLAUDE_SESSION_ID_RE),
    model: Str(100).optional(),
    cwd: Str(4096).optional(),
    permissionMode: Str(40).optional(),
    /** Tool names the CLI exposed to the model; the runner checks receptionist runs against this. */
    tools: z.array(Str(200)).max(500),
  }),
  z.strictObject({
    kind: z.literal('text'),
    /** true = streaming delta (`--include-partial-messages`), false = a complete assistant text block. */
    partial: z.boolean(),
    text: Str(64_000),
  }),
  z.strictObject({
    kind: z.literal('tool_use'),
    toolUseId: Str(200),
    name: Str(200),
    /** Compact one-line summary, e.g. file path or command; truncated to limits.previewChars. */
    inputPreview: Str(8_000),
  }),
  z.strictObject({
    kind: z.literal('tool_result'),
    toolUseId: Str(200),
    isError: z.boolean(),
    preview: Str(8_000),
  }),
  z.strictObject({
    kind: z.literal('result'),
    /** CLI `result.subtype`: success | error_max_turns | error_during_execution | ... */
    subtype: Str(60),
    isError: z.boolean(),
    text: Str(64_000).optional(),
    sessionId: z.string().regex(CLAUDE_SESSION_ID_RE).optional(),
    /** The CLI's own estimate; on a subscription this is informational, not a bill. */
    costUsd: z.number().min(0).optional(),
    durationMs: z.number().int().min(0).optional(),
    numTurns: z.number().int().min(0).optional(),
    usage: RunUsageSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('notice'),
    level: z.enum(['info', 'warn', 'error']),
    /** stderr lines, truncation notices, policy violations. */
    message: Str(4_000),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventKind = RunEvent['kind'];

export const RunEventEnvelopeSchema = z.strictObject({
  runId: z.string().regex(UUID_RE),
  /** Monotonic per run, starting at 1. The server drops duplicates (runner replays after reconnect). */
  seq: z.number().int().min(1),
  ts: z.number().int(),
  event: RunEventSchema,
});
export type RunEventEnvelope = z.infer<typeof RunEventEnvelopeSchema>;

export const RunEndSchema = z.strictObject({
  runId: z.string().regex(UUID_RE),
  status: z.enum(['succeeded', 'failed', 'stopped', 'timeout', 'rejected']),
  reason: z.enum(RUN_END_REASONS),
  exitCode: z.number().int().nullable(),
  signal: Str(20).nullable(),
  message: Str(2_000).optional(),
});
export type RunEnd = z.infer<typeof RunEndSchema>;

// ------------------------------------------------------------------ server-side records (to browser)

export interface RunResultSummary {
  isError: boolean;
  subtype: string;
  /** Final answer text, truncated to 8k chars (full text is in the run events). */
  text?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  usage?: RunUsage;
}

export interface Run {
  id: string;
  kind: RunKind;
  /** Quest floor, or the project a project-scoped receptionist conversation reads. */
  projectId?: string;
  /** Receptionist conversation this turn belongs to. */
  conversationId?: string;
  /** First run of a follow-up chain (equals `id` for a root run). */
  threadId: string;
  parentRunId?: string;
  heroId?: string;
  status: RunStatus;
  endReason?: RunEndReason;
  /** Redacted, truncated (2k chars) prompt preview. */
  prompt: string;
  permissionMode: RunPermissionMode;
  model: RunModel;
  /** Claude session id from the `init` event (authoritative correlation to hook sessions). */
  sessionId?: string;
  resumeSessionId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  error?: string;
  result?: RunResultSummary;
  /** Events stored for this run and whether the cap cut the stream. */
  eventCount: number;
  truncated: boolean;
}

export interface RunDetail {
  run: Run;
  events: RunEventEnvelope[];
}

export interface RunnerCapabilities {
  /** `claude -p` reads the prompt from stdin (preferred: keeps prompts off argv/ps). */
  stdinPrompt: boolean;
  includePartialMessages: boolean;
  settingSources: boolean;
  strictMcpConfig: boolean;
  /** bubblewrap available for the receptionist read-only sandbox. */
  bwrap: boolean;
}

export interface RunnerStatus {
  connected: boolean;
  runnerId?: string;
  hostname?: string;
  version?: string;
  claudeVersion?: string;
  capabilities?: RunnerCapabilities;
  /** Effective limit: min(settings.runner.maxConcurrent, runner-local maxConcurrent). */
  maxConcurrent: number;
  maxPermissionMode?: RunPermissionMode;
  activeRuns: number;
  queuedRuns: number;
  connectedAt?: number;
  /** Runner-side realpaths (admin-only data: host paths). */
  allowedProjectDirs: string[];
  readOnlyProjectDirs: string[];
  /** Receptionist sandbox the runner will use ("none" when bwrap is unavailable or disabled). */
  receptionistSandbox?: 'bwrap' | 'none';
}

// ------------------------------------------------------------------ server <-> runner protocol

const AbsPath = z.string().min(1).max(4096).startsWith('/');

export const RunnerCapabilitiesSchema = z.strictObject({
  stdinPrompt: z.boolean(),
  includePartialMessages: z.boolean(),
  settingSources: z.boolean(),
  strictMcpConfig: z.boolean(),
  bwrap: z.boolean(),
});

export const RunnerHelloSchema = z.strictObject({
  protocol: z.literal(RUNNER_PROTOCOL_VERSION),
  runnerId: z.string().regex(UUID_RE),
  version: Str(40),
  hostname: Str(255),
  platform: Str(40),
  claudeVersion: Str(80).optional(),
  capabilities: RunnerCapabilitiesSchema,
  maxConcurrent: z.number().int().min(1).max(16),
  maxPermissionMode: z.enum(RUN_PERMISSION_MODES),
  allowedProjectDirs: z.array(AbsPath).max(200),
  readOnlyProjectDirs: z.array(AbsPath).max(200),
  receptionistSandbox: z.enum(['bwrap', 'none']),
  /** Runs this runner is still executing (used to reconcile after a reconnect or server restart). */
  activeRunIds: z.array(z.string().regex(UUID_RE)).max(64),
});
export type RunnerHello = z.infer<typeof RunnerHelloSchema>;

export interface RunnerHelloAckData {
  serverVersion: string;
  /** Active runs the server no longer knows about: the runner must kill them. */
  killRunIds: string[];
}

export const RunLimitsSchema = z.strictObject({
  /** Hard cap on events forwarded per run; past it the runner emits one notice and kills the run (reason output_cap). */
  maxEvents: z.number().int().min(10).max(100_000),
  /** Cap on the sum of forwarded event bytes per run (same behavior). */
  maxEventBytes: z.number().int().min(10_000).max(64 * 1024 * 1024),
  /** tool_use/tool_result preview truncation. */
  previewChars: z.number().int().min(100).max(8_000),
});
export type RunLimits = z.infer<typeof RunLimitsSchema>;

/**
 * server -> runner. The runner RE-VALIDATES everything with its local config (defense in depth):
 * projectDir realpath inside allowedProjectDirs (or readOnlyProjectDirs when readOnly), mode within
 * maxPermissionMode, bypassPermissions refused unless the local config allows it, and for
 * `readOnly` runs it ignores the tool lists below and applies RECEPTIONIST_* constants.
 */
export const RunStartCommandSchema = z.strictObject({
  runId: z.string().regex(UUID_RE),
  kind: z.enum(RUN_KINDS),
  /** Host path; `null` = receptionist "general" scope (runner uses its neutral empty dir). */
  projectDir: AbsPath.nullable(),
  prompt: PromptSchema,
  permissionMode: z.enum(RUN_PERMISSION_MODES),
  model: z.enum(RUN_MODELS),
  resumeSessionId: z.string().regex(CLAUDE_SESSION_ID_RE).optional(),
  allowedTools: z.array(z.string().regex(TOOL_RULE_RE)).max(100),
  disallowedTools: z.array(z.string().regex(TOOL_RULE_RE)).max(200),
  maxTurns: z.number().int().min(1).max(500).optional(),
  timeoutSec: z.number().int().min(10).max(86_400),
  appendSystemPrompt: Str(8_000).optional(),
  /** Receptionist: forbid every write tool, enforce the tool allowlist, sandbox if available. */
  readOnly: z.boolean(),
  /** Receptionist general scope: also add the tagconn repo (runner knows its path) via --add-dir. */
  addTagconnDocs: z.boolean().default(false),
  /** Receptionist: whether WebFetch stays in the allowlist for this run. */
  allowWebFetch: z.boolean().default(true),
  allowWebSearch: z.boolean().default(true),
  partialMessages: z.boolean().default(true),
  limits: RunLimitsSchema,
});
export type RunStartCommand = z.infer<typeof RunStartCommandSchema>;
export type RunStartCommandInput = z.input<typeof RunStartCommandSchema>;

export const RunStopCommandSchema = z.strictObject({
  runId: z.string().regex(UUID_RE),
  reason: z.enum(['stopped_by_user', 'timeout', 'runner_shutdown']),
});
export type RunStopCommand = z.infer<typeof RunStopCommandSchema>;

/** Events the runner emits on RUNNER_NAMESPACE. */
export interface RunnerToServerEvents {
  'runner:hello': (hello: RunnerHello, ack: Ack<RunnerHelloAckData>) => void;
  'run:event': (e: RunEventEnvelope) => void;
  'run:end': (e: RunEnd) => void;
}

/** Events the server emits to the runner. */
export interface ServerToRunnerEvents {
  /** ok = the process was spawned (pid) ; error = refused (runner also sends run:end status rejected). */
  'run:start': (cmd: RunStartCommand, ack: Ack<{ pid: number | null }>) => void;
  'run:stop': (cmd: RunStopCommand) => void;
  /** Explicit "save office profile to project" (8j); the runner is the only writer on the host. */
  'attribution:write': (cmd: AttributionWriteCommand, ack: Ack<AttributionWriteResult>) => void;
}

/** socket.io `auth` payload of the runner connection. */
export interface RunnerHandshakeAuth {
  token: string;
  runnerId: string;
  protocol: number;
}

// ------------------------------------------------------------------ browser <-> server (namespace /office, admin room only)

export interface RunsServerToClientEvents {
  'run:upsert': (r: Run) => void;
  'run:event': (e: RunEventEnvelope) => void;
  'runner:status': (s: RunnerStatus) => void;
}

export interface RunsClientToServerEvents {
  'runs:list': (q: RunListQuery, ack: Ack<Run[]>) => void;
  'runs:get': (runId: string, ack: Ack<RunDetail>) => void;
  'runs:start': (req: RunStartRequest, ack: Ack<Run>) => void;
  'runs:followUp': (req: RunFollowUpRequest, ack: Ack<Run>) => void;
  'runs:stop': (runId: string, ack: Ack<Run>) => void;
  'runner:getStatus': (ack: Ack<RunnerStatus>) => void;
}

// ------------------------------------------------------------------ runner-local config (host file)

/**
 * `<configDir>/runner.json` (mode 0600), written by `scripts/install.ts`. It is the HOST-SIDE
 * authority for what the runner may do; the server's settings can only narrow it, never widen it.
 */
export const RunnerLocalConfigSchema = z.object({
  url: z.string().url().default('http://127.0.0.1:4317'),
  token: z.string().regex(RUNNER_TOKEN_RE),
  /** Generated on first start and persisted. */
  runnerId: z.string().regex(UUID_RE).optional(),
  /** Quest runs may execute in these dirs (compared by realpath, prefix + path separator). */
  allowedProjectDirs: z.array(AbsPath).default([]),
  /** Receptionist project-scope runs may additionally READ these dirs. */
  readOnlyProjectDirs: z.array(AbsPath).default([]),
  maxConcurrent: z.number().int().min(1).max(16).default(2),
  maxPermissionMode: z.enum(RUN_PERMISSION_MODES).default('acceptEdits'),
  /** bypassPermissions is refused unless this is true AND maxPermissionMode allows it. */
  allowBypassPermissions: z.boolean().default(false),
  claudePath: z.string().min(1).default('claude'),
  /** Default: $XDG_STATE_HOME/tagconn or ~/.local/state/tagconn (receptionist neutral dir lives here). */
  stateDir: AbsPath.optional(),
  receptionistSandbox: z.enum(['auto', 'bwrap', 'none']).default('auto'),
  /** A single stream-json line longer than this is dropped with a notice. */
  maxLineBytes: z
    .number()
    .int()
    .min(64 * 1024)
    .default(1024 * 1024),
  /** SIGTERM -> SIGKILL grace when stopping a process group. */
  killGraceMs: z.number().int().min(100).max(60_000).default(5_000),
  /** Events kept per active run while disconnected, replayed on reconnect. */
  offlineBufferEvents: z.number().int().min(0).max(100_000).default(2_000),
});
export type RunnerLocalConfig = z.infer<typeof RunnerLocalConfigSchema>;

/** Minimal internal port the receptionist module uses to dispatch runs (implemented by modules/runs). */
export interface RunDispatcher {
  startReceptionistTurn(input: {
    conversationId: string;
    projectId: string | null;
    prompt: string;
    resumeSessionId?: string;
  }): Run;
  stop(runId: string, reason: 'stopped_by_user'): Run;
  get(runId: string): Run | undefined;
}
