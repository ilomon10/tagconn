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
