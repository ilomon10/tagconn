import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** Markers that separate a Claude Code project transcripts root from the project-slug subpath below it. */
const PROJECTS_DIR_MARKERS = ['/.claude/projects/', '/projects/'];

/**
 * Maps a host-reported path (as seen by the machine running the `claude` CLI, e.g.
 * `/home/u/.claude/projects/<slug>/<id>.jsonl`) onto this server's `settings.paths.projectsDir` by
 * keeping only the part after the last projects-dir marker. Needed under Docker, where the server
 * only has `projectsDir` bind-mounted (not the host's real path).
 */
function mapHostPath(reportedPath: string, projectsDir: string): string | undefined {
  for (const marker of PROJECTS_DIR_MARKERS) {
    const i = reportedPath.lastIndexOf(marker);
    if (i >= 0) return join(projectsDir, reportedPath.slice(i + marker.length));
  }
  return undefined;
}

/**
 * True when `path` (with `..` collapsed) resolves inside `projectsDir`. Returns the resolved absolute
 * path, or undefined if it escapes/doesn't apply. Both sides are realpath'd when possible, so a
 * symlinked `projectsDir` (or a candidate reached through one) still matches correctly. This is only
 * the registration-time gate (decides whether a path is worth tracking at all); the actual read path
 * (`readTranscriptUsage`) re-validates the real, symlink-free path on every read, which is the one
 * security boundary that matters against a path swapped out from under an already-tracked file.
 */
function withinProjectsDir(path: string, projectsDir: string): string | undefined {
  let root: string;
  try {
    root = realpathSync(projectsDir);
  } catch {
    return undefined; // projectsDir doesn't exist (yet): nothing can be safely read
  }
  let resolved = resolve(path);
  try {
    resolved = realpathSync(resolved); // best-effort: resolves symlinks when the candidate already exists
  } catch {
    // Candidate doesn't exist yet (e.g. a subagent transcript not created yet): keep the lexical path,
    // still checked against `root` below.
  }
  if (resolved !== root && !resolved.startsWith(root + sep)) return undefined;
  return resolved;
}

/**
 * Resolves a hook-reported transcript path (`transcript_path` / `agent_transcript_path`) into an
 * absolute path this server may actually read.
 * - If the reported path exists as-is (no Docker split: server and hook share a filesystem), use it.
 * - Otherwise, map it onto `projectsDir` (see `mapHostPath`).
 * - Either way, reject anything that isn't a `.jsonl` file inside `projectsDir`.
 */
export function resolveHookTranscriptPath(reportedPath: string | undefined, projectsDir: string): string | undefined {
  if (!reportedPath || !reportedPath.endsWith('.jsonl')) return undefined;
  const candidate = existsSync(reportedPath) ? reportedPath : mapHostPath(reportedPath, projectsDir);
  if (!candidate) return undefined;
  return withinProjectsDir(candidate, projectsDir);
}

/**
 * A subagent's transcript lives at `<main transcript's dir>/<sessionId>/subagents/agent-<agentId>.jsonl`
 * (verified against real Claude Code output; also given directly as `agent_transcript_path` on
 * SubagentStop, but not before). Derived from an already-resolved main transcript path so we can track
 * it for the whole subagent lifetime, not just at the end.
 */
export function subagentTranscriptPath(mainPath: string, sessionId: string, agentId: string, projectsDir: string): string | undefined {
  const candidate = join(dirname(mainPath), sessionId, 'subagents', `agent-${agentId}.jsonl`);
  return withinProjectsDir(candidate, projectsDir);
}
