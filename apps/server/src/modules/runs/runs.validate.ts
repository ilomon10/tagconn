import { isBareWebFetchRule, type RunPermissionMode, type Settings, WEBFETCH_LOOPBACK_DENY_RULES } from '@tagconn/shared';
import { HttpError } from '../../core/http/index.js';

/**
 * Pure, independently-testable validation used when building a `RunStartCommand` for a quest
 * (docs/design/runner-and-helpdesk.md §2.3 and §2.7). The runner re-checks all of this itself
 * (defense in depth, T6); these are the SERVER's own checks, run before a run is ever queued.
 */

export function assertPromptWithinLimit(prompt: string, maxPromptChars: number): void {
  if (prompt.length > maxPromptChars) {
    throw new HttpError(400, `Prompt exceeds runner.maxPromptChars (${maxPromptChars})`);
  }
}

/** `mode_not_allowed` if the requested (or default) mode isn't in `settings.runner.allowedPermissionModes`. */
export function resolvePermissionMode(requested: RunPermissionMode | undefined, runner: Settings['runner']): RunPermissionMode {
  const mode = requested ?? runner.permissionMode;
  if (!runner.allowedPermissionModes.includes(mode)) {
    throw new HttpError(400, `mode_not_allowed: "${mode}" is not in runner.allowedPermissionModes`);
  }
  return mode;
}

/**
 * `settings.runner.allowedTools` is already schema-refined to reject bare "WebFetch" (V11), but this
 * is the second, independent server-side check the design calls for (T6 defense in depth: a settings
 * override that somehow bypassed the schema must still be caught here, not just trusted).
 */
export function assertNoBareWebFetch(tools: readonly string[]): void {
  const bare = tools.find((t) => isBareWebFetchRule(t));
  if (bare) throw new HttpError(400, `tool_not_allowed: bare "${bare}" is never allowed (use WebFetch(domain:x))`);
}

/** `settings.runner.allowedTools`, re-checked for a bare WebFetch rule before it is ever sent to a runner. */
export function buildQuestAllowedTools(runner: Settings['runner']): string[] {
  assertNoBareWebFetch(runner.allowedTools);
  return [...runner.allowedTools];
}

/** `settings.runner.disallowedTools` plus the loopback WebFetch backstop (deny only ever narrows). */
export function buildQuestDisallowedTools(runner: Settings['runner']): string[] {
  return [...new Set([...runner.disallowedTools, ...WEBFETCH_LOOPBACK_DENY_RULES])];
}
