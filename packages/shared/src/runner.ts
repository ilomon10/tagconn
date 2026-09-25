import { z } from 'zod';
import type { AttributionWriteCommand, AttributionWriteResult } from './attribution.js';
import { NONCE_RE, PROOF_RE } from './auth.js';
import type { Ack } from './socket.js';

/**
 * M8 orchestrator runner (8k). Contract between the server, the host runner daemon (`apps/runner`)
 * and the browser. See docs/design/runner-and-helpdesk.md.
 *
 *   browser --(REST / socket /office, admin session)--> server --(socket /runner, HMAC-verified)--> runner
 *
 * The HOST is the authority: `<configDir>/runner.json` (RunnerLocalConfigSchema) bounds everything;
 * the server can only narrow it. Honest limit (T6): a compromised server can make the runner do
 * anything a quest may do inside the allowed + trusted dirs, up to the local mode cap and tool policy.
 */

// ------------------------------------------------------------------ constants

export const RUNNER_NAMESPACE = '/runner';
/** Bumped on any breaking change to the runner <-> server protocol. */
export const RUNNER_PROTOCOL_VERSION = 1;
/** Optional header the hook adds when TAGCONN_RUN_ID is set: a correlation hint, never authority. */
export const RUN_ID_HEADER = 'x-tagconn-run-id';

/** Environment variables the runner sets on every spawned `claude` (inherited by hooks). */
export const RUN_ENV = {
  runId: 'TAGCONN_RUN_ID',
  runKind: 'TAGCONN_RUN_KIND',
  /** "off" makes office-hook.sh skip the .tagconn attribution work (receptionist runs). */
  attribution: 'TAGCONN_ATTRIBUTION',
} as const;

/** Base env allowlist; runner.json `passEnv` may add names (the server never sets env). */
export const RUN_ENV_BASE_ALLOWLIST = ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TZ', 'SHELL', 'TMPDIR'] as const;
/** Env vars always removed (even if listed in passEnv), so runs use the subscription login only. */
export const RUN_ENV_STRIP_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_BEARER_TOKEN_BEDROCK'] as const;

/** Runner token format (same shape as the hook token the installer generates). */
export const RUNNER_TOKEN_RE = /^[0-9a-f]{32,128}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Claude session ids are UUIDs today; keep this permissive but argv safe. */
export const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
/**
 * One Claude Code permission rule, e.g. `Read`, `Bash(git diff:*)`, `Edit(.git/**)`, `WebFetch(domain:x.org)`.
 * No commas (lists are passed comma-joined), no newlines, no nested parentheses, no NUL.
 */
