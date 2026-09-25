// Snapshot helper for the REAL ~/.config/tagconn and ~/.claude/settings.json
// on this machine, so the installer test suite can prove it never touched
// them. Every integration test in this suite must use a sandboxed HOME and
// explicit --claude-dir/--config-dir; this is the trip-wire in case one
// doesn't.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const REAL_CONFIG_DIR = join(homedir(), '.config', 'tagconn');
export const REAL_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

function snapshotEntry(path: string): string {
  if (!existsSync(path)) return 'MISSING';
  const stat = statSync(path);
  if (stat.isFile()) {
    return `FILE:${stat.mtimeMs}:${stat.size}:${(stat.mode & 0o777).toString(8)}`;
  }
  const lines: string[] = [`DIR:${(stat.mode & 0o777).toString(8)}`];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const entryRel = `${rel}/${name}`;
      const s = statSync(full);
      if (s.isDirectory()) {
        lines.push(`DIR:${entryRel}:${(s.mode & 0o777).toString(8)}`);
        walk(full, entryRel);
      } else {
        lines.push(`FILE:${entryRel}:${s.mtimeMs}:${s.size}:${(s.mode & 0o777).toString(8)}`);
      }
    }
  };
  walk(path, '');
  return lines.join('\n');
}

export interface RealPathsSnapshot {
  configDir: string;
  settings: string;
}

export function snapshotRealPaths(): RealPathsSnapshot {
  return {
    configDir: snapshotEntry(REAL_CONFIG_DIR),
    settings: snapshotEntry(REAL_SETTINGS_PATH),
  };
}

/** Returns one human-readable diff string per path that changed, or `[]` if nothing did. */
export function diffRealPaths(before: RealPathsSnapshot): string[] {
  const after = snapshotRealPaths();
  const diffs: string[] = [];
  if (after.configDir !== before.configDir) {
    diffs.push(
      `REAL ${REAL_CONFIG_DIR} changed during the test run!\n--- before ---\n${before.configDir}\n--- after ---\n${after.configDir}`,
    );
  }
  if (after.settings !== before.settings) {
    diffs.push(
      `REAL ${REAL_SETTINGS_PATH} changed during the test run!\n--- before ---\n${before.settings}\n--- after ---\n${after.settings}`,
    );
  }
  return diffs;
}
