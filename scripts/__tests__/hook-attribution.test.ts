// Tests (run against BOTH office-hook.sh and office-hook.mjs) for the hooks' M8 attribution behavior (see
// docs/design/runner-and-helpdesk.md §6.2): the opt-in .tagconn/README.md
// write, the office.json import, and the TAGCONN_RUN_KIND=receptionist
// early exit. Runs the real hooks as child processes, with a fake
// `curl` on PATH for sh and a local HTTP server for node (so nothing ever touches the network) and a sandboxed
// HOME/CLAUDE_PROJECT_DIR (never the real ones - see support/real-paths-guard.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './support/sandbox.ts';
import {
  createHookSandbox as createSandboxFor,
  enableReadme as enableReadmeFor,
  HOOK_KINDS,
  type HookKind,
  type HookSandbox,
  makeFakeCurlBin,
  runHook as runHookWith,
  spawnHook,
  TEST_TOKEN,
  writeHookJson,
} from './support/hook-harness.ts';

const readmeTemplate = join(repoRoot, 'packages', 'agent-templates', 'attribution', 'README.md.tmpl');

type Sandbox = HookSandbox;

let binDir: string;

beforeAll(() => {
  binDir = makeFakeCurlBin();
});


/** Polls for the background attribution subshell to finish (it forks off the foreground POST). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!predicate()) throw new Error('waitFor: condition never became true');
}

// Give the background subshell a moment on every test, then assert.
async function afterBackground(): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
}


describe.each(HOOK_KINDS)('%s hook', (kind: HookKind) => {
const sandboxes: HookSandbox[] = [];
afterEach(async () => {
  for (const sb of sandboxes.splice(0)) await sb.server?.close();
});

async function createHookSandbox(): Promise<Sandbox> {
  const sb = await createSandboxFor(kind);
  sandboxes.push(sb);
  return sb;
}

/** Runs the hook with a JSON body on stdin (stdout is asserted empty by the harness). */
function runHook(sandbox: Sandbox, body: unknown, extraEnv: NodeJS.ProcessEnv = {}) {
  return runHookWith(binDir, sandbox, body, extraEnv);
}

function enableReadme(sandbox: Sandbox): void {
  enableReadmeFor(sandbox, readFileSync(readmeTemplate, 'utf8'));
}

let sandbox: Sandbox;

describe('office-hook basics', () => {
  it('always exits 0 and prints nothing on stdout, even with no config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagconn-hook-test-'));
    const res = await spawnHook(kind, JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart' }), {
      PATH: process.env.PATH ?? '',
      HOME: root,
      TAGCONN_CURL_CONF: join(root, 'nope', 'curl.conf'),
      TAGCONN_HOOK_CONFIG: join(root, 'nope', 'hook.json'),
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('posts the event to the fake curl (foreground) with the configured token/url', async () => {
    sandbox = await createHookSandbox();
    const res = await runHook(sandbox, { session_id: 'sess-1', hook_event_name: 'PreToolUse' });
    expect(res.status).toBe(0);
    await afterBackground();
    const log = readFileSync(sandbox.logFile, 'utf8');
    if (kind === 'sh') expect(log).toContain(`ARG: -K\nARG: ${sandbox.curlConf}`);
    else {
      expect(sandbox.server?.requests).toHaveLength(1);
      expect(sandbox.server?.requests[0]?.url).toBe('/api/hooks');
      expect(sandbox.server?.requests[0]?.headers['x-office-token']).toBe(TEST_TOKEN);
      expect(sandbox.server?.requests[0]?.headers['content-type']).toBe('application/json');
    }
    expect(log).toContain('"session_id":"sess-1"');
  });

  it('adds x-tagconn-run-id only for a UUID-shaped TAGCONN_RUN_ID', async () => {
    sandbox = await createHookSandbox();
    await runHook(sandbox, { session_id: 's', hook_event_name: 'PreToolUse' }, { TAGCONN_RUN_ID: '12345678-1234-1234-1234-123456789012' });
    await afterBackground();
    expect(readFileSync(sandbox.logFile, 'utf8')).toContain('x-tagconn-run-id: 12345678-1234-1234-1234-123456789012');
  });

  it('does not add the run-id header for a non-UUID value', async () => {
    sandbox = await createHookSandbox();
    await runHook(sandbox, { session_id: 's', hook_event_name: 'PreToolUse' }, { TAGCONN_RUN_ID: 'not-a-uuid' });
    await afterBackground();
    expect(readFileSync(sandbox.logFile, 'utf8')).not.toContain('run-id');
  });
});

describe('TAGCONN_RUN_KIND=receptionist', () => {
  it('exits immediately: no event POST, no attribution, no log file at all', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    const gitDir = join(sandbox.projectDir, '.git');
    mkdirSync(gitDir, { recursive: true });
    const res = await runHook(sandbox, { session_id: 'r1', hook_event_name: 'SessionStart' }, { TAGCONN_RUN_KIND: 'receptionist' });
    expect(res.status).toBe(0);
    await afterBackground();
    expect(existsSync(sandbox.logFile)).toBe(false);
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });
});

