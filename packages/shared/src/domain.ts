import { z } from 'zod';
import type { ProjectProfileMeta } from './attribution.js';
import type { Hero } from './heroes.js';
import type { HeroProgress } from './progression.js';
import type { OfficeLayout } from './layout.js';

/** What a character is visibly doing. Drives sprite animation. */
export const ACTIVITIES = [
  'idle',
  'thinking',
  'typing',
  'reading',
  'searching',
  'running',
  'testing',
  'browsing',
  'meeting',
  'delegating',
  'waiting',
  'blocked',
  'done',
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** Named areas of the office map. Characters walk to the zone of their activity. */
export const ZONES = [
  'entrance',
  'pm-office',
  'desks',
  'meeting-room',
  'whiteboard',
  'qa-lab',
  'review-booth',
  'server-room',
  'library',
  'lounge',
] as const;
export type Zone = (typeof ZONES)[number];

export type AgentStatus = 'active' | 'waiting' | 'blocked' | 'done';

/** Token usage read from Claude Code transcripts (deduplicated by message id). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Number of distinct assistant messages counted. */
  messages: number;
  /** Context size of the latest message (input + cache read + cache creation). */
  contextTokens: number;
  /** Model of the latest message, e.g. "claude-sonnet-5". */
  model?: string;
}

export type SessionOrigin = 'cli' | 'quest';

export interface Project {
  /** Stable id derived from cwd (slug + short hash). */
  id: string;
  cwd: string;
  name: string;
  archived: boolean;
  createdAt: number;
  lastActivityAt: number;
  /** Office layout of this floor (M7). Unset or unknown = `settings.office.defaultLayoutId`. */
  layoutId?: string;
}

export interface Session {
  id: string; // Claude session_id
  projectId: string;
  status: 'active' | 'idle' | 'ended';
  permissionMode?: string;
  startedAt: number;
  endedAt?: number;
  lastPrompt?: string;
  /** Runner run that started this session (M8 8k). */
  runId?: string;
  origin?: SessionOrigin;
  /** Sum over the main agent and all its subagents. */
  usage?: TokenUsage;
}

export interface Agent {
  /** `main:<sessionId>` for the main session, otherwise Claude's agent_id. */
  id: string;
  sessionId: string;
  projectId: string;
  isMain: boolean;
  /** Claude agent type, e.g. "general-purpose", "qa-engineer". Main session is "main". */
  agentType: string;
  /** Resolved role name (roles.name) used for sprite/color; falls back to agentType. */
  role: string;
  /** Task description given by the parent (Agent tool `description`). */
  description?: string;
  status: AgentStatus;
  activity: Activity;
  zone: Zone;
  currentTool?: string;
  /** M12: when `currentTool` started (PreToolUse); cleared with it. Drives the "dizzy" long-tool emote. */
  toolStartedAt?: number;
  /** Short human text for a speech bubble, e.g. "Editing auth.ts". */
  bubble?: string;
  lastMessage?: string;
  toolCount: number;
  usage?: TokenUsage;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}

export type TaskStatus = 'todo' | 'doing' | 'review' | 'done' | 'failed';

export interface Task {
  id: string; // tool_use_id of the Agent call, or todo hash
  projectId: string;
  sessionId: string;
  title: string;
  assigneeAgentId?: string;
  role?: string;
  status: TaskStatus;
  source: 'agent-call' | 'todo' | 'handoff';
  createdAt: number;
  updatedAt: number;
}

/** Normalized, stored and broadcast form of one hook event. */
export interface OfficeEvent {
  id: number;
  ts: number;
  projectId: string;
  sessionId: string;
  agentId: string;
  hookEvent: string;
  toolName?: string;
  activity?: Activity;
  summary: string;
}

/** M16: the server's wall clock at snapshot time, so every browser renders the HOST's day, not its own. */
export interface HostClock {
  /** `Date.now()` on the server when the snapshot was built (epoch ms, UTC). */
  serverNow: number;
  /** Minutes EAST of UTC for the server's local zone at `serverNow` (DST-correct): `-new Date(serverNow).getTimezoneOffset()`.
   *  Jakarta = 420, New York in summer = -240, UTC = 0. */
  tzOffsetMin: number;
  /** IANA zone name when the host knows it (`process.env.TZ` or `Intl.DateTimeFormat().resolvedOptions().timeZone`), for the HUD. */
  tz?: string;
}

/** M16: runtime guard for a received `HostClock` (the client safeParses it; a failure means "no clock"). */
export const HostClockSchema = z.object({
  serverNow: z.number().int().min(0).max(8.64e15),
  tzOffsetMin: z.number().int().min(-720).max(840),
  tz: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_+\-/]+$/)
    .optional(),
});

export interface OfficeSnapshot {
  projects: Project[];
  sessions: Session[];
  agents: Agent[];
  tasks: Task[];
  events: OfficeEvent[];
  /** All saved layouts (M7). Optional so pre-M7 servers and test fixtures stay valid. */
  layouts?: OfficeLayout[];
  /** Heroes of the subscribed floor(s) (M8 8i). Optional so pre-M8 servers and fixtures stay valid. */
  heroes?: Hero[];
  /** M14: stored progress of the subscribed floor(s)' heroes (heroes without a row are level 1). Optional for pre-M14 servers/fixtures. */
  progress?: HeroProgress[];
  /** M16: host clock (optional so pre-M16 servers and fixtures stay valid; the client falls back to its own clock). */
  clock?: HostClock;
}
