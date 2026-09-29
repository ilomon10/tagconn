import type { RunnerStatus } from '@tagconn/shared';

/** Windows-specific runner messaging (docs/guide/desktop.md#windows-limits). The runner reports its
 *  Node `process.platform` in the hello; the server forwards it on `RunnerStatus.platform`. */
export const WINDOWS_LIMITS_URL = 'https://github.com/ilomon10/tagconn/blob/main/docs/guide/desktop.md#windows-limits';

export const WINDOWS_NOTE = 'Running on Windows: read-only Receptionist without a sandbox; quests without Bash.';

/** Read defensively: an older server may not forward `platform` yet, which just means "not Windows". */
export function runnerPlatform(status: RunnerStatus | null | undefined): string | undefined {
  const platform = (status as { platform?: unknown } | null | undefined)?.platform;
  return typeof platform === 'string' ? platform : undefined;
}

export function isWindowsRunner(status: RunnerStatus | null | undefined): boolean {
  return runnerPlatform(status) === 'win32';
}
