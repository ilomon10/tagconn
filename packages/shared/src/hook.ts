import { z } from 'zod';

/** Claude Code hook event names we understand. Unknown names are still accepted and stored. */
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Notification',
  'PreCompact',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/**
 * Raw payload Claude Code writes to a hook's stdin (see apps/server/test/fixtures).
 * `agent_id` / `agent_type` are present when the event fires inside a subagent.
 */
export const HookPayloadSchema = z.looseObject({
  session_id: z.string().min(1),
  hook_event_name: z.string().min(1),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  permission_mode: z.string().optional(),
  prompt_id: z.string().optional(),
  prompt: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  agent_transcript_path: z.string().optional(),
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  duration_ms: z.number().optional(),
  message: z.string().optional(),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});
export type HookPayload = z.infer<typeof HookPayloadSchema>;

/**
 * M12: the hook sends the session's project root (git top-level of `CLAUDE_PROJECT_DIR`, else that
 * dir) base64-encoded in this header, so a floor is the repo, not whatever directory the agent `cd`'d
 * into. Untrusted like `cwd`: the server only uses it after `parseProjectRootHeader` accepts it.
 */
export const PROJECT_ROOT_HEADER = 'x-tagconn-project-root';
export const PROJECT_ROOT_MAX_BYTES = 4096;

/** `git` = the root came from `git rev-parse --show-toplevel`; `dir` = fallback to `CLAUDE_PROJECT_DIR`. */
export const PROJECT_ROOT_KIND_HEADER = 'x-tagconn-project-root-kind';
export type ProjectRootKind = 'git' | 'dir';

export function parseProjectRootKindHeader(raw: unknown): ProjectRootKind | undefined {
  return raw === 'git' || raw === 'dir' ? raw : undefined;
}

/**
 * Validate and normalise an untrusted absolute path (the root header or a payload `cwd`): POSIX or
 * Windows drive path, NFC, no control or format (bidi) chars, no `..` segments, not a filesystem root,
 * Windows paths without a `:` after the drive (alternate data streams). Returns the cleaned path.
 */
export function parseProjectPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PROJECT_ROOT_MAX_BYTES) return undefined;
  const decoded = raw.normalize('NFC');
  if (decoded.length === 0 || utf8Length(decoded) > PROJECT_ROOT_MAX_BYTES) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(decoded) || /\p{Cf}/u.test(decoded)) return undefined;
  const isPosix = decoded.startsWith('/');
  const isWin = /^[A-Za-z]:[\\/]/.test(decoded);
  if (!isPosix && !isWin) return undefined;
  if (isWin && decoded.slice(2).includes(':')) return undefined;
  if (decoded.split(isWin ? /[\\/]/ : '/').some((seg) => seg === '..')) return undefined;
  // Normalize: drop trailing separators (keep a bare root) and collapse repeated separators.
  let norm = decoded.replace(isWin ? /[\\/]{2,}/g : /\/{2,}/g, isWin ? '\\' : '/');
  while (norm.length > (isWin ? 3 : 1) && (isWin ? /[\\/]$/ : /\/$/).test(norm)) norm = norm.slice(0, -1);
  // A filesystem root is never a project (it would swallow every floor).
  if (norm === '/' || /^[A-Za-z]:[\\/]?$/.test(norm)) return undefined;
  return norm;
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** Decode + validate the header: base64 of a path `parseProjectPath` accepts. */
export function parseProjectRootHeader(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > Math.ceil((PROJECT_ROOT_MAX_BYTES * 4) / 3) + 4) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw.trim())) return undefined;
  let decoded: string;
  try {
    const bin = atob(raw.trim());
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
  return parseProjectPath(decoded);
}
