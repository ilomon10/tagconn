import type { Settings } from '@tagconn/shared';

/** Human labels, hints and enum options for the generated settings form. */

export const SECTION_LABELS: Record<keyof Settings, { title: string; hint: string }> = {
  server: { title: 'Server', hint: 'Network binding and hook authentication.' },
  storage: { title: 'Storage', hint: 'Database location and retention.' },
  ingest: { title: 'Ingest', hint: 'Which hook events are stored and how payloads are redacted.' },
  paths: { title: 'Paths', hint: 'Where Claude Code keeps its files.' },
  agents: { title: 'Agents', hint: 'Lifecycle timings and agent type → role mapping.' },
  heroes: { title: 'Heroes', hint: 'Persistent named characters that subagents are assigned to (M8).' },
  sessions: { title: 'Sessions', hint: 'When a session shows idle, and when a stale one is considered ended.' },
  transcripts: { title: 'Transcripts', hint: 'Reading Claude Code transcripts to compute token usage.' },
  activity: { title: 'Activity rules', hint: 'First matching rule decides what a character does for a tool call.' },
  office: { title: 'Office', hint: 'Look and feel of the pixel office. Applied live.' },
  notifications: { title: 'Notifications', hint: 'Browser notifications for agent state changes.' },
  runner: { title: 'Runner (v2)', hint: 'Host runner that spawns claude -p. Not active yet.' },
  receptionist: { title: 'Receptionist', hint: 'Read-only help desk that answers questions in the browser (M8). Safety settings are file/env only.' },
  auth: { title: 'Admin access', hint: 'Pairing and admin sessions that guard writes and code execution (file/env only).' },
  attribution: { title: 'Attribution', hint: 'The .tagconn marker and profile import for projects that used tagconn.' },
};

export const ENUM_OPTIONS: Record<string, readonly string[]> = {
  'server.logLevel': ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
  'office.theme': ['day', 'night', 'auto'],
  'office.style': ['modern', 'guild'],
  'office.floorOrder': ['created', 'name', 'recent'],
  'office.pmMode': ['single', 'per-session'],
  'runner.defaultModel': ['opus', 'sonnet', 'haiku'],
  'runner.permissionMode': ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
};

