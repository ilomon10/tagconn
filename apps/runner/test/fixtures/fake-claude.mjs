#!/usr/bin/env node
// A fake `claude` CLI for unit tests: emits stream-json lines shaped like the real Claude Code CLI
// (docs/design/runner-and-helpdesk.md §2.5), without needing a real login or API access. Every
// behavior is driven by env vars so tests stay deterministic. Never used for the TAGCONN_REAL_CLI=1
// acceptance tests (those talk to the real `claude` binary).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const FAKE_VERSION = process.env.FAKE_CLAUDE_VERSION ?? '2.1.282';

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// --- --version / --help -----------------------------------------------------------------------
if (args.includes('--version')) {
  process.stdout.write(`${FAKE_VERSION} (Claude Code)\n`);
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write(
    [
      'Usage: claude [options]',
      '  --tools <list>',
      '  --restricted',
      '  --safe-mode',
      '  --permission-prompts <mode>',
      '  --disable-slash-commands',
      '  --strict-mcp-config',
      '  --setting-sources <sources>',
      '  --include-partial-messages',
      '  --permission-mode <mode>',
    ].join('\n'),
  );
  process.exit(0);
}

// --- flag parsing (--flag=value and --flag value both accepted for test convenience) -----------
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      flags[a.slice(2)] = next && !next.startsWith('--') ? next : 'true';
    }
  }
  return flags;
}

const flags = parseFlags(args);
const dashDashIndex = args.indexOf('--');
const fallbackPrompt = dashDashIndex !== -1 ? args.slice(dashDashIndex + 1).join(' ') : undefined;
const stdinPrompt = fallbackPrompt === undefined ? readStdinSync() : undefined;
const prompt = fallbackPrompt ?? stdinPrompt ?? '';

const mode = flags['permission-mode'] ?? 'default';
const rejectModes = (process.env.FAKE_CLAUDE_REJECT_MODES ?? '').split(',').filter(Boolean);
if (rejectModes.includes(mode)) {
  process.stderr.write(`error: invalid permission mode "${mode}"\n`);
  process.exit(1);
}

if (process.env.FAKE_CLAUDE_FAIL === '1') {
  process.stderr.write('simulated failure\n');
  process.exit(1);
}

if (process.env.FAKE_CLAUDE_SPAWN_GRANDCHILD === '1') {
  const child = spawnSync('sh', ['-c', 'setsid sleep 60 < /dev/null > /dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  if (process.env.FAKE_CLAUDE_GRANDCHILD_PIDFILE) {
    writeFileSync(process.env.FAKE_CLAUDE_GRANDCHILD_PIDFILE, child.stdout.trim());
  }
}

const sessionIdFromPrompt = /__FAKE_SESSION_ID__:([A-Za-z0-9_-]+)/.exec(prompt)?.[1];
const sessionId = flags.resume ?? sessionIdFromPrompt ?? process.env.FAKE_CLAUDE_SESSION_ID ?? `fake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const DEFAULT_TOOLS = ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'Agent', 'CronCreate', 'ScheduleWakeup', 'SendMessage', 'Workflow'];
const tools = flags.tools ? flags.tools.split(',') : process.env.FAKE_CLAUDE_TOOLS ? process.env.FAKE_CLAUDE_TOOLS.split(',') : DEFAULT_TOOLS;
// A Receptionist run's env is always passEnv:[] (runManager.ts), so a test that needs to trigger the
// L5 watchdog on a receptionist turn can't signal this fixture via FAKE_CLAUDE_MCP_SERVERS. The prompt
// itself always reaches this fixture (stdin), regardless of passEnv, so it doubles as a fallback
// signal: "__FAKE_MCP_SERVERS__:name1,name2" anywhere in the prompt.
const mcpServersFromPrompt = /__FAKE_MCP_SERVERS__:([A-Za-z0-9,_-]+)/.exec(prompt)?.[1];
const mcpServers = mcpServersFromPrompt
  ? mcpServersFromPrompt.split(',').filter(Boolean)
  : process.env.FAKE_CLAUDE_MCP_SERVERS
    ? process.env.FAKE_CLAUDE_MCP_SERVERS.split(',').filter(Boolean)
    : [];

// --- transcript directory simulation (bwrap capability probe / key derivation) ------------------
const transcriptMode = process.env.FAKE_CLAUDE_TRANSCRIPT_MODE ?? 'none';
if (transcriptMode !== 'none' && process.env.FAKE_CLAUDE_PROJECTS_DIR) {
  const key = transcriptMode === 'wrong' ? 'wrong-key' : process.cwd().replace(/[/.]/g, '-');
  mkdirSync(join(process.env.FAKE_CLAUDE_PROJECTS_DIR, key), { recursive: true });
}

out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: flags.model ?? 'sonnet', permissionMode: mode, tools, mcp_servers: mcpServers });

if (process.env.FAKE_CLAUDE_EXTRA_TOOL_USE) {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-extra', name: process.env.FAKE_CLAUDE_EXTRA_TOOL_USE, input: { x: 1 } }] } });
}

out({ type: 'assistant', message: { content: [{ type: 'text', text: `ok: ${prompt.slice(0, 200)}` }] } });

const exitCode = process.env.FAKE_CLAUDE_EXIT_CODE ? Number(process.env.FAKE_CLAUDE_EXIT_CODE) : 0;
out({
  type: 'result',
  subtype: exitCode === 0 ? 'success' : 'error_during_execution',
  is_error: exitCode !== 0,
  result: 'done',
  session_id: sessionId,
  total_cost_usd: 0.001,
  duration_ms: 5,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0);
if (sleepMs > 0) {
  spawnSync('sleep', [String(sleepMs / 1000)]);
}

process.exit(exitCode);
