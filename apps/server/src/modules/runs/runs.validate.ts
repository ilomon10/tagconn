import { isValidWebFetchAllowRule, type RunPermissionMode, type Settings, WEBFETCH_LOOPBACK_DENY_RULES } from '@tagconn/shared';
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

/**
 * §2.3 / §2.7 "Server-side checks run first": `project.cwd` must be an absolute path equal to, or
 * lexically below, one of `runner.allowedProjectDirs` (an empty list denies everything). This is a
 * lexical prefix check on the STRING the project was registered with — not a realpath resolution (the
 * runner does its own independent realpath + symlink-aware check, T6 defense in depth; this only
 * bounds which registered project a run may target before it is ever queued). Failure: `dir_not_allowed`.
 */
export function assertProjectDirAllowed(cwd: string, allowedProjectDirs: readonly string[]): void {
  if (!cwd.startsWith('/')) throw new HttpError(400, 'dir_not_allowed: project.cwd must be an absolute path');
  const normalized = cwd.replace(/\/+$/, '') || '/';
  const allowed = allowedProjectDirs.some((raw) => {
    const root = raw.replace(/\/+$/, '') || '/';
    return normalized === root || normalized.startsWith(`${root}/`);
  });
  if (!allowed) throw new HttpError(400, `dir_not_allowed: "${cwd}" is not inside runner.allowedProjectDirs`);
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
 * `settings.runner.allowedTools` is already schema-refined to reject the exact string "WebFetch"
 * (V11), but this is the second, independent server-side check the design calls for (T6 defense in
 * depth: a settings override that somehow bypassed the schema must still be caught here, not just
 * trusted) — and it is strictly wider (L4): every WebFetch rule must be EXACTLY
 * `WebFetch(domain:<DOMAIN_RE>)`, not just "not literally the bare word".
 */
export function assertNoBareWebFetch(tools: readonly string[]): void {
  const bad = tools.find((t) => !isValidWebFetchAllowRule(t));
  if (bad) throw new HttpError(400, `tool_not_allowed: "${bad}" — WebFetch allow rules must be exactly WebFetch(domain:x)`);
}

/** `settings.runner.allowedTools`, re-checked for an invalid WebFetch rule before it is ever sent to a runner. */
export function buildQuestAllowedTools(runner: Settings['runner']): string[] {
  assertNoBareWebFetch(runner.allowedTools);
  return [...runner.allowedTools];
}

/** `settings.runner.disallowedTools` plus the loopback WebFetch backstop (deny only ever narrows). */
export function buildQuestDisallowedTools(runner: Settings['runner']): string[] {
  return [...new Set([...runner.disallowedTools, ...WEBFETCH_LOOPBACK_DENY_RULES])];
}

/**
 * L3 (SC5): the quest-level deny list plus `settings.receptionist.extraDenyReadGlobs`, formatted as
 * `Read(<glob>)` tool rules — the same shape the built-in `RECEPTIONIST_DENY_READ_GLOBS` use (see
 * `apps/runner/src/argv.ts`). `RunStartCommand` has no dedicated field for this: the runner already
 * folds the whole `disallowedTools` array into its own `extraDisallowedTools` for a receptionist turn
 * (`apps/runner/src/runManager.ts`: `extraDisallowedTools: cmd.disallowedTools`), so forwarding it here
 * is enough — no shared-contract change needed.
 */
export function buildReceptionistDisallowedTools(runner: Settings['runner'], receptionist: Settings['receptionist']): string[] {
  return [...new Set([...buildQuestDisallowedTools(runner), ...receptionist.extraDenyReadGlobs.map((g) => `Read(${g})`)])];
}