describe('.tagconn/README.md write (opt-in, guarded)', () => {
  it('writes the README when the project is a git repo, owned, not $HOME/root, and the template exists', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });

    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await waitFor(() => existsSync(join(sandbox.projectDir, '.tagconn', 'README.md')));

    // Whatever the template contains is copied verbatim (the text itself is not this test's business).
    const readme = readFileSync(join(sandbox.projectDir, '.tagconn', 'README.md'), 'utf8');
    expect(readme).toBe(readFileSync(readmeTemplate, 'utf8'));
  });

  it('does nothing when the attribution-README.md template is not installed', async () => {
    sandbox = await createHookSandbox();
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await afterBackground();
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });

  it('skips a non-git directory', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    // No .git created.
    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await afterBackground();
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });

  it('never writes into $HOME even if it is a git repo', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    mkdirSync(join(sandbox.home, '.git'), { recursive: true });
    // CLAUDE_PROJECT_DIR *is* $HOME for this test.
    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { CLAUDE_PROJECT_DIR: sandbox.home });
    await afterBackground();
    expect(existsSync(join(sandbox.home, '.tagconn'))).toBe(false);
  });

  it('skips (never overwrites) when .tagconn already exists as a plain file', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    writeFileSync(join(sandbox.projectDir, '.tagconn'), 'user opted out\n');
    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await afterBackground();
    expect(readFileSync(join(sandbox.projectDir, '.tagconn'), 'utf8')).toBe('user opted out\n');
  });

  it('skips (never follows) when .tagconn is a symlink', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    const elsewhere = join(sandbox.projectDir, '..', 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(sandbox.projectDir, '.tagconn'));
    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await afterBackground();
    expect(existsSync(join(elsewhere, 'README.md'))).toBe(false);
  });

  it('only ever acts on SessionStart, not other hook events', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    await runHook(sandbox, { session_id: 's', hook_event_name: 'Stop' });
    await afterBackground();
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });

  it('skips when TAGCONN_ATTRIBUTION=off', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { TAGCONN_ATTRIBUTION: 'off' });
    await afterBackground();
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });
});

describe('.tagconn/office.json import (opt-in via attribution.conf)', () => {
  // sh: import is opt-in via attribution.conf. node: on by default (hook.json), so the
  // "not opted in" case is attributionImport:false.
  function writeAttributionConf(sandbox: Sandbox): string {
    if (kind === 'node') return sandbox.hookJson;
    const confPath = join(sandbox.configDir, 'attribution.conf');
    writeFileSync(confPath, 'header = "x-office-token: importtoken"\nurl = "http://127.0.0.1:4317/api/attribution/import"\n', {
      mode: 0o600,
    });
    return confPath;
  }

  it('imports office.json with work/ and .gitignore present', async () => {
    sandbox = await createHookSandbox();
    writeAttributionConf(sandbox);
    const t = join(sandbox.projectDir, '.tagconn');
    mkdirSync(join(t, 'work'), { recursive: true });
    writeFileSync(join(t, '.gitignore'), 'work/\n');
    writeFileSync(join(t, 'office.json'), '{"kind":"tagconn.office-profile","version":1}\n');
    await runHook(sandbox, { session_id: 'sess-w', hook_event_name: 'SessionStart' });
    await waitFor(() => existsSync(sandbox.logFile) && readFileSync(sandbox.logFile, 'utf8').includes('x-tagconn-session-id: sess-w'));
  });

  it('POSTs office.json in the background with the session id header, when attribution.conf exists', async () => {
    sandbox = await createHookSandbox();
    writeAttributionConf(sandbox);
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    writeFileSync(join(sandbox.projectDir, '.tagconn', 'office.json'), '{"kind":"tagconn.office-profile","version":1}\n');

    await runHook(sandbox, { session_id: 'sess-import-1', hook_event_name: 'SessionStart' });
    await waitFor(() => existsSync(sandbox.logFile) && readFileSync(sandbox.logFile, 'utf8').includes('x-tagconn-session-id'));

    const log = readFileSync(sandbox.logFile, 'utf8');
    expect(log).toContain('x-tagconn-session-id: sess-import-1');
    expect(log).toContain('"kind":"tagconn.office-profile"');
  });

  it('does not import without attribution.conf', async () => {
    sandbox = await createHookSandbox();
    if (kind === 'node') writeHookJson(sandbox, { attributionImport: false });
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    writeFileSync(join(sandbox.projectDir, '.tagconn', 'office.json'), '{"kind":"tagconn.office-profile","version":1}\n');
    await runHook(sandbox, { session_id: 'sess-2', hook_event_name: 'SessionStart' });
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });

  it('skips a symlinked office.json', async () => {
    sandbox = await createHookSandbox();
    writeAttributionConf(sandbox);
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    const realFile = join(sandbox.configDir, 'real-office.json');
    writeFileSync(realFile, '{"kind":"tagconn.office-profile","version":1}\n');
    symlinkSync(realFile, join(sandbox.projectDir, '.tagconn', 'office.json'));
    await runHook(sandbox, { session_id: 'sess-3', hook_event_name: 'SessionStart' });
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });

  it('skips a symlinked .tagconn directory', async () => {
    sandbox = await createHookSandbox();
    writeAttributionConf(sandbox);
    const elsewhere = join(sandbox.projectDir, '..', 'elsewhere-tagconn');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'office.json'), '{"kind":"tagconn.office-profile","version":1}\n');
    symlinkSync(elsewhere, join(sandbox.projectDir, '.tagconn'));
    await runHook(sandbox, { session_id: 'sess-4', hook_event_name: 'SessionStart' });
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });

  it('skips a file larger than the 65536-byte cap', async () => {
    sandbox = await createHookSandbox();
    writeAttributionConf(sandbox);
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    writeFileSync(join(sandbox.projectDir, '.tagconn', 'office.json'), 'x'.repeat(65_537));
    await runHook(sandbox, { session_id: 'sess-5', hook_event_name: 'SessionStart' });
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });

  it('skips office.json when it is a FIFO, not a regular file (never blocks on head)', async () => {
    sandbox = await createHookSandbox();
    writeAttributionConf(sandbox);
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    const fifoPath = join(sandbox.projectDir, '.tagconn', 'office.json');
    const mkfifo = spawnSync('mkfifo', [fifoPath]);
    if (mkfifo.status !== 0) return; // mkfifo unavailable on this platform: nothing to assert.
    const res = await runHook(sandbox, { session_id: 'sess-fifo', hook_event_name: 'SessionStart' });
    expect(res.status).toBe(0); // must not hang reading from the FIFO.
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });
});

