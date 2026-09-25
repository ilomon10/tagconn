// Dir containment + trust gate (docs/design/runner-and-helpdesk.md §2.3 steps 2-3).
//
// "-p" never sets ~/.claude.json's hasTrustDialogAccepted (SC3 V14), so this check IS the trust gate
// for headless runs: exact realpath lookup (no parent inheritance -> fail closed), or an explicit
// trustOverrideDirs entry from runner.json.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';

export type DirCheckFailure = 'dir_not_allowed' | 'dir_not_trusted';

export interface DirCheckResult {
  ok: boolean;
  /** The realpath the caller must use for cwd / --add-dir / bwrap binds from here on. */
  realDir?: string;
  failure?: DirCheckFailure;
}

/**
 * realpath(dir) must equal an allowed root, or be strictly below one (root + path separator prefix).
 * Never `/` or `$HOME`, even if listed (defense in depth against a misconfigured allowedProjectDirs).
 */
export function isWithinAllowedDirs(realDir: string, allowedProjectDirs: readonly string[]): boolean {
  if (realDir === sep || realDir === homedir()) return false;
  return allowedProjectDirs.some((root) => realDir === root || realDir.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** Resolves `dir` to its realpath and checks allowlist containment. Never throws (a missing dir just fails). */
export function checkAllowedDir(dir: string, allowedProjectDirs: readonly string[]): DirCheckResult {
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return { ok: false, failure: 'dir_not_allowed' };
  }
  if (!isWithinAllowedDirs(realDir, allowedProjectDirs)) return { ok: false, failure: 'dir_not_allowed' };
  return { ok: true, realDir };
}

interface ClaudeJsonShape {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
}

/** Reads ~/.claude.json's per-project trust flag. Any read/parse failure fails closed (returns false). */
export function readTrustFlag(claudeJsonPath: string, realDir: string): boolean {
  if (!existsSync(claudeJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as ClaudeJsonShape;
    return parsed.projects?.[realDir]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

/**
 * Exact-realpath only (no parent inheritance: fail-closed). `trustOverrideDirs` entries are compared
 * as realpaths too (the config loader already realpath'd them).
 */
export function isTrustedDir(
  realDir: string,
  opts: { claudeJsonPath: string; trustOverrideDirs: readonly string[] },
): boolean {
  if (opts.trustOverrideDirs.includes(realDir)) return true;
  return readTrustFlag(opts.claudeJsonPath, realDir);
}

export function defaultClaudeJsonPath(): string {
  return `${homedir()}/.claude.json`;
}
