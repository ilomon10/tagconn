// Dir containment + trust gate (docs/design/runner-and-helpdesk.md §2.3 steps 2-3).
//
// "-p" never sets ~/.claude.json's hasTrustDialogAccepted (SC3 V14), so this check IS the trust gate
// for headless runs: exact realpath lookup (no parent inheritance -> fail closed), or an explicit
// trustOverrideDirs entry from runner.json.

import { existsSync, readFileSync } from 'node:fs';
import { currentPlatform, type Platform } from './platform.js';

export type DirCheckFailure = 'dir_not_allowed' | 'dir_not_trusted';

export interface DirCheckResult {
  ok: boolean;
  /** The realpath the caller must use for cwd / --add-dir / bwrap binds from here on. */
  realDir?: string;
  failure?: DirCheckFailure;
}

/**
 * Comparison key for a path. win32 paths are case-insensitive (drive letter included) and Claude Code may
 * record them with either slash, so they are normalised, unified to `/`, lower-cased and stripped of a
 * trailing separator. POSIX paths compare exactly (only a trailing separator is dropped).
 */
export function pathKey(p: string, platform: Platform): string {
  if (!platform.isWin32) return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  const k = platform.path.normalize(p).replace(/\\/g, '/').toLowerCase();
  return k.length > 3 && k.endsWith('/') ? k.slice(0, -1) : k;
}

/**
 * realpath(dir) must equal an allowed root, or be strictly below one (root + path separator prefix).
 * Never the filesystem/drive root or `$HOME`, even if listed (defense in depth against a misconfigured
 * allowedProjectDirs). Windows compares case-insensitively.
 */
export function isWithinAllowedDirs(realDir: string, allowedProjectDirs: readonly string[], platform: Platform = currentPlatform()): boolean {
  const dir = pathKey(realDir, platform);
  if (dir === pathKey(platform.path.parse(realDir).root, platform) || dir === pathKey(platform.homedir(), platform)) return false;
  return allowedProjectDirs.some((root) => {
    const r = pathKey(root, platform);
    return dir === r || dir.startsWith(r.endsWith('/') ? r : `${r}/`);
  });
}

/** Resolves `dir` to its realpath and checks allowlist containment. Never throws (a missing dir just fails). */
export function checkAllowedDir(dir: string, allowedProjectDirs: readonly string[], platform: Platform = currentPlatform()): DirCheckResult {
  let realDir: string;
  try {
    realDir = platform.realpath(dir);
  } catch {
    return { ok: false, failure: 'dir_not_allowed' };
  }
  if (!isWithinAllowedDirs(realDir, allowedProjectDirs, platform)) return { ok: false, failure: 'dir_not_allowed' };
  return { ok: true, realDir };
}

interface ClaudeJsonShape {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
}

/** Reads ~/.claude.json's per-project trust flag. Any read/parse failure fails closed (returns false). */
export function readTrustFlag(claudeJsonPath: string, realDir: string, platform: Platform = currentPlatform()): boolean {
  if (!existsSync(claudeJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as ClaudeJsonShape;
    if (!platform.isWin32) return parsed.projects?.[realDir]?.hasTrustDialogAccepted === true;
    // win32: the key's slash style and case are not guaranteed; still an exact (normalised) match, no parents.
    const want = pathKey(realDir, platform);
    return Object.entries(parsed.projects ?? {}).some(([key, v]) => pathKey(key, platform) === want && v?.hasTrustDialogAccepted === true);
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
  platform: Platform = currentPlatform(),
): boolean {
  const want = pathKey(realDir, platform);
  if (opts.trustOverrideDirs.some((d) => pathKey(d, platform) === want)) return true;
  return readTrustFlag(opts.claudeJsonPath, realDir, platform);
}

export function defaultClaudeJsonPath(platform: Platform = currentPlatform()): string {
  return platform.path.join(platform.homedir(), '.claude.json');
}
