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

/** Decode + validate the header: an absolute POSIX or Windows path, no NUL/control chars, no `..` segments. */
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
  if (decoded.length === 0 || decoded.length > PROJECT_ROOT_MAX_BYTES) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  const isPosix = decoded.startsWith('/');
  const isWin = /^[A-Za-z]:[\\/]/.test(decoded);
  if (!isPosix && !isWin) return undefined;
  if (decoded.split(/[\\/]/).some((seg) => seg === '..')) return undefined;
  // Normalize: drop trailing separators (keep a bare root) and collapse repeated separators.
  let norm = decoded.replace(/[\\/]{2,}/g, isWin ? '\\' : '/');
  while (norm.length > (isWin ? 3 : 1) && /[\\/]$/.test(norm)) norm = norm.slice(0, -1);
  // A filesystem root is never a project (it would swallow every floor).
  if (norm === '/' || /^[A-Za-z]:[\\/]?$/.test(norm)) return undefined;
  return norm;
}