export const KEY_HINTS: Record<string, string> = {
  'server.hookToken': 'Shared secret sent by the hook as x-office-token. Empty = no auth (local only!).',
  'server.corsOrigins': 'Browser origins allowed to open the socket.',
  'server.allowedHosts': 'Accepted Host header hostnames (blocks DNS rebinding).',
  'storage.snapshotEventLimit': 'Events sent in a snapshot; also caps the client-side log buffer (min 50).',
  'ingest.redactPatterns': 'One regex per line (flags "gi"); matches become [redacted].',
  'ingest.storeToolPayloads': 'Store full tool input/response (after redaction).',
  'agents.doneLingerSec': 'Seconds a finished subagent lingers (walks out) before removal.',
  'agents.idleAfterSec': 'Seconds without events before an agent goes to the lounge.',
  'agents.staleAfterSec': 'Seconds without events before a live subagent is presumed lost (killed or a missed stop event) and marked done. A later event brings it back.',
  'agents.typeToRole': 'Map Claude agent_type → role name when they differ.',
  'heroes.enabled': 'Bind agents to persistent named heroes. Off = anonymous characters (pre-M8 look).',
  'heroes.maxPerRole': 'Distinct named heroes per role per floor before new agents of that role go anonymous.',
  'heroes.maxPerProject': 'Distinct named heroes per floor, across all roles, before new agents go anonymous.',
  'heroes.reuseIdleAfterSec': "A new subagent may take over an idle subagent's hero after this long; 0 = never.",
  'sessions.idleAfterSec': 'Seconds without events before a session shows as idle.',
  'sessions.endAfterSec': 'Seconds without events (and no live subagents) before a session is ended — covers crashed CLIs.',
  'sessions.pmIdleLeaveSec': "Seconds a session's main agent can go without an event (with no other live agents of that session on the floor) before it leaves. It comes back on the session's next event.",
  'transcripts.enabled': 'Read Claude Code transcripts (paths.projectsDir) for token usage.',
  'transcripts.debounceMs': 'Coalesce re-reads of a changing transcript file.',
  'transcripts.maxLineBytes': 'A single transcript line (partial or not) longer than this is dropped, not buffered forever.',
  'transcripts.maxFileBytes': 'Stop tracking new bytes past this many per file (guards against an unbounded/adversarial transcript).',
  'transcripts.maxTrackedFiles': 'Cap on concurrently tracked transcript files (LRU-evicted beyond this).',
  'office.walkSpeed': 'Pixels per second.',
  'office.zoom': 'Base zoom multiplier (0.25 – 4). Mouse wheel zooms further.',
  'office.maxCharacters': 'Extra agents are listed in the roster but not drawn.',
  'office.bubbleSeconds': 'How long a speech bubble stays after it changes.',
  'office.style': 'Visual skin: modern (the original office) or guild (medieval fantasy). A layout may override this with its own style.',
  'office.defaultLayoutId': "Layout for floors without their own assigned layout, and for the \"All floors\" view. Managed from the office editor.",
  'office.floorOrder': 'Stair order of floors: oldest project first (ground floor), alphabetically by name, or most recently active first.',
  'office.floorTransitionMs': 'How long the stairs fade takes when moving between floors (0 = instant; also instant under reduced motion).',
  'office.ambientEffects': 'Torch flicker, sparkles and drifting motes. Off = static art (also off automatically under reduced motion).',
  'office.zones': 'Deprecated since M7 — draw floors in the office editor instead. Kept only as a fallback and ignored by the layout renderer.',
  'office.focusDim': 'How much non-selected characters dim while one is selected (0 disables focus mode).',
  'office.maxBubbles': 'Cap on simultaneous speech bubbles; extra ones collapse to a small "…" badge (expands on hover).',
  'office.labelMinZoom': 'Camera zoom below which name tags and bubbles hide except for the selected or waiting/blocked characters (shown again on hover).',
  'office.pmMode': "single: one Guild Master per floor (the most recently active session) plus a session count chip. per-session: today's behaviour — every main agent gets its own character.",
  'office.pmSwitchCooldownSec': 'Minimum seconds before the Guild Master switches to another session (a session that needs you switches at once). Only used in single mode.',
  'office.idleLeaveSec': 'Seconds a hero with no live agent rests in the tavern before walking out; 0 = leave at once.',
  'office.multiverseMaxRealms': 'Projects drawn on the Multiverse floor; extras are grouped into one "Other realms".',
  'office.multiverseMaxCharacters': 'Character cap on the Multiverse floor, split fairly across realms (Guild Masters first).',
  'runner.allowedProjectDirs': 'One directory per line.',
};

/**
 * Settings hidden from the generic per-key form because they get a dedicated editor instead (the
 * form would otherwise render a raw JSON textarea for them — see `LeafControl`'s fallback case).
 * `heroes.namePools` gets the Heroes editor's "Name pools" tab (docs/design/living-office.md 3.4).
 * Not yet read by `SettingsPanel` (same status as `DEPRECATED_SETTINGS` above); wiring it in is for
 * whichever task builds that generic-form skip (or the Heroes editor task, W5).
 */
export const HIDDEN_SETTINGS = ['heroes.namePools'] as const;

/** Settings kept for compatibility but superseded by newer functionality; the form flags them so
 *  people don't reach for them by habit. */
export const DEPRECATED_SETTINGS = ['office.zones'] as const;

export const NUMBER_STEP: Record<string, number> = {
  'office.zoom': 0.05,
  'office.labelMinZoom': 0.05,
  'office.focusDim': 0.05,
};

export const humanize = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bSec\b/, '(s)')
    .replace(/\bDb\b/, 'DB');
