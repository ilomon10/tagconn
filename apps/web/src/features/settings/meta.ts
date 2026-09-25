import type { Settings } from '@tagconn/shared';

/** Human labels, hints and enum options for the generated settings form. */

export const SECTION_LABELS: Record<keyof Settings, { title: string; hint: string }> = {
  server: { title: 'Server', hint: 'Network binding and hook authentication.' },
  storage: { title: 'Storage', hint: 'Database location and retention.' },
  ingest: { title: 'Ingest', hint: 'Which hook events are stored and how payloads are redacted.' },
  paths: { title: 'Paths', hint: 'Where Claude Code keeps its files.' },
  agents: { title: 'Agents', hint: 'Lifecycle timings and agent type → role mapping.' },
  sessions: { title: 'Sessions', hint: 'When a session shows idle, and when a stale one is considered ended.' },
  transcripts: { title: 'Transcripts', hint: 'Reading Claude Code transcripts to compute token usage.' },
  activity: { title: 'Activity rules', hint: 'First matching rule decides what a character does for a tool call.' },
  office: { title: 'Office', hint: 'Look and feel of the pixel office. Applied live.' },
  notifications: { title: 'Notifications', hint: 'Browser notifications for agent state changes.' },
  runner: { title: 'Runner (v2)', hint: 'Host runner that spawns claude -p. Not active yet.' },
};

export const ENUM_OPTIONS: Record<string, readonly string[]> = {
  'server.logLevel': ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
  'office.theme': ['day', 'night', 'auto'],
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
  'agents.typeToRole': 'Map Claude agent_type → role name when they differ.',
  'sessions.idleAfterSec': 'Seconds without events before a session shows as idle.',
  'sessions.endAfterSec': 'Seconds without events (and no live subagents) before a session is ended — covers crashed CLIs.',
  'transcripts.enabled': 'Read Claude Code transcripts (paths.projectsDir) for token usage.',
  'transcripts.debounceMs': 'Coalesce re-reads of a changing transcript file.',
  'office.walkSpeed': 'Pixels per second.',
  'office.zoom': 'Base zoom multiplier (0.25 – 4). Mouse wheel zooms further.',
  'office.maxCharacters': 'Extra agents are listed in the roster but not drawn.',
  'office.bubbleSeconds': 'How long a speech bubble stays after it changes.',
  'office.zones': 'Override zone rectangles in tile units (map is 48×30).',
  'runner.allowedProjectDirs': 'One directory per line.',
};

export const NUMBER_STEP: Record<string, number> = {
  'office.zoom': 0.05,
};

export const humanize = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bSec\b/, '(s)')
    .replace(/\bDb\b/, 'DB');
