import { normalize, sep } from 'node:path';
import type { ReceptionistToolCall, RunEvent } from '@tagconn/shared';
import { HttpError } from '../../core/http/index.js';

/**
 * Pure, independently-testable validation and text-accumulation helpers for the Receptionist
 * (docs/design/runner-and-helpdesk.md §4, §9 S3). Kept separate from `receptionist.service.ts` for the
 * same reason `runs.validate.ts` is: unit tests exercise these without spinning up the whole app.
 */

/** Drops a trailing separator (except for the root itself) so prefix comparisons are exact. */
function normalizeDir(raw: string): string {
  const n = normalize(raw);
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}

/**
 * §9 S3: "project scope ONLY for registered projects whose cwd is inside settings.runner.
 * allowedProjectDirs (realpath-free server check: exact prefix on normalized paths; the runner
 * re-validates with realpath)". No filesystem access here on purpose: `node:path.normalize` collapses
 * `.`/`..`/repeated separators without following symlinks, which is exactly the "realpath-free" check
 * the design calls for. The runner independently re-checks with a real `realpath()` before it spawns
 * anything (defense in depth, T6).
 */
export function isProjectDirAllowed(cwd: string, allowedDirs: readonly string[]): boolean {
  const target = normalizeDir(cwd);
  return allowedDirs.some((raw) => {
    const dir = normalizeDir(raw);
    if (dir === sep) return true; // an operator who allowlists "/" allows everything below it
    return target === dir || target.startsWith(dir + sep);
  });
}

/** `HttpError(403, ...)` thrown by `isProjectDirAllowed` callers; kept as one helper so the message is consistent. */
export function assertProjectDirAllowed(cwd: string, allowedDirs: readonly string[]): void {
  if (!isProjectDirAllowed(cwd, allowedDirs)) {
    throw new HttpError(403, 'This project is outside runner.allowedProjectDirs');
  }
}

/**
 * Accumulates a receptionist turn's assistant text across a stream of `RunEvent`s (§2.5, §4.1
 * "streams answers"). `--include-partial-messages` (the default) sends incremental `text{partial:true}`
 * deltas, then a `text{partial:false}` for the same content block; a `result` event, when it carries
 * text, is the authoritative final answer and replaces whatever was accumulated. Kept pure so it can be
 * unit-tested against a scripted event sequence without a socket or a database.
 */
export interface AssistantTurnAccumulator {
  text: string;
  tools: ReceptionistToolCall[];
  /** True right after a partial delta, so the matching non-partial block is treated as already counted. */
  sawPartialForCurrentBlock: boolean;
}

export const emptyAccumulator = (): AssistantTurnAccumulator => ({ text: '', tools: [], sawPartialForCurrentBlock: false });

/** Applies one `RunEvent` to an accumulator, returning a new one (never mutates its input). */
export function applyRunEvent(acc: AssistantTurnAccumulator, event: RunEvent): AssistantTurnAccumulator {
  switch (event.kind) {
    case 'text':
      if (event.partial) {
        return { ...acc, text: acc.text + event.text, sawPartialForCurrentBlock: true };
      }
      if (acc.sawPartialForCurrentBlock) {
        // The deltas we already appended cover this completed block; just start tracking the next one.
        return { ...acc, sawPartialForCurrentBlock: false };
      }
      return { ...acc, text: acc.text + event.text };
    case 'tool_use':
      return { ...acc, tools: [...acc.tools, { name: event.name, preview: event.inputPreview }] };
    case 'result':
      return event.text !== undefined ? { ...acc, text: event.text } : acc;
    default:
      return acc;
  }
}
