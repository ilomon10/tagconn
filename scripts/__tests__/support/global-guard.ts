// Vitest globalSetup: snapshots the REAL ~/.config/tagconn and
// ~/.claude/settings.json before the whole suite runs, and throws (failing
// the run) if either changed by the time every test file has finished. This
// is a hard backstop in case a test forgets to sandbox HOME/--claude-dir.
import { diffRealPaths, snapshotRealPaths } from './real-paths-guard.ts';

export default function setup(): () => void {
  const before = snapshotRealPaths();
  return () => {
    const diffs = diffRealPaths(before);
    if (diffs.length > 0) {
      throw new Error(`GUARD FAILED - a test touched real tagconn state:\n\n${diffs.join('\n\n')}`);
    }
  };
}
