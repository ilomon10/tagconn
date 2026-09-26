// Runner-side validation steps 4-6 of docs/design/runner-and-helpdesk.md §2.3: mode, tools, containment.
// This runs independently of (and in addition to) the server's own checks (defense in depth, T6).

import {
  DEFAULT_QUEST_ALWAYS_DENY,
  isBareWebFetchRule,
  permissionModeWithin,
  QUEST_NEVER_TOOLS,
  QUEST_TOOLS_BASELINE,
  type RunEndReason,
  type RunPermissionMode,
  type RunnerLocalConfig,
} from '@tagconn/shared';

export type PolicyFailure = Extract<RunEndReason, 'mode_not_allowed' | 'tool_not_allowed' | 'isolation_unavailable'>;

export interface PolicyCheckInput {
  mode: RunPermissionMode;
  /** Server-sent allow rules for a quest. Receptionist runs never go through this (fixed tool set). */
  allowedTools: readonly string[];
  /** Probed capability: modes the CLI actually accepted (RunnerCapabilities.permissionModes). */
  availablePermissionModes: readonly string[];
}

export interface PolicyCheckContext {
  maxPermissionMode: RunPermissionMode;
  allowBypassPermissions: boolean;
  questToolPolicy: RunnerLocalConfig['questToolPolicy'];
  /** Whether a systemd scope (cgroup kill) is available for this run, per runner.json processIsolation + probe. */
  systemdScopeAvailable: boolean;
}

export interface PolicyCheckOk {
  ok: true;
  /** disallowedTools to pass on the wire = the caller's own denies + the local alwaysDeny backstop
   *  (+ a hard 'Bash' deny whenever no Bash allow rule was granted: deny beats allow, SC5 H2). */
  disallowedTools: string[];
  /** True if this run needs a systemd scope wrapper (Bash allow rule, or mode auto/bypassPermissions). */
  requiresScope: boolean;
  /**
   * SC5 H2: the exact `--tools` list for this quest, so it is bounded to a known set instead of the
   * CLI's full built-in tool set (which also includes internal delegation/scheduling tools) merged
   * with whatever the user's OWN `~/.claude/settings.json` allows (quests always run with
   * `--setting-sources=user`, so user-level allow rules still apply on top of --allowedTools).
   */
  toolSet: string[];
}

export interface PolicyCheckFail {
  ok: false;
  failure: PolicyFailure;
}

/** `Bash`, `Bash(...)`; anything starting with the literal tool name "Bash". */
function isBashRule(rule: string): boolean {
  return rule === 'Bash' || rule.startsWith('Bash(');
}

/** A rule the CLI would use to grant Bash / auto-approve execution without an explicit allow rule. */
function modeCanExecuteFreely(mode: RunPermissionMode): boolean {
  return mode === 'auto' || mode === 'bypassPermissions';
}

/** The tool NAME a rule string grants, e.g. "Edit(./**)" -> "Edit", "Bash(git *:*)" -> "Bash". */
function toolNameFromRule(rule: string): string {
  const i = rule.indexOf('(');
  return i === -1 ? rule : rule.slice(0, i);
}

/**
 * SC5 H2: the quest's exact `--tools` list. Always the read-only baseline plus the tool NAME of every
 * accepted allow rule; Bash is included only when an explicit local Bash rule was granted (never just
 * because the mode can execute freely); Agent/Task never appear, however `maxAllowedTools` is configured.
 */
function buildQuestToolSet(allowedTools: readonly string[]): string[] {
  const names = new Set<string>(QUEST_TOOLS_BASELINE);
  for (const rule of allowedTools) names.add(toolNameFromRule(rule));
  for (const never of QUEST_NEVER_TOOLS) names.delete(never);
  return [...names];
}

/**
 * Steps 4 (mode), 5 (tools) and 6 (containment) of §2.3, run in order. `disallowedTools` on success
 * is what the caller should merge into `--disallowedTools` (its own server-provided denies are passed
 * in via `callerDisallowedTools`).
 */
export function checkQuestPolicy(
  input: PolicyCheckInput,
  ctx: PolicyCheckContext,
  callerDisallowedTools: readonly string[] = [],
): PolicyCheckOk | PolicyCheckFail {
  // 4. Mode.
  if (!permissionModeWithin(input.mode, ctx.maxPermissionMode)) return { ok: false, failure: 'mode_not_allowed' };
  if (!input.availablePermissionModes.includes(input.mode)) return { ok: false, failure: 'mode_not_allowed' };
  if (input.mode === 'bypassPermissions' && !ctx.allowBypassPermissions) return { ok: false, failure: 'mode_not_allowed' };

  // 5. Tools.
  const maxAllowed = new Set(ctx.questToolPolicy.maxAllowedTools);
  for (const rule of input.allowedTools) {
    if (isBareWebFetchRule(rule)) return { ok: false, failure: 'tool_not_allowed' };
    if (!maxAllowed.has(rule)) return { ok: false, failure: 'tool_not_allowed' };
  }

  // 6. Containment: Bash allow rule, or a mode that can execute without one, needs a cgroup kill.
  const hasBashRule = input.allowedTools.some(isBashRule);
  const requiresScope = hasBashRule || modeCanExecuteFreely(input.mode);
  if (requiresScope && !ctx.systemdScopeAvailable) return { ok: false, failure: 'isolation_unavailable' };

  // H2: deny beats allow. Bash is only ever exposed in --tools with an explicit local allow rule
  // (never merely because the mode can execute freely); otherwise it is hard-denied here too, so a
  // permissive user-level ~/.claude/settings.json Bash rule (still in effect: --setting-sources=user)
  // cannot grant it back.
  //
  // SC5 re-review (recommended): DEFAULT_QUEST_ALWAYS_DENY is a FLOOR, not a ceiling. runner.json's
  // questToolPolicy.alwaysDeny is merged IN ADDITION to it, never in place of it — a host operator who
  // overrides alwaysDeny (e.g. to add one project-specific deny) must not thereby silently drop the
  // built-in HOME-scoped config/secret-read denies.
  const disallowedTools = dedupe([...callerDisallowedTools, ...DEFAULT_QUEST_ALWAYS_DENY, ...ctx.questToolPolicy.alwaysDeny, ...(hasBashRule ? [] : ['Bash'])]);
  const toolSet = buildQuestToolSet(input.allowedTools);
  if (hasBashRule) toolSet.push('Bash');
  return { ok: true, disallowedTools, requiresScope, toolSet: dedupe(toolSet) };
}

function dedupe(items: readonly string[]): string[] {
  return Array.from(new Set(items));
}