export const TOOL_RULE_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^\n\r\0(),]{1,180}\))?$/;
/** A bare DNS name for WebFetch allowlists (no scheme, port, path or wildcard). */
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const RUN_KINDS = ['quest', 'receptionist'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * tagconn's permission-mode vocabulary. CLI 2.1.282 accepts: acceptEdits, auto, bypassPermissions,
 * manual, dontAsk, plan (NOT "default"). The runner maps each contract mode to the first CLI value
 * in CLI_PERMISSION_MODE_CANDIDATES that the probe found in `capabilities.permissionModes`, and
 * rejects the run (`mode_not_allowed`) when none is supported.
 */
export const RUN_PERMISSION_MODES = ['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
export type RunPermissionMode = (typeof RUN_PERMISSION_MODES)[number];

export const CLI_PERMISSION_MODE_CANDIDATES: Record<RunPermissionMode, readonly string[]> = {
  plan: ['plan'],
  dontAsk: ['dontAsk'],
  default: ['manual', 'default'],
  acceptEdits: ['acceptEdits'],
  auto: ['auto'],
  bypassPermissions: ['bypassPermissions'],
};

/**
 * Ordering used for caps: a run's mode must rank <= the runner's `maxPermissionMode`.
 * Every run also gets `--permission-prompts=none`, so "default"/"dontAsk" deny anything not pre-allowed.
 * `auto` ranks above acceptEdits: it lets the CLI approve actions on its own (exact semantics TBD by SC3).
 */
export const PERMISSION_MODE_RANK: Record<RunPermissionMode, number> = {
  plan: 0,
  dontAsk: 1,
  default: 2,
  acceptEdits: 3,
  auto: 4,
  bypassPermissions: 5,
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
  'rejected', // runner or server refused (dir/trust/mode/capability/policy)
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
  'dir_not_trusted', // the CLI never accepted the trust dialog for this dir, and no runner.json override
  'mode_not_allowed',
  'tool_not_allowed', // a requested allow rule is outside runner.json questToolPolicy
  'resume_not_allowed', // resume id was not created by this runner
  'concurrency',
  'spawn_failed',
  'capability_missing',
  'policy_violation', // receptionist: init.tools != --tools set, mcp__* present, or foreign tool_use -> killed
  'output_cap',
  'runner_shutdown',
  'invalid_command',
] as const;
export type RunEndReason = (typeof RUN_END_REASONS)[number];

// ------------------------------------------------------------------ browser -> server requests

/** Prompts may not contain NUL (argv/C-string truncation); the runner also strips/rejects it. */
const PromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(100_000) // server additionally enforces runner.maxPromptChars
  .refine((s) => !s.includes('\0'), 'prompt must not contain NUL');

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
  /** Must be a quest run (receptionist turns go through receptionist:send). */
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
 * One normalized stream-json line. The runner truncates previews to RunStartCommand.limits; the
 * server re-applies its own caps and redacts every string before storing or broadcasting.
 */
export const RunEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('init'),
    sessionId: z.string().regex(CLAUDE_SESSION_ID_RE),
    model: Str(100).optional(),
    cwd: Str(4096).optional(),
    permissionMode: Str(40).optional(),
    /** Tool names the CLI exposed; receptionist runs require EXACT equality with the --tools set. */
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
    /** stderr lines (bounded per run), truncation notices, policy violations. */
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
  /** Only ever a sessionId of an earlier run in the same thread/conversation (server + runner check). */
  resumeSessionId?: string;
  /** Admin session that started it (audit). */
  createdBy: string;
  /** Runner the run was dispatched to; events/ends from any other runner are ignored. */
  runnerId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  error?: string;
  result?: RunResultSummary;
  eventCount: number;
  truncated: boolean;
}

export interface RunDetail {
  run: Run;
  events: RunEventEnvelope[];
}

/** Probed by the runner at startup (`claude --version`, `claude --help`, optional probe runs). */
export interface RunnerCapabilities {
  /** `claude -p` reads the prompt from stdin (preferred: keeps prompts off argv/ps). */
  stdinPrompt: boolean;
  includePartialMessages: boolean;
  settingSources: boolean;
  strictMcpConfig: boolean;
  /** `--tools <list>`: exact built-in tool set. REQUIRED for receptionist runs. */
  tools: boolean;
  /** `--permission-prompts none`. REQUIRED for every run. */
  permissionPrompts: boolean;
  disableSlashCommands: boolean;
  /** `--restricted`: file tools limited to cwd + --add-dir, exec tools removed, settings ignored. */
  restricted: boolean;
  /** `--safe-mode`: no CLAUDE.md/skills/plugins/hooks/MCP. */
  safeMode: boolean;
  /** CLI values accepted by --permission-mode (e.g. ["acceptEdits","auto","bypassPermissions","manual","dontAsk","plan"]). */
  permissionModes: string[];
  /** bubblewrap available AND the sandboxed probe turn succeeded. */
  bwrap: boolean;
  /** `systemd-run --user --scope` usable for per-run resource limits. */
  systemdScope: boolean;
}

export interface RunnerStatus {
  connected: boolean;
  /** True only after the mutual HMAC proof succeeded. */
  verified: boolean;
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
  /** Host-side maximum quest allowlist (runner.json questToolPolicy.maxAllowedTools). */
  questMaxAllowedTools: string[];
  receptionistSandbox?: 'bwrap' | 'none';
  /** Receptionist hardening flags the runner will use (from the probe). */
  receptionistFlags?: { restricted: boolean; safeModeProjectScope: boolean };
}

// ------------------------------------------------------------------ server <-> runner protocol

const AbsPath = z
  .string()
  .min(1)
  .max(4096)
  .startsWith('/')
  .refine((s) => !s.includes('\0'), 'path must not contain NUL');

/** socket.io `auth` payload of the runner connection. The raw token is NEVER sent. */
export const RunnerHandshakeAuthSchema = z.strictObject({
  runnerId: z.string().regex(UUID_RE),
  protocol: z.literal(RUNNER_PROTOCOL_VERSION),
  /** Nr: 32 random bytes base64url, fresh per connection. */
  nonce: z.string().regex(NONCE_RE),
});
export type RunnerHandshakeAuth = z.infer<typeof RunnerHandshakeAuthSchema>;

/** server -> runner right after connect: Ns + HMAC(token, proofMessage(runner,'server',Nr,Ns)). */
export const RunnerChallengeSchema = z.strictObject({
  nonce: z.string().regex(NONCE_RE),
  proof: z.string().regex(PROOF_RE),
});
export type RunnerChallenge = z.infer<typeof RunnerChallengeSchema>;

/** runner -> server: HMAC(token, proofMessage(runner,'runner',Ns,Nr)). */
export const RunnerProveSchema = z.strictObject({ proof: z.string().regex(PROOF_RE) });
export type RunnerProve = z.infer<typeof RunnerProveSchema>;

export const RunnerCapabilitiesSchema = z.strictObject({
  stdinPrompt: z.boolean(),
  includePartialMessages: z.boolean(),
  settingSources: z.boolean(),
  strictMcpConfig: z.boolean(),
  tools: z.boolean(),
  permissionPrompts: z.boolean(),
  disableSlashCommands: z.boolean(),
  restricted: z.boolean(),
  safeMode: z.boolean(),
  permissionModes: z.array(Str(40)).max(20),
  bwrap: z.boolean(),
  systemdScope: z.boolean(),
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
  questMaxAllowedTools: z.array(z.string().regex(TOOL_RULE_RE)).max(200),
  receptionistSandbox: z.enum(['bwrap', 'none']),
  receptionistFlags: z.strictObject({ restricted: z.boolean(), safeModeProjectScope: z.boolean() }),
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
  /** Hard cap on events forwarded per run; past it: one notice, then stop with output_cap. */
  maxEvents: z.number().int().min(10).max(100_000),
  /** Cap on the sum of forwarded event bytes per run (same behavior). */
  maxEventBytes: z.number().int().min(10_000).max(64 * 1024 * 1024),
  /** tool_use/tool_result preview truncation. */
  previewChars: z.number().int().min(100).max(8_000),
});
export type RunLimits = z.infer<typeof RunLimitsSchema>;

/**
 * server -> runner. The runner RE-VALIDATES everything against runner.json (defense in depth):
 * realpath(projectDir) inside allowedProjectDirs AND trusted by the CLI (or trustOverrideDirs);
 * mode within maxPermissionMode (bypass also needs allowBypassPermissions); allowedTools within
 * questToolPolicy (Bash* only if listed locally); questToolPolicy.alwaysDeny appended; resume id
 * must be one this runner created. For `readOnly` runs it ignores allowedTools/permissionMode and
 * builds the receptionist argv from RECEPTIONIST_* constants (server `disallowedTools` are kept:
 * deny only narrows). The realpath result, not the sent string, is used as cwd / --add-dir.
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
  /** Receptionist: exact tool set, no writes, sandbox if available, constant system prompt. */
  readOnly: z.boolean(),
  /** Receptionist general scope: --add-dir the runner's docs-only copy (never the repo root). */
  addTagconnDocs: z.boolean().default(false),
  allowWebSearch: z.boolean().default(true),
  /** Receptionist: WebFetch is in --tools only when this is non-empty; each becomes WebFetch(domain:x). */
  webFetchDomains: z.array(z.string().regex(DOMAIN_RE)).max(50).default([]),
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

/**
 * Events the runner emits on RUNNER_NAMESPACE. Before verification the server accepts ONLY
 * 'runner:prove'; anything else disconnects the socket.
 */
export interface RunnerToServerEvents {
  'runner:prove': (p: RunnerProve, ack: Ack<true>) => void;
  'runner:hello': (hello: RunnerHello, ack: Ack<RunnerHelloAckData>) => void;
  'run:event': (e: RunEventEnvelope) => void;
  'run:end': (e: RunEnd) => void;
}

/**
 * Events the server emits to the runner. The runner ignores (and disconnects on) everything except
 * 'runner:challenge' until it has verified the server's proof.
 */
export interface ServerToRunnerEvents {
  'runner:challenge': (c: RunnerChallenge) => void;
  /** ok = the process was spawned (pid); error = refused (runner also sends run:end status rejected). */
  'run:start': (cmd: RunStartCommand, ack: Ack<{ pid: number | null }>) => void;
  'run:stop': (cmd: RunStopCommand) => void;
  /** Explicit "save office profile to project" (8j); only inside allowedProjectDirs. */
  'attribution:write': (cmd: AttributionWriteCommand, ack: Ack<AttributionWriteResult>) => void;
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
  /** Quest runs only; receptionist turns are stopped via receptionist:stop. */
  'runs:stop': (runId: string, ack: Ack<Run>) => void;
  'runner:getStatus': (ack: Ack<RunnerStatus>) => void;
}

// ------------------------------------------------------------------ runner-local config (host file)

/** Local denies appended to every quest (settings/agent/git/MCP config stay untouchable by quests). */
export const DEFAULT_QUEST_ALWAYS_DENY = [
  'Edit(.claude/**)',
  'Write(.claude/**)',
  'Edit(.git/**)',
  'Write(.git/**)',
  'Edit(.mcp.json)',
  'Write(.mcp.json)',
] as const;

/** Default host-side maximum quest allowlist. No Bash: Bash rules must be listed here explicitly. */
export const DEFAULT_QUEST_MAX_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'WebSearch',
  'TodoWrite',
  'Agent',
  'Task',
] as const;