// The "SC4 hardening: perf gate for the hook_event_name check (M1)" timing-budget tests
// moved to hook-attribution.perf.test.ts (run via `pnpm test:perf`, not the default suite):
// they assert real elapsed time against a budget, which flakes on a loaded machine.

describe('SC4 hardening: canonicalized $HOME/project-dir guard (L1)', () => {
  it('never writes when CLAUDE_PROJECT_DIR has a trailing slash equal to $HOME', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    mkdirSync(join(sandbox.home, '.git'), { recursive: true });
    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { CLAUDE_PROJECT_DIR: `${sandbox.home}/` });
    await afterBackground();
    expect(existsSync(join(sandbox.home, '.tagconn'))).toBe(false);
  });

  it('never writes when CLAUDE_PROJECT_DIR is a symlink resolving to $HOME', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    mkdirSync(join(sandbox.home, '.git'), { recursive: true });
    const link = join(sandbox.home, '..', 'home-link');
    symlinkSync(sandbox.home, link);
    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { CLAUDE_PROJECT_DIR: link });
    await afterBackground();
    expect(existsSync(join(sandbox.home, '.tagconn'))).toBe(false);
  });

  it('still writes normally for an ordinary project dir once canonicalized (regression check)', async () => {
    sandbox = await createHookSandbox();
    enableReadme(sandbox);
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { CLAUDE_PROJECT_DIR: `${sandbox.projectDir}/` });
    await waitFor(() => existsSync(join(sandbox.projectDir, '.tagconn', 'README.md')));
  });
});

describe('agent working files in .tagconn (both hooks)', () => {
    it('still writes the README next to agent-made .tagconn/work and .gitignore, and touches nothing else', async () => {
      sandbox = await createHookSandbox();
      enableReadme(sandbox);
      mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
      const t = join(sandbox.projectDir, '.tagconn');
      mkdirSync(join(t, 'work'), { recursive: true });
      writeFileSync(join(t, '.gitignore'), 'work/\n');
      writeFileSync(join(t, 'work', 'note.md'), 'n\n');
      await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
      await waitFor(() => existsSync(join(t, 'README.md')));
      expect(readFileSync(join(t, 'README.md'), 'utf8')).toBe(readFileSync(readmeTemplate, 'utf8'));
      expect(readFileSync(join(t, '.gitignore'), 'utf8')).toBe('work/\n');
      expect(readFileSync(join(t, 'work', 'note.md'), 'utf8')).toBe('n\n');
      expect(readdirSync(t).sort()).toEqual(['.gitignore', 'README.md', 'work']);
    });

});

if (kind === 'node') {
  describe('README opt-in via hook.json', () => {
    it('does not write the README when attributionReadme is false, even with the template installed', async () => {
      sandbox = await createHookSandbox();
      writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
      mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
      await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
      await afterBackground();
      expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
    });

    it('never overwrites an existing README.md', async () => {
      sandbox = await createHookSandbox();
      enableReadme(sandbox);
      mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
      mkdirSync(join(sandbox.projectDir, '.tagconn'));
      writeFileSync(join(sandbox.projectDir, '.tagconn', 'README.md'), 'mine\n');
      await runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
      await afterBackground();
      expect(readFileSync(join(sandbox.projectDir, '.tagconn', 'README.md'), 'utf8')).toBe('mine\n');
    });
  });
}
});
