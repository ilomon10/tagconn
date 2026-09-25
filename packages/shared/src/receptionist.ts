import { z } from 'zod';
import type { RunStatus } from './runner.js';
import type { Ack } from './socket.js';

/**
 * M8 Receptionist help desk (8l): a read-only assistant at the Guild Gate. Every turn is a runner
 * run with kind "receptionist" and `readOnly: true`. See docs/design/runner-and-helpdesk.md
 * ("Receptionist: layered read-only guarantees").
 *
 * Everything here is a CONSTANT on purpose: settings may only narrow it (WebSearch off, WebFetch
 * domain allowlist, extra read-deny globs), never widen it. The runner builds the receptionist argv
 * itself from these constants and ignores the server's allowlist, mode and system prompt.
 */

/**
 * Mode for receptionist turns. `plan` pending SC3: if plan mode misbehaves headless (e.g. ExitPlanMode
 * loops), switch to `dontAsk`; both combined with --permission-prompts none deny anything not in --tools.
 * TBD by SC3.
 */
export const RECEPTIONIST_PERMISSION_MODE = 'plan' as const;

/** Always in the exact tool set (`--tools`). */
export const RECEPTIONIST_BASE_TOOLS = ['Read', 'Grep', 'Glob'] as const;
/** Everything that can ever be in the exact tool set. */
export const RECEPTIONIST_MAX_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'] as const;

/**
 * The exact `--tools` set for one turn. The runner's L5 watchdog requires `init.tools` to EQUAL this
 * set (as a set) and kills the run on any `mcp__*` tool.
 */
export function receptionistToolSet(opts: { webSearch: boolean; webFetchDomains: readonly string[] }): string[] {
  const tools: string[] = [...RECEPTIONIST_BASE_TOOLS];
  if (opts.webSearch) tools.push('WebSearch');
  if (opts.webFetchDomains.length > 0) tools.push('WebFetch');
  return tools;
}

/**
 * Backstop only (the exact --tools list is the primary control). Deny beats allow in Claude Code.
 * Covers every built-in tool that can write, execute, delegate, switch worktree or leave plan mode.
 */
export const RECEPTIONIST_DISALLOWED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Agent',
  'Task',
  'Skill',
  'SlashCommand',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
] as const;

/**
 * Secret locations the receptionist must not read (Claude Code applies Read rules best-effort to
 * Grep/Glob too). Passed as `Read(<glob>)` entries in --disallowedTools. With `--restricted` (when
 * probed) file tools are additionally confined to cwd + --add-dir. Users can add more via
 * settings.receptionist.extraDenyReadGlobs (file/env only).
 */
export const RECEPTIONIST_DENY_READ_GLOBS = [
  '~/.ssh/**',
  '~/.gnupg/**',
  '~/.aws/**',
  '~/.azure/**',
  '~/.kube/**',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/.git-credentials',
  '~/.config/gh/**',
  '~/.config/tagconn/**',
  '~/.claude/.credentials.json',
  '~/.claude.json',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
] as const;

/**
 * Backstop SSRF denies. The primary control is that WebFetch is OFF by default and, when enabled,
 * only `WebFetch(domain:x)` allow rules for settings.receptionist.webFetchAllowDomains are passed
 * (with --permission-prompts none, other domains are denied; TBD by SC3).
 */
export const RECEPTIONIST_WEBFETCH_DENY_RULES = [
  'WebFetch(domain:localhost)',
  'WebFetch(domain:127.0.0.1)',
  'WebFetch(domain:0.0.0.0)',
  'WebFetch(domain:[::1])',
  'WebFetch(domain:host.docker.internal)',
  'WebFetch(domain:metadata.google.internal)',
  'WebFetch(domain:169.254.169.254)',
] as const;

/**
 * Files the runner copies (from its own repo checkout) into `<stateDir>/receptionist-docs` for the
 * general scope's --add-dir. Never the repo root (.env, data/, config/ stay unreachable).
 */
export const RECEPTIONIST_DOCS_COPY = ['README.md', 'CLAUDE.md', 'ROADMAP.md', 'docs'] as const;

/** Appended with --append-system-prompt on every receptionist turn (the server cannot override it). */
export const RECEPTIONIST_SYSTEM_PROMPT = [
  'You are the Receptionist of a tagconn office: a read-only help desk.',
  'You answer questions. You never modify files, run commands, or propose to do so yourself.',
  'You can only read files in the working directory (and added directories) and search the web when allowed.',
  'If the user asks for a change, explain what to change and suggest they post it as a quest on the quest board.',
  'Keep answers concise and cite file paths you read.',
].join(' ');

export const RECEPTIONIST_SCOPES = ['general', 'project'] as const;
export type ReceptionistScope = (typeof RECEPTIONIST_SCOPES)[number];

export interface ReceptionistConversation {
  id: string;
  title: string;
  scope: ReceptionistScope;
  /** scope = "project": a registered project whose cwd is inside the runner's allowedProjectDirs. */
  projectId?: string;
  /** Latest runner-created Claude session id, used with --resume for the next turn. */
  sessionId?: string;
  messageCount: number;
  /** True while a turn is running (one turn at a time per conversation). */
  busy: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ReceptionistToolCall {
  name: string;
  preview: string;
}

export interface ReceptionistMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  /** Redacted. For an assistant message still streaming, the text so far. */
  text: string;
  /** The run that produced (assistant) or was started by (user) this message. */
  runId?: string;
  status?: RunStatus;
  tools?: ReceptionistToolCall[];
  costUsd?: number;
  createdAt: number;
}

export const ConversationCreateSchema = z.strictObject({
  scope: z.enum(RECEPTIONIST_SCOPES),
  projectId: z.string().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(120).optional(),
});
export type ConversationCreate = z.infer<typeof ConversationCreateSchema>;

export const ReceptionistSendSchema = z.strictObject({
  conversationId: z.string().min(1).max(200),
  text: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .refine((s) => !s.includes('\0'), 'text must not contain NUL'),
});
export type ReceptionistSend = z.infer<typeof ReceptionistSendSchema>;

export interface ReceptionistServerToClientEvents {
  'receptionist:conversation': (c: ReceptionistConversation) => void;
  'receptionist:conversationRemoved': (id: string) => void;
  /** New or updated message (the assistant message is upserted as it streams; text deltas also arrive as run:event). */
  'receptionist:message': (m: ReceptionistMessage) => void;
}

export interface ReceptionistClientToServerEvents {
  'receptionist:list': (ack: Ack<ReceptionistConversation[]>) => void;
  'receptionist:get': (
    id: string,
    ack: Ack<{ conversation: ReceptionistConversation; messages: ReceptionistMessage[] }>,
  ) => void;
  'receptionist:create': (req: ConversationCreate, ack: Ack<ReceptionistConversation>) => void;
  /** Starts a turn; replies with the stored user message. Errors if the conversation is busy. */
  'receptionist:send': (req: ReceptionistSend, ack: Ack<ReceptionistMessage>) => void;
  'receptionist:stop': (conversationId: string, ack: Ack<true>) => void;
  'receptionist:delete': (conversationId: string, ack: Ack<true>) => void;
}
