import type { RunEndReason } from '@tagconn/shared';

/**
 * Turns a machine `RunEndReason` (docs/design/runner-and-helpdesk.md section 3, "rejections explain
 * the fix") into a one- or two-sentence human explanation, mirroring the runner's own validation
 * order in section 2.3. Every reason the runner or server can emit gets an entry so a future addition
 * to `RUN_END_REASONS` is caught by the exhaustiveness check below rather than silently falling back
 * to the bare code.
 */
const END_REASON_GUIDANCE: Record<RunEndReason, string> = {
  dir_not_allowed: "This folder is outside the runner's allowed project directories. Ask the host to add it to runner.json allowedProjectDirs.",
  dir_not_trusted: 'Open this project once in the Claude Code terminal and accept the trust dialog, then try again — a headless quest can\'t accept it for you.',
  mode_not_allowed: "This permission mode isn't allowed here. Pick one of the offered modes, or ask the host to widen settings.runner.allowedPermissionModes.",
  tool_not_allowed: "A tool this quest needs isn't on the runner's allowlist (a bare WebFetch is never allowed — only WebFetch(domain:x)). Ask the host to add it to runner.json questToolPolicy.maxAllowedTools.",
  isolation_unavailable: "This mode can run shell commands, but the host has no process isolation (a systemd user scope) available, so it was refused for safety. Pick a mode that can't run commands, or ask the host to enable a systemd scope.",
  resume_not_allowed: 'This follow-up can\'t resume the earlier session — it was created with different tools or a different mode, or by another runner. Start a fresh quest instead.',
  concurrency: 'The runner is at its concurrency limit; this run was re-queued once and then refused. Try again shortly, or stop another run first.',
  spawn_failed: 'The host failed to start the claude process for this run. Check the runner log on the host.',
  capability_missing: 'The runner is missing a Claude CLI capability every run needs (e.g. --setting-sources). Update Claude Code on the host and restart the runner.',
  policy_violation: "This run was killed because its tool use didn't match the policy it started with.",
  output_cap: 'This run produced more output than the configured cap and was stopped automatically.',
  runner_shutdown: 'The runner was shutting down and stopped this run. It can be started again once it reconnects.',
  invalid_command: 'The quest request was malformed and refused before anything started.',
  timeout: 'This run hit its time limit and was stopped.',
  stopped_by_user: 'Stopped by an admin.',
  exit: 'The process exited on its own.',
};

/** Guidance for a run that ended non-terminally-happy (`status: 'rejected' | 'failed' | 'timeout' | 'stopped' | 'lost'`
 *  with an `endReason`). Returns `undefined` for a run with no `endReason` (a plain success, or one
 *  still in flight) — callers should only show this alongside an actual rejection/failure. */
export function guidanceForEndReason(reason: RunEndReason | undefined): string | undefined {
  if (!reason) return undefined;
  return END_REASON_GUIDANCE[reason];
}

/**
 * Guidance for an error thrown *before* a `Run` even exists — starting or following up a quest can be
 * refused synchronously (see `apps/server/.../runs.service.ts`), with messages like
 * "runner_disabled: settings.runner.enabled is false" or a plain "No verified runner is connected".
 * `HttpError` messages are already client-safe (never a raw internal error — see `runsAck` on the
 * server), so anything unrecognized here is shown as-is rather than swallowed.
 */
export function guidanceForError(message: string): string {
  const prefixMatch = /^([a-z_]+):\s*/i.exec(message);
  const prefix = prefixMatch?.[1]?.toLowerCase();
  if (prefix === 'runner_disabled') {
    return "The runner isn't enabled. Enable it with OFFICE_RUNNER__ENABLED=true (the installer does this when you pass --allow-dir), then run `pnpm office:runner` on the host.";
  }
  if (prefix && Object.hasOwn(END_REASON_GUIDANCE, prefix)) return END_REASON_GUIDANCE[prefix as RunEndReason];
  if (/no verified runner is connected/i.test(message)) return 'No runner is connected to the server yet. Run `pnpm office:runner` on the host.';
  if (/run queue is full/i.test(message)) return 'The quest queue is full right now. Try again once a run finishes.';
  return message;
}
