import { z } from 'zod';
import type { RunStatus } from './runner.js';
import type { Ack } from './socket.js';

/**
 * M8 Receptionist help desk (8l): a read-only assistant at the Guild Gate. Every turn is a runner
 * run with kind "receptionist" and `readOnly: true`. See docs/design/runner-and-helpdesk.md
 * ("Receptionist: layered read-only guarantees").
 *
 * The tool lists below are CONSTANTS on purpose: settings may only narrow them (turn web tools
 * off, add read-deny globs), never widen them. The runner applies them itself for readOnly runs and
 * ignores whatever allowlist the server sends (server-sent deny rules are kept: deny only narrows).
 */

export const RECEPTIONIST_PERMISSION_MODE = 'plan' as const;

/** Maximum tool allowlist. WebFetch/WebSearch are removed per run by settings.receptionist.*. */
export const RECEPTIONIST_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'] as const;

/**
 * Always denied (deny beats allow in Claude Code). Covers every built-in tool that can write,
 * execute, spawn a subagent with its own tool set, or run a skill/slash command.
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
] as const;

/**
 * Secret locations the receptionist must not read (Claude Code applies Read rules best-effort to
 * Grep/Glob too). Passed as `Read(<glob>)` entries in --disallowedTools. Users can add more via
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
 * Partial SSRF mitigation for WebFetch (which runs on the host): deny loopback names. Claude Code
 * domain rules cannot express IP ranges, so LAN addresses remain reachable; that is why WebFetch is
 * off for project-scope conversations by default (settings.receptionist.webFetch = "general-only").
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

/** Appended with --append-system-prompt on every receptionist turn. */
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
  /** Set when scope = "project" (read-only questions about that floor's repo). */
  projectId?: string;
  /** Latest Claude session id, used with --resume for the next turn. */
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
  text: z.string().trim().min(1).max(20_000),
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
