import { z } from 'zod';
import { ACTIVITIES, ZONES } from './domain.js';
import { HOOK_EVENTS } from './hook.js';
import { DEFAULT_LAYOUT_ID, LAYOUT_ID_RE, OFFICE_STYLES } from './layout.js';

export const ActivityRuleSchema = z.object({
  /** Regex matched against tool_name (anchored). */
  tool: z.string(),
  /** Optional regex matched against a stringified tool_input (e.g. Bash command). */
  input: z.string().optional(),
  activity: z.enum(ACTIVITIES),
  zone: z.enum(ZONES).optional(),
  /** Bubble template; {tool}, {file}, {command}, {description}, {pattern} are substituted. */
  bubble: z.string().optional(),
});
export type ActivityRule = z.infer<typeof ActivityRuleSchema>;

export const DEFAULT_ACTIVITY_RULES: ActivityRule[] = [
  { tool: 'Agent|Task', activity: 'delegating', zone: 'meeting-room', bubble: 'Delegating: {description}' },
  { tool: 'Bash', input: '\\b(test|vitest|jest|pytest|playwright|go test|cargo test)\\b', activity: 'testing', zone: 'qa-lab', bubble: 'Running tests' },
  { tool: 'Bash', input: '\\b(npm audit|pnpm audit|snyk|trivy|semgrep|gitleaks)\\b', activity: 'running', zone: 'server-room', bubble: 'Security scan' },
  { tool: 'Bash', input: '\\bgit (diff|log|show)\\b', activity: 'reading', zone: 'review-booth', bubble: 'Reviewing diff' },
  { tool: 'Bash', activity: 'running', bubble: '$ {command}' },
  { tool: 'Edit|MultiEdit|Write|NotebookEdit', activity: 'typing', zone: 'desks', bubble: 'Editing {file}' },
  { tool: 'Read', activity: 'reading', bubble: 'Reading {file}' },
  { tool: 'Grep|Glob|ToolSearch', activity: 'searching', zone: 'library', bubble: 'Searching {pattern}' },
  { tool: 'WebFetch|WebSearch', activity: 'browsing', zone: 'library', bubble: 'Researching' },
  { tool: 'TodoWrite|TaskCreate|TaskUpdate', activity: 'thinking', zone: 'whiteboard', bubble: 'Planning' },
  { tool: 'AskUserQuestion|ExitPlanMode', activity: 'waiting', bubble: 'Waiting for you' },
  { tool: 'mcp__.*', activity: 'running', bubble: '{tool}' },
  { tool: '.*', activity: 'thinking', bubble: '{tool}' },
];

const ZoneSpotSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const SettingsSchema = z.object({
  server: z
    .object({
      /** Bind address. Keep 127.0.0.1 outside Docker; compose sets 0.0.0.0 inside the container. */
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(4317),
      corsOrigins: z
        .array(z.string())
        .default(['http://localhost:4318', 'http://127.0.0.1:4318', 'http://localhost:5173', 'http://127.0.0.1:5173']),
      /** Accepted Host header hostnames (port ignored). Blocks DNS-rebinding attacks. */
      allowedHosts: z.array(z.string()).default(['localhost', '127.0.0.1', '[::1]', 'server']),
      /** Shared secret sent by the hook as `x-office-token`. Empty = no auth (local only!). */
      hookToken: z.string().default(''),
      logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    })
    .prefault({}),
  storage: z
    .object({
      dbPath: z.string().default('./data/office.db'),
      eventRetentionDays: z.number().int().min(1).default(14),
      snapshotEventLimit: z.number().int().min(0).default(200),
    })
    .prefault({}),
  ingest: z
    .object({
      enabledEvents: z.array(z.string()).default([...HOOK_EVENTS]),
      /** Regexes (compiled with flags "gi"); matches in tool input/response become "[redacted]". */
      redactPatterns: z
        .array(z.string())
        .default([
          '(api[_-]?key|secret|token|password|passwd|authorization)["\'\\s:=]+[^\\s"\',]+',
          'sk-[A-Za-z0-9_-]{20,}',
          'gh[pousr]_[A-Za-z0-9]{20,}',
        ]),
      storeToolPayloads: z.boolean().default(false),
      maxPayloadBytes: z.number().int().default(1_048_576),
    })
    .prefault({}),
  paths: z
    .object({
      claudeDir: z.string().default('~/.claude'),
      agentsDir: z.string().default('~/.claude/agents'),
      projectsDir: z.string().default('~/.claude/projects'),
    })
    .prefault({}),
  agents: z
    .object({
      /** Seconds a finished subagent lingers (walks out) before it is removed from the floor. */
      doneLingerSec: z.number().min(0).default(20),
      /** Seconds without events before an active agent is shown idle in the lounge. */
      idleAfterSec: z.number().min(1).default(90),
      /** Map Claude agent_type → role name when they differ. */
      typeToRole: z.record(z.string(), z.string()).default({ 'general-purpose': 'developer', Explore: 'analyst', Plan: 'architect' }),
    })
    .prefault({}),
  sessions: z
    .object({
      /** Seconds without events before a session shows as idle. */
      idleAfterSec: z.number().min(1).default(90),
      /** Seconds without events (and no live subagents) before a session is ended (covers crashed CLIs). */
      endAfterSec: z.number().min(10).default(1800),
    })
    .prefault({}),
  transcripts: z
    .object({
      /** Read Claude Code transcripts (paths.projectsDir) for token usage. */
      enabled: z.boolean().default(true),
      /** Coalesce re-reads of a changing transcript file. */
      debounceMs: z.number().int().min(100).default(1500),
      /** A single transcript line (partial or not) longer than this is dropped, not buffered forever. */
      maxLineBytes: z
        .number()
        .int()
        .min(1024)
        .default(1024 * 1024),
      /** Stop tracking new bytes past this many per file (guards against an unbounded/adversarial transcript). */
      maxFileBytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .default(256 * 1024 * 1024),
      /** Cap on concurrently tracked transcript files (LRU-evicted beyond this). */
      maxTrackedFiles: z.number().int().min(1).default(256),
    })
    .prefault({}),
  activity: z.object({ rules: z.array(ActivityRuleSchema).default(DEFAULT_ACTIVITY_RULES) }).prefault({}),
  office: z
    .object({
      /** Day/night lighting. Independent of `style`. */
      theme: z.enum(['day', 'night', 'auto']).default('auto'),
      walkSpeed: z.number().min(10).max(1000).default(120),
      maxCharacters: z.number().int().min(1).default(40),
      showBubbles: z.boolean().default(true),
      bubbleSeconds: z.number().min(1).default(6),
      zoom: z.number().min(0.25).max(4).default(1),
      sound: z.boolean().default(false),
      /**
       * Optional zone rectangle overrides in tile units.
       * Deprecated since M7: floors are drawn in the office editor (layouts); ignored by the layout renderer.
       */
      zones: z.record(z.string(), ZoneSpotSchema).default({}),
      /** Visual skin (M7). A layout may override it with its own `style`. */
      style: z.enum(OFFICE_STYLES).default('guild'),
      /** Layout for floors without their own `layoutId` (and for the "All floors" view). */
      defaultLayoutId: z.string().regex(LAYOUT_ID_RE).default(DEFAULT_LAYOUT_ID),
      /** Stair order of floors: oldest project first (ground floor), by name, or most recently active first. */
      floorOrder: z.enum(['created', 'name', 'recent']).default('created'),
      /** Duration of the stairs transition between floors; 0 = instant. */
      floorTransitionMs: z.number().int().min(0).max(3000).default(600),
      /** Ambient particles and magic effects (torch flicker, sparkles, motes). Off = static art. */
      ambientEffects: z.boolean().default(true),
      /**
       * Cap on stored layouts (builtins don't count); `POST /api/layouts` (and `layouts:save`
       * without an id) 409s past this. Kept under `office` rather than a new top-level `layouts`
       * section, since a new section would need a web `SECTION_LABELS` entry too.
       */
      maxStoredLayouts: z.number().int().min(1).default(200),
    })
    .prefault({}),
  notifications: z
    .object({
      onWaiting: z.boolean().default(true),
      onDone: z.boolean().default(false),
      onBlocked: z.boolean().default(true),
    })
    .prefault({}),
  runner: z
    .object({
      enabled: z.boolean().default(false),
      maxConcurrent: z.number().int().min(1).default(3),
      defaultModel: z.enum(['opus', 'sonnet', 'haiku']).default('sonnet'),
      permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).default('acceptEdits'),
      allowedProjectDirs: z.array(z.string()).default([]),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type DeepPartial<T> = T extends Array<unknown> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type SettingsPatch = DeepPartial<Settings>;

/** Dotted paths that only take effect after a server restart. */
export const RESTART_REQUIRED_SETTINGS = ['server.host', 'server.port', 'server.corsOrigins', 'storage.dbPath', 'paths.projectsDir'] as const;

/**
 * Settings (dotted prefixes) that can only be set from config file / env, never from the GUI or API.
 * They control file-system paths, network exposure, secrets or future code execution.
 */
export const GUI_IMMUTABLE_SETTINGS = [
  'server',
  'storage.dbPath',
  'paths',
  'runner.permissionMode',
  'runner.allowedProjectDirs',
] as const;

/** Record-typed settings that a patch replaces wholesale instead of deep-merging. */
export const WHOLESALE_REPLACE_SETTINGS = ['agents.typeToRole', 'office.zones'] as const;

/** Placeholder the API returns instead of secret values. */
export const MASKED_SECRET = '********';

export const defaultSettings = (): Settings => SettingsSchema.parse({});
