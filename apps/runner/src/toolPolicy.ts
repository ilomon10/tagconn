// Runner-side validation steps 4-6 of docs/design/runner-and-helpdesk.md §2.3: mode, tools, containment.
// This runs independently of (and in addition to) the server's own checks (defense in depth, T6).

import {
  isBareWebFetchRule,
  permissionModeWithin,
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
  /** disallowedTools to pass on the wire = the caller's own denies + the local alwaysDeny backstop. */
  disallowedTools: string[];
  /** True if this run needs a systemd scope wrapper (Bash allow rule, or mode auto/bypassPermissions). */
  requiresScope: boolean;
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

  const disallowedTools = dedupe([...callerDisallowedTools, ...ctx.questToolPolicy.alwaysDeny]);
  return { ok: true, disallowedTools, requiresScope };
}

function dedupe(items: readonly string[]): string[] {
  return Array.from(new Set(items));
}
