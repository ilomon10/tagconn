// Claude CLI argv builders (docs/design/runner-and-helpdesk.md §2.4 quests, §4.2 the Receptionist).
//
// Rules that apply to EVERY spawn, no exceptions:
//  - value flags use `--flag=value` (never `--flag value`)
//  - `--setting-sources=user` and `--strict-mcp-config` (V14): the runner refuses to build argv at all
//    if the capability probe didn't confirm both (see assertRequiredCapabilities)
//  - `--permission-prompts=none`
//  - the prompt goes on stdin; `-- <prompt>` is only the fallback if stdin isn't supported (V9)

import {
  type ReceptionistScope,
  RECEPTIONIST_BASE_TOOLS,
  RECEPTIONIST_DENY_READ_GLOBS,
  RECEPTIONIST_DISALLOWED_TOOLS,
  RECEPTIONIST_PERMISSION_MODE,
  RECEPTIONIST_SYSTEM_PROMPT,
  RECEPTIONIST_WEBFETCH_DENY_RULES,
  receptionistToolSet,
  type RunModel,
  type RunnerCapabilities,
  type RunPermissionMode,
} from '@tagconn/shared';

export class CapabilityError extends Error {}

/** V14 hard requirement: refuse to spawn ANYTHING without these two flags. */
export function assertRequiredCapabilities(caps: Pick<RunnerCapabilities, 'settingSources' | 'strictMcpConfig' | 'permissionPrompts'>): void {
  if (!caps.settingSources) throw new CapabilityError('capability_missing: --setting-sources not supported by this claude CLI');
  if (!caps.strictMcpConfig) throw new CapabilityError('capability_missing: --strict-mcp-config not supported by this claude CLI');
  if (!caps.permissionPrompts) throw new CapabilityError('capability_missing: --permission-prompts not supported by this claude CLI');
}

export interface StdinOrFallback {
  /** The prompt to send, and whether it goes on stdin (preferred) or must be appended `-- <prompt>`. */
  stdinPrompt: boolean;
  prompt: string;
}

/** Appends the prompt fallback (`-- <prompt>`) only when stdin delivery isn't supported (V9). */
function appendPromptFallback(argv: string[], p: StdinOrFallback): void {
  if (!p.stdinPrompt) argv.push('--', p.prompt);
}

// ------------------------------------------------------------------------------------------------ quests

export interface QuestArgvInput extends StdinOrFallback {
  /** runner.json claudePath (a bare name resolved via PATH, or an absolute path). */
  claudePath: string;
  model: RunModel;
  mode: RunPermissionMode;
  maxTurns?: number;
  resumeSessionId?: string;
  /** Already validated against runner.json questToolPolicy (toolPolicy.ts). */
  allowedTools: readonly string[];
  /** Caller's own denies + questToolPolicy.alwaysDeny, already merged. */
  disallowedTools: readonly string[];
  questMcpConfigPath?: string;
  partialMessages: boolean;
}

export function buildQuestArgv(input: QuestArgvInput): string[] {
  const argv = [input.claudePath, '-p', '--output-format=stream-json', '--verbose'];
  if (input.partialMessages) argv.push('--include-partial-messages');
  argv.push('--setting-sources=user', '--strict-mcp-config');
  if (input.questMcpConfigPath) argv.push(`--mcp-config=${input.questMcpConfigPath}`);
  argv.push(`--permission-mode=${input.mode}`, '--permission-prompts=none', `--model=${input.model}`);
  if (input.maxTurns !== undefined) argv.push(`--max-turns=${input.maxTurns}`);
  if (input.resumeSessionId) argv.push(`--resume=${input.resumeSessionId}`);
  if (input.allowedTools.length > 0) argv.push(`--allowedTools=${input.allowedTools.join(',')}`);
  argv.push(`--disallowedTools=${input.disallowedTools.join(',')}`);
  appendPromptFallback(argv, input);
  return argv;
}

// ------------------------------------------------------------------------------------------------ Receptionist

