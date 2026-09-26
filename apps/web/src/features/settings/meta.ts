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
  // Kept in sync with RUN_PERMISSION_MODES even though `runner` is entirely GUI-immutable (rendered
  // read-only): if that ever changes, the dropdown is already correct.
  'runner.permissionMode': ['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
  'receptionist.model': ['opus', 'sonnet', 'haiku'],
  'receptionist.webFetch': ['never', 'allowlist'],
  'auth.mode': ['pairing', 'same-origin'],
  'auth.protect': ['execution', 'all-writes'],
  'attribution.autoImport': ['ask', 'auto', 'off'],
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
  'office.shaders.enabled': 'Turn WebGL post-processing on or off. Ignored on the canvas renderer.',
  'office.shaders.quality': '"auto" picks low quality on a small or slow device (frame-time based).',
  'office.shaders.bloom': 'Bloom — glow around torches, braziers, monitors and windows; 0 = off.',
  'office.shaders.vignette': 'Vignette — darkened screen edges; 0 = off.',
  'office.shaders.grading': 'Color grading — per-style color grading (warm office, candlelit guild, aurora rift).',
  'office.shaders.lightGlow': 'Light glow — soft animated glow pools under light sources.',
  'office.shaders.scanlines': 'Scanlines — CRT scanlines and a slight curvature. Modern style only.',
  'office.pmMode': "single: one Guild Master per floor (the most recently active session) plus a session count chip. per-session: today's behaviour — every main agent gets its own character.",
  'office.pmSwitchCooldownSec': 'Minimum seconds before the Guild Master switches to another session (a session that needs you switches at once). Only used in single mode.',
  'office.idleLeaveSec': 'Seconds a hero with no live agent rests in the tavern before walking out; 0 = leave at once.',
  'office.multiverseMaxRealms': 'Projects drawn on the Multiverse floor; extras are grouped into one "Other realms".',
  'office.multiverseMaxCharacters': 'Character cap on the Multiverse floor, split fairly across realms (Guild Masters first).',
  'runner.enabled': 'Turn on the host runner (spawns `claude -p` for quests and the Receptionist). The runner daemon must also connect and prove its token.',
  'runner.maxConcurrent': "Quests/Receptionist turns running at once, further capped by the runner's own local limit.",
  'runner.defaultModel': 'Model used when a quest does not choose one.',
  'runner.permissionMode': 'Default permission mode for new quests when the browser does not choose one.',
  'runner.allowedProjectDirs': 'One directory per line.',
  'runner.token': 'Shared secret used only as an HMAC key for the runner connection (never sent on the wire). Empty = runner connections refused.',
  'runner.allowedPermissionModes': 'Modes a quest may request; the runner also enforces its own local `maxPermissionMode` cap.',
  'runner.allowedTools': 'Extra tool rules quests may use, on top of the runner\'s own host-side allowlist. Bare "WebFetch" is always rejected — use WebFetch(domain:x).',
  'runner.disallowedTools': "Tool rules always denied for quests, appended to the runner's own deny list.",
  'runner.maxQueued': 'Quests waiting for a free runner slot before new ones are refused.',
  'runner.maxPromptChars': 'Longest prompt a quest or follow-up may send.',
  'runner.runTimeoutSec': 'A quest is stopped if it runs longer than this.',
  'runner.maxTurns': "Cap on assistant turns per quest (unset = no cap; the CLI's own default applies).",
  'runner.maxEventsPerRun': 'Hard cap on streamed events kept per run before it is stopped (output_cap).',
  'runner.maxEventBytesPerRun': 'Hard cap on the total bytes of streamed events kept per run before it is stopped (output_cap).',
  'runner.previewChars': 'How much of a tool_use/tool_result is kept in the streamed preview.',
  'runner.partialMessages': 'Stream assistant text as it is generated, not just the final message.',
  'runner.runRetentionDays': 'How long finished runs and their events are kept before cleanup.',
  'runner.lostGraceSec': 'Seconds a run may go without a runner heartbeat after a disconnect before it is marked lost.',
  'receptionist.enabled': 'Turn the read-only help desk character on or off.',
  'receptionist.model': 'Model used for Receptionist turns.',
  'receptionist.webSearch': 'Allow the Receptionist to use WebSearch.',
  'receptionist.webFetch': '"never": no WebFetch at all. "allowlist": WebFetch only in general scope (not while reading a project), limited to the domains below, sandboxed.',
  'receptionist.webFetchAllowDomains': 'Bare domains (no scheme/port/path) the Receptionist may WebFetch when webFetch is "allowlist".',
  'receptionist.extraDenyReadGlobs': "Extra glob patterns the Receptionist may never read, on top of the built-in history/secrets deny list.",
  'receptionist.allowTagconnDocs': "Let the Receptionist read tagconn's own docs (a read-only copy) when answering questions about tagconn itself.",
  'receptionist.projectSafeMode': 'Add --safe-mode to project-scope turns: skips CLAUDE.md memory, at the cost of the model reading more files directly (SC3 V5 trade-off).',
  'receptionist.timeoutSec': 'A Receptionist turn is stopped if it runs longer than this.',
  'receptionist.maxTurns': 'Cap on assistant turns per Receptionist reply.',
  'receptionist.maxConversations': 'Stored Receptionist conversations kept before the oldest are pruned.',
  'receptionist.maxMessagesPerConversation': 'Messages kept per Receptionist conversation before the oldest are pruned.',
  'auth.mode': '"pairing": pair a browser with a one-time code. "same-origin" (file/env only) additionally allows same-origin bootstrap with no code.',
  'auth.protect': '"all-writes": every settings/layout/execution write needs an admin session. "execution": only code execution (runs, Receptionist, roles, attribution) needs one.',
  'auth.sessionIdleHours': "An admin session expires this many hours after its last use (sliding expiry).",
  'auth.sessionMaxAgeDays': "Absolute cap on an admin session's age, regardless of activity.",
  'auth.pairingCodeTtlSec': 'How long a freshly minted pairing code stays valid.',
  'auth.maxSessions': 'Admin sessions kept per install before the oldest is dropped.',
  'auth.logPairingCodeOnBoot': 'Print a fresh pairing code to the server log at boot when no admin session exists yet.',
  'attribution.enabled': 'Turn tagconn attribution (the .tagconn/ marker and profile import) on or off.',
  'attribution.autoImport': '"ask": a found profile waits for Import/Dismiss (default). "auto": import without asking. "off": never import (the hook can still write the opt-in README).',
  'attribution.maxProfileBytes': "Largest office.json the server will accept (hard ceiling from the contract; this can only lower it).",
  'attribution.importWindowSec': 'How long after a session starts an import from it is still accepted (guards against a stale SessionStart).',
};

/**
 * Converts a dotted settings path into the exact `OFFICE_<SECTION>__<KEY_SNAKE>` env var name the
 * server's layered config reads (`apps/server/src/core/config/load-config.ts`'s `envLayer`), so a
 * GUI-immutable field can point at exactly what to set instead of just "an env var".
 */
export const envVarName = (dotted: string): string =>
  `OFFICE_${dotted
    .split('.')
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase())
    .join('__')}`;

/**
 * Settings hidden from the generic per-key form because they get a dedicated editor instead (the
 * form would otherwise render a raw JSON textarea for them — see `LeafControl`'s fallback case).
 * `heroes.namePools` gets the Heroes editor's "Name pools" tab (docs/design/living-office.md 3.4).
 * `office.shaders` (M8 8o) gets the inline "Visual effects" group in the Office section
 * (`SettingsPanel`'s `ShaderEffectsGroup`) instead — every field there uses `KEY_HINTS` under
 * `office.shaders.*` the same way the generic form does.
 */
export const HIDDEN_SETTINGS = ['heroes.namePools', 'office.shaders'] as const;

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