/**
 * `<configDir>/runner.json` (mode 0600; the runner refuses group/world-readable files), written by
 * `scripts/install.ts`. It is the HOST-SIDE authority; server settings can only narrow it.
 */
export const RunnerLocalConfigSchema = z.object({
  url: z.url().default('http://127.0.0.1:4317'),
  token: z.string().regex(RUNNER_TOKEN_RE),
  /** Generated on first start and persisted. */
  runnerId: z.string().regex(UUID_RE).optional(),
  /** Quests (and project-scope receptionist) may run in these dirs (realpath, prefix + path separator). */
  allowedProjectDirs: z.array(AbsPath).default([]),
  /**
   * Dirs treated as trusted even if ~/.claude.json has no hasTrustDialogAccepted for them.
   * Default: none; the runner otherwise requires the CLI's own trust flag (parent-dir semantics TBD by SC3).
   */
  trustOverrideDirs: z.array(AbsPath).default([]),
  questToolPolicy: z
    .object({
      /** Server-sent allow rules outside this list are refused (reason tool_not_allowed). */
      maxAllowedTools: z.array(z.string().regex(TOOL_RULE_RE)).default([...DEFAULT_QUEST_MAX_ALLOWED_TOOLS]),
      /** Appended to --disallowedTools on every quest. */
      alwaysDeny: z.array(z.string().regex(TOOL_RULE_RE)).default([...DEFAULT_QUEST_ALWAYS_DENY]),
    })
    .prefault({}),
  maxConcurrent: z.number().int().min(1).max(16).default(2),
  maxPermissionMode: z.enum(RUN_PERMISSION_MODES).default('acceptEdits'),
  /** bypassPermissions is refused unless this is true AND maxPermissionMode allows it. */
  allowBypassPermissions: z.boolean().default(false),
  /** Extra env var names passed through to claude (RUN_ENV_STRIP_PREFIXES still win). */
  passEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).default([]),
  claudePath: z.string().min(1).default('claude'),
  /** Default: $XDG_STATE_HOME/tagconn or ~/.local/state/tagconn (neutral dir, docs copy, session ledger). */
  stateDir: AbsPath.optional(),
  receptionistSandbox: z.enum(['auto', 'bwrap', 'none']).default('auto'),
  /** Wrap each run in `systemd-run --user --scope` (KillMode=control-group, MemoryMax, TasksMax) when available. */
  processIsolation: z.enum(['auto', 'systemd-scope', 'none']).default('auto'),
  memoryMax: z.string().regex(/^\d+[KMGT]?$/).default('4G'),
  tasksMax: z.number().int().min(16).max(65_536).default(512),
  /** A single stream-json line (also a partial line buffer) longer than this is dropped with a notice. */
  maxLineBytes: z
    .number()
    .int()
    .min(64 * 1024)
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
  /** stderr lines forwarded per run (rest counted in one notice); each line truncated to 4k. */
  maxStderrLines: z.number().int().min(0).max(10_000).default(200),
  /** SIGTERM -> SIGKILL grace when stopping a process group. */
  killGraceMs: z.number().int().min(100).max(60_000).default(5_000),
  /** Events and bytes kept per active run while disconnected, replayed on reconnect (oldest dropped + notice). */
  offlineBufferEvents: z.number().int().min(0).max(100_000).default(2_000),
  offlineBufferBytes: z
    .number()
    .int()
    .min(0)
    .max(256 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  /** Session ids this runner created (for resume checks) are remembered up to this many. */
  sessionLedgerSize: z.number().int().min(10).max(100_000).default(5_000),
});
export type RunnerLocalConfig = z.infer<typeof RunnerLocalConfigSchema>;

/** Minimal internal port the receptionist module uses to dispatch runs (implemented by modules/runs). */
export interface RunDispatcher {
  startReceptionistTurn(input: {
    conversationId: string;
    projectId: string | null;
    prompt: string;
    /** Must be the conversation's stored sessionId (from an earlier runner-created turn). */
    resumeSessionId?: string;
    createdBy: string;
  }): Run;
  stop(runId: string, reason: 'stopped_by_user'): Run;
  get(runId: string): Run | undefined;
}