export interface ReceptionistArgvInput extends StdinOrFallback {
  claudePath: string;
  scope: ReceptionistScope;
  model: RunModel;
  maxTurns: number;
  resumeSessionId?: string;
  webSearch: boolean;
  /** General scope only; ignored (and WebFetch dropped) unless `sandboxed` is also true. */
  webFetchDomains: readonly string[];
  /** bwrap available for this turn. */
  sandboxed: boolean;
  /** Project scope only (receptionist.projectSafeMode, SC3 V5 trade-off). */
  safeMode: boolean;
  /** General scope only: realpath of <stateDir>/receptionist-docs. */
  addDirDocs?: string;
  /** Server `extraDenyReadGlobs` (already formatted as `Read(<glob>)`) plus any server extra denies. */
  extraDisallowedTools: readonly string[];
}

export interface ReceptionistArgvResult {
  argv: string[];
  /** The exact --tools set; the L5 watchdog requires init.tools to equal this exactly. */
  toolSet: string[];
  /** Whether --restricted is set (project scope, and general scope unless the WebFetch variant is active). */
  restricted: boolean;
  /** True only for the general-scope-with-WebFetch variant (requires bwrap; never combined with --restricted). */
  webFetchActive: boolean;
}

/**
 * Builds the common Receptionist argv plus the scope-specific flags (§4.2). Does NOT include the
 * bwrap wrapper (see bwrap.ts) or the leading `bwrap ... --` prefix; the caller prepends that when
 * `sandboxed` is true. When general-scope WebFetch was requested but `sandboxed` is false, WebFetch is
 * dropped from the tool set here (the caller must still emit a notice).
 */
export function buildReceptionistArgv(input: ReceptionistArgvInput): ReceptionistArgvResult {
  const webFetchActive = input.scope === 'general' && input.sandboxed && input.webFetchDomains.length > 0;
  // --restricted is used everywhere EXCEPT the general-scope WebFetch variant (which needs to reach
  // arbitrary allowlisted domains and would lose WebFetch under --restricted, per V6).
  const restricted = !webFetchActive;

  const toolSet = receptionistToolSet({
    scope: input.scope,
    webSearch: input.webSearch,
    webFetchDomains: input.webFetchDomains,
    sandboxed: input.sandboxed,
  });
  const allowedRules = toolSet.flatMap((t) => (t === 'WebFetch' ? input.webFetchDomains.map((d) => `WebFetch(domain:${d})`) : [t]));

  const disallowedTools = [
    ...RECEPTIONIST_DISALLOWED_TOOLS,
    ...RECEPTIONIST_DENY_READ_GLOBS.map((g) => `Read(${g})`),
    ...RECEPTIONIST_WEBFETCH_DENY_RULES,
    ...input.extraDisallowedTools,
  ];

  const argv = [input.claudePath, '-p', '--output-format=stream-json', '--verbose', '--include-partial-messages'];
  argv.push(
    '--setting-sources=user',
    '--strict-mcp-config',
    '--mcp-config={"mcpServers":{}}',
    '--disable-slash-commands',
    `--permission-mode=${RECEPTIONIST_PERMISSION_MODE}`,
    '--permission-prompts=none',
    `--append-system-prompt=${RECEPTIONIST_SYSTEM_PROMPT}`,
    `--model=${input.model}`,
    `--max-turns=${input.maxTurns}`,
  );
  if (input.resumeSessionId) argv.push(`--resume=${input.resumeSessionId}`);

  if (restricted) argv.push('--restricted');
  if (input.scope === 'project' && input.safeMode) argv.push('--safe-mode');
  if (input.scope === 'general' && input.addDirDocs) argv.push(`--add-dir=${input.addDirDocs}`);

  argv.push(`--tools=${toolSet.join(',')}`, `--allowedTools=${allowedRules.join(',')}`, `--disallowedTools=${disallowedTools.join(',')}`);
  appendPromptFallback(argv, input);

  return { argv, toolSet, restricted, webFetchActive };
}

/** Base tool names that are always requested regardless of scope (kept for tests/consumers). */
export const RECEPTIONIST_BASE = RECEPTIONIST_BASE_TOOLS;
