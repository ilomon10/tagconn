import { z } from 'zod';
import { ACTIVITIES, ZONES } from './domain.js';
import { HOOK_EVENTS } from './hook.js';
import { ATTRIBUTION_MAX_PROFILE_BYTES } from './attribution.js';
import { AUTH_MODES, AUTH_PROTECT_LEVELS } from './auth.js';
import { DEFAULT_HERO_NAME_POOLS, HERO_LIMITS, HeroNamePoolsSchema } from './heroes.js';
import { DEFAULT_LAYOUT_ID, LAYOUT_ID_RE, OFFICE_STYLES } from './layout.js';
import { MULTIVERSE_LIMITS } from './multiverse.js';
import { DOMAIN_RE, RUN_MODELS, RUN_PERMISSION_MODES, TOOL_RULE_RE } from './runner.js';

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
      /**
       * Seconds without events before a live subagent (main excluded) is presumed lost — its
       * SubagentStop was killed or never sent — and marked `done`, then removed via the usual
       * `doneLingerSec` linger. A later hook event for the same agent_id un-marks and re-adds it.
       */
      staleAfterSec: z.number().min(1).default(900),
      /** Map Claude agent_type → role name when they differ. */
      typeToRole: z.record(z.string(), z.string()).default({ 'general-purpose': 'developer', Explore: 'analyst', Plan: 'architect' }),
    })
    .prefault({}),
  heroes: z
    .object({
      /** Bind agents to persistent named heroes (8i). Off = anonymous characters (pre-M8 look). */
      enabled: z.boolean().default(true),
      maxPerRole: z.number().int().min(1).max(HERO_LIMITS.hardMaxPerRole).default(6),
      maxPerProject: z.number().int().min(1).max(HERO_LIMITS.hardMaxPerProject).default(40),
      /** A new subagent may take over the hero of a subagent idle this long; 0 = never. */
      reuseIdleAfterSec: z.number().min(0).default(600),
      /** Role (or `default`) → names for new heroes. */
      namePools: HeroNamePoolsSchema.default(DEFAULT_HERO_NAME_POOLS),
    })
    .prefault({}),
  sessions: z
    .object({
      /** Seconds without events before a session shows as idle. */
      idleAfterSec: z.number().min(1).default(90),
      /** Seconds without events (and no live subagents) before a session is ended (covers crashed CLIs). */
      endAfterSec: z.number().min(10).default(1800),
      /**
       * Seconds a session's main agent (PM) can go without an event, with no other live agents of
       * that session on the floor either, before it leaves (removed, not ended). It reappears on the
       * session's next hook event.
       */
      pmIdleLeaveSec: z.number().min(1).default(600),
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
      /** Layout for floors without their own `layoutId`. */
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
      /** How much non-selected characters dim while another is selected (drawer open); 0 disables focus mode. */
      focusDim: z.number().min(0).max(1).default(0.35),
      /** Cap on simultaneously visible speech bubbles; lower-priority ones collapse to a small "…" badge (M8 8e). */
      maxBubbles: z.number().int().min(1).default(6),
      /** Camera zoom below which name tags and bubbles hide except for the selected or waiting/blocked characters (shown again on hover). */
      labelMinZoom: z.number().min(0).max(4).default(0.8),
      /** 8b. `single`: one Guild Master per floor (the most recently active session) + a session count chip. */
      pmMode: z.enum(['single', 'per-session']).default('single'),
      /** 8b. Minimum seconds before the Guild Master switches to another session (a session that needs you switches at once). */
      pmSwitchCooldownSec: z.number().min(0).max(600).default(15),
      /** 8c. Seconds a hero with no live agent rests in the tavern before walking out; 0 = leave at once. */
      idleLeaveSec: z.number().min(0).max(86_400).default(300),
      /** 8h. Realms drawn on the Multiverse floor; extra projects are grouped into one "Other realms". */
      multiverseMaxRealms: z.number().int().min(1).max(MULTIVERSE_LIMITS.maxRealms).default(MULTIVERSE_LIMITS.maxRealms),
      /** 8h. Character cap on the Multiverse floor (split fairly across realms; Guild Masters first). */
      multiverseMaxCharacters: z.number().int().min(1).max(MULTIVERSE_LIMITS.maxCharacters).default(60),
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
      permissionMode: z.enum(RUN_PERMISSION_MODES).default('acceptEdits'),
      allowedProjectDirs: z.array(z.string()).default([]),
      /** Runner shared secret, used only as an HMAC key (never sent). Empty = runner connections refused. Masked. */
      token: z.string().default(''),
      allowedPermissionModes: z.array(z.enum(RUN_PERMISSION_MODES)).default(['plan', 'dontAsk', 'default', 'acceptEdits']),
      /** Bare "WebFetch" is rejected here too (only WebFetch(domain:x)); the runner re-checks. */
      allowedTools: z
        .array(z.string().regex(TOOL_RULE_RE).refine((r) => r !== 'WebFetch', 'use WebFetch(domain:x)'))
        .default([]),
      disallowedTools: z.array(z.string().regex(TOOL_RULE_RE)).default([]),
      maxQueued: z.number().int().min(0).default(20),
      maxPromptChars: z.number().int().min(100).max(100_000).default(20_000),
      runTimeoutSec: z.number().int().min(10).max(86_400).default(3_600),
      maxTurns: z.number().int().min(1).max(500).optional(),
      maxEventsPerRun: z.number().int().min(10).max(100_000).default(5_000),
      maxEventBytesPerRun: z.number().int().min(10_000).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
      previewChars: z.number().int().min(100).max(8_000).default(2_000),
      partialMessages: z.boolean().default(true),
      runRetentionDays: z.number().int().min(1).default(30),
      lostGraceSec: z.number().int().min(5).max(600).default(30),
    })
    .prefault({}),
  receptionist: z
    .object({
      enabled: z.boolean().default(true),
      model: z.enum(RUN_MODELS).default('sonnet'),
      webSearch: z.boolean().default(true),
      /** "allowlist" = general scope only, bwrap required, WebFetch(domain:x) per entry; never bare WebFetch. */
      webFetch: z.enum(['never', 'allowlist']).default('never'),
      webFetchAllowDomains: z.array(z.string().regex(DOMAIN_RE)).max(50).default([]),
      extraDenyReadGlobs: z.array(z.string().regex(/^[^\n\r\0(),]{1,180}$/)).default([]),
      allowTagconnDocs: z.boolean().default(true),
      /** Add --safe-mode to project-scope turns (SC3 V5 trade-off; --restricted is always on there). */
      projectSafeMode: z.boolean().default(false),
      timeoutSec: z.number().int().min(10).max(3_600).default(300),
      maxTurns: z.number().int().min(1).max(100).default(30),
      maxConversations: z.number().int().min(1).max(1_000).default(50),
      maxMessagesPerConversation: z.number().int().min(2).max(2_000).default(200),
    })
    .prefault({}),
  auth: z
    .object({
      mode: z.enum(AUTH_MODES).default('pairing'),
      protect: z.enum(AUTH_PROTECT_LEVELS).default('all-writes'),
      sessionIdleHours: z.number().min(1).max(720).default(72),
      sessionMaxAgeDays: z.number().min(1).max(365).default(30),
      pairingCodeTtlSec: z.number().int().min(60).max(3_600).default(600),
      maxSessions: z.number().int().min(1).max(100).default(10),
      logPairingCodeOnBoot: z.boolean().default(true),
    })
    .prefault({}),
  attribution: z
    .object({
      enabled: z.boolean().default(true),
      autoImport: z.enum(['ask', 'auto', 'off']).default('ask'),
      maxProfileBytes: z.number().int().min(1_024).max(ATTRIBUTION_MAX_PROFILE_BYTES).default(ATTRIBUTION_MAX_PROFILE_BYTES),
      importWindowSec: z.number().int().min(10).max(3_600).default(120),
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
  'runner',
  'auth',
  'receptionist.webSearch',
  'receptionist.webFetch',
  'receptionist.webFetchAllowDomains',
  'receptionist.extraDenyReadGlobs',
  'receptionist.allowTagconnDocs',
  'receptionist.projectSafeMode',
] as const;

/** Record-typed settings that a patch replaces wholesale instead of deep-merging. */
export const WHOLESALE_REPLACE_SETTINGS = ['agents.typeToRole', 'office.zones', 'heroes.namePools'] as const;

/** Placeholder the API returns instead of secret values. */
export const MASKED_SECRET = '********';

export const defaultSettings = (): Settings => SettingsSchema.parse({});
