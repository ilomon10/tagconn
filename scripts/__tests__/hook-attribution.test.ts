// Tests for packages/hook/office-hook.sh's M8 attribution behavior (see
// docs/design/runner-and-helpdesk.md §6.2): the opt-in .tagconn/README.md
// write, the office.json import, and the TAGCONN_RUN_KIND=receptionist
// early exit. Runs the real shell script as a child process, with a fake
// `curl` on PATH (so nothing ever touches the network) and a sandboxed
// HOME/CLAUDE_PROJECT_DIR (never the real ones - see support/real-paths-guard.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './support/sandbox.ts';

const hookScript = join(repoRoot, 'packages', 'hook', 'office-hook.sh');
const readmeTemplate = join(repoRoot, 'packages', 'agent-templates', 'attribution', 'README.md.tmpl');

let binDir: string;

beforeAll(() => {
  // A fake `curl` that never touches the network: it appends its argv and
  // stdin to $FAKE_CURL_LOG, then exits 0 (mirroring a real successful POST).
  binDir = mkdtempSync(join(tmpdir(), 'tagconn-fake-bin-'));
  const fakeCurl = [
    '#!/bin/sh',
    'log="${FAKE_CURL_LOG:?FAKE_CURL_LOG not set}"',
    '{',
    '  echo "=== invocation ==="',
    '  for a in "$@"; do echo "ARG: $a"; done',
    '  echo "--- stdin ---"',
    '  cat',
    '  echo "--- end ---"',
    '} >> "$log"',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(binDir, 'curl'), fakeCurl, { mode: 0o755 });
});

interface Sandbox {
  home: string;
  configDir: string;
  curlConf: string;
  projectDir: string;
  logFile: string;
}

function createHookSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'tagconn-hook-test-'));
  const home = join(root, 'home');
  const configDir = join(root, 'config');
  const projectDir = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const curlConf = join(configDir, 'curl.conf');
  writeFileSync(curlConf, 'header = "x-office-token: testtoken"\nurl = "http://127.0.0.1:4317/api/hooks"\n', {
    mode: 0o600,
  });
  return { home, configDir, curlConf, projectDir, logFile: join(root, 'fake-curl.log') };
}

/** Runs the hook with a JSON body on stdin, returning once the (synchronous, foreground) part exits. */
function runHook(sandbox: Sandbox, body: unknown, extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: sandbox.home,
    TAGCONN_CURL_CONF: sandbox.curlConf,
    FAKE_CURL_LOG: sandbox.logFile,
    CLAUDE_PROJECT_DIR: sandbox.projectDir,
    ...extraEnv,
  };
  return spawnSync('sh', [hookScript], { input: JSON.stringify(body), encoding: 'utf8', env });
}

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

let sandbox: Sandbox;

afterEach(() => {
  sandbox = undefined as unknown as Sandbox;
});

describe('office-hook.sh basics', () => {
  it('always exits 0 and prints nothing on stdout, even with no config', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagconn-hook-test-'));
    const res = spawnSync('sh', [hookScript], {
      input: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: root, TAGCONN_CURL_CONF: join(root, 'nope', 'curl.conf') },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('posts the event to the fake curl (foreground) with the configured token/url', async () => {
    sandbox = createHookSandbox();
    const res = runHook(sandbox, { session_id: 'sess-1', hook_event_name: 'PreToolUse' });
    expect(res.status).toBe(0);
    await afterBackground();
    const log = readFileSync(sandbox.logFile, 'utf8');
    expect(log).toContain(`ARG: -K\nARG: ${sandbox.curlConf}`);
    expect(log).toContain('"session_id":"sess-1"');
  });

  it('adds x-tagconn-run-id only for a UUID-shaped TAGCONN_RUN_ID', async () => {
    sandbox = createHookSandbox();
    runHook(sandbox, { session_id: 's', hook_event_name: 'PreToolUse' }, { TAGCONN_RUN_ID: '12345678-1234-1234-1234-123456789012' });
    await afterBackground();
    expect(readFileSync(sandbox.logFile, 'utf8')).toContain('x-tagconn-run-id: 12345678-1234-1234-1234-123456789012');
  });

  it('does not add the run-id header for a non-UUID value', async () => {
    sandbox = createHookSandbox();
    runHook(sandbox, { session_id: 's', hook_event_name: 'PreToolUse' }, { TAGCONN_RUN_ID: 'not-a-uuid' });
    await afterBackground();
    expect(readFileSync(sandbox.logFile, 'utf8')).not.toContain('run-id');
  });
});

describe('TAGCONN_RUN_KIND=receptionist', () => {
  it('exits immediately: no event POST, no attribution, no log file at all', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    const gitDir = join(sandbox.projectDir, '.git');
    mkdirSync(gitDir, { recursive: true });
    const res = runHook(sandbox, { session_id: 'r1', hook_event_name: 'SessionStart' }, { TAGCONN_RUN_KIND: 'receptionist' });
    expect(res.status).toBe(0);
    await afterBackground();
    expect(existsSync(sandbox.logFile)).toBe(false);
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });
});

describe('.tagconn/README.md write (opt-in, guarded)', () => {
  it('writes the README when the project is a git repo, owned, not $HOME/root, and the template exists', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });

    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await waitFor(() => existsSync(join(sandbox.projectDir, '.tagconn', 'README.md')));

    const readme = readFileSync(join(sandbox.projectDir, '.tagconn', 'README.md'), 'utf8');
    expect(readme).toContain('.tagconn');
    expect(readme).toContain('tagconn');
  });

  it('does nothing when the attribution-README.md template is not installed', async () => {
    sandbox = createHookSandbox();
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await afterBackground();
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });

  it('skips a non-git directory', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    // No .git created.
    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await afterBackground();
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });

  it('never writes into $HOME even if it is a git repo', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    mkdirSync(join(sandbox.home, '.git'), { recursive: true });
    // CLAUDE_PROJECT_DIR *is* $HOME for this test.
    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { CLAUDE_PROJECT_DIR: sandbox.home });
    await afterBackground();
    expect(existsSync(join(sandbox.home, '.tagconn'))).toBe(false);
  });

  it('skips (never overwrites) when .tagconn already exists as a plain file', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    writeFileSync(join(sandbox.projectDir, '.tagconn'), 'user opted out\n');
    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await afterBackground();
    expect(readFileSync(join(sandbox.projectDir, '.tagconn'), 'utf8')).toBe('user opted out\n');
  });

  it('skips (never follows) when .tagconn is a symlink', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    const elsewhere = join(sandbox.projectDir, '..', 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(sandbox.projectDir, '.tagconn'));
    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' });
    await afterBackground();
    expect(existsSync(join(elsewhere, 'README.md'))).toBe(false);
  });

  it('only ever acts on SessionStart, not other hook events', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    runHook(sandbox, { session_id: 's', hook_event_name: 'Stop' });
    await afterBackground();
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });

  it('skips when TAGCONN_ATTRIBUTION=off', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { TAGCONN_ATTRIBUTION: 'off' });
    await afterBackground();
    expect(existsSync(join(sandbox.projectDir, '.tagconn'))).toBe(false);
  });
});

describe('.tagconn/office.json import (opt-in via attribution.conf)', () => {
  function writeAttributionConf(sandbox: Sandbox): string {
    const confPath = join(sandbox.configDir, 'attribution.conf');
    writeFileSync(confPath, 'header = "x-office-token: importtoken"\nurl = "http://127.0.0.1:4317/api/attribution/import"\n', {
      mode: 0o600,
    });
    return confPath;
  }

  it('POSTs office.json in the background with the session id header, when attribution.conf exists', async () => {
    sandbox = createHookSandbox();
    writeAttributionConf(sandbox);
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    writeFileSync(join(sandbox.projectDir, '.tagconn', 'office.json'), '{"kind":"tagconn.office-profile","version":1}\n');

    runHook(sandbox, { session_id: 'sess-import-1', hook_event_name: 'SessionStart' });
    await waitFor(() => existsSync(sandbox.logFile) && readFileSync(sandbox.logFile, 'utf8').includes('x-tagconn-session-id'));

    const log = readFileSync(sandbox.logFile, 'utf8');
    expect(log).toContain('x-tagconn-session-id: sess-import-1');
    expect(log).toContain('"kind":"tagconn.office-profile"');
  });

  it('does not import without attribution.conf', async () => {
    sandbox = createHookSandbox();
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    writeFileSync(join(sandbox.projectDir, '.tagconn', 'office.json'), '{"kind":"tagconn.office-profile","version":1}\n');
    runHook(sandbox, { session_id: 'sess-2', hook_event_name: 'SessionStart' });
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });

  it('skips a symlinked office.json', async () => {
    sandbox = createHookSandbox();
    writeAttributionConf(sandbox);
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    const realFile = join(sandbox.configDir, 'real-office.json');
    writeFileSync(realFile, '{"kind":"tagconn.office-profile","version":1}\n');
    symlinkSync(realFile, join(sandbox.projectDir, '.tagconn', 'office.json'));
    runHook(sandbox, { session_id: 'sess-3', hook_event_name: 'SessionStart' });
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });

  it('skips a symlinked .tagconn directory', async () => {
    sandbox = createHookSandbox();
    writeAttributionConf(sandbox);
    const elsewhere = join(sandbox.projectDir, '..', 'elsewhere-tagconn');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'office.json'), '{"kind":"tagconn.office-profile","version":1}\n');
    symlinkSync(elsewhere, join(sandbox.projectDir, '.tagconn'));
    runHook(sandbox, { session_id: 'sess-4', hook_event_name: 'SessionStart' });
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });

  it('skips a file larger than the 65536-byte cap', async () => {
    sandbox = createHookSandbox();
    writeAttributionConf(sandbox);
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    writeFileSync(join(sandbox.projectDir, '.tagconn', 'office.json'), 'x'.repeat(65_537));
    runHook(sandbox, { session_id: 'sess-5', hook_event_name: 'SessionStart' });
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });

  it('skips office.json when it is a FIFO, not a regular file (never blocks on head)', async () => {
    sandbox = createHookSandbox();
    writeAttributionConf(sandbox);
    mkdirSync(join(sandbox.projectDir, '.tagconn'), { recursive: true });
    const fifoPath = join(sandbox.projectDir, '.tagconn', 'office.json');
    const mkfifo = spawnSync('mkfifo', [fifoPath]);
    if (mkfifo.status !== 0) return; // mkfifo unavailable on this platform: nothing to assert.
    const res = runHook(sandbox, { session_id: 'sess-fifo', hook_event_name: 'SessionStart' });
    expect(res.status).toBe(0); // must not hang reading from the FIFO.
    await afterBackground();
    const log = existsSync(sandbox.logFile) ? readFileSync(sandbox.logFile, 'utf8') : '';
    expect(log).not.toContain('x-tagconn-session-id');
  });
});

describe('SC4 hardening: perf gate for the hook_event_name check (M1)', () => {
  it('stays fast on a large non-SessionStart body (no sed forked over megabytes of data)', async () => {
    sandbox = createHookSandbox();
    // No attribution-README.md / attribution.conf installed, so this only
    // exercises the foreground POST + the is_session_start gate - exactly
    // the path that used to fork `sed` over the whole body on every event.
    const bigBody = { session_id: 's', hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(8_000_000) };
    const start = Date.now();
    const res = runHook(sandbox, bigBody);
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(0);
    // Generous budget (CI can be slow) but meaningful: the regression this
    // guards against measured ~1.2s for an 8MB body; a healthy run is a few
    // hundred ms (dominated by piping 8MB through the fake curl itself).
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('also stays fast when the body contains the literal string "SessionStart" but is large', async () => {
    sandbox = createHookSandbox();
    const bigBody = {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_response: `mentions SessionStart once, then: ${'x'.repeat(8_000_000)}`,
    };
    const start = Date.now();
    const res = runHook(sandbox, bigBody);
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(0);
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe('SC4 hardening: canonicalized $HOME/project-dir guard (L1)', () => {
  it('never writes when CLAUDE_PROJECT_DIR has a trailing slash equal to $HOME', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    mkdirSync(join(sandbox.home, '.git'), { recursive: true });
    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { CLAUDE_PROJECT_DIR: `${sandbox.home}/` });
    await afterBackground();
    expect(existsSync(join(sandbox.home, '.tagconn'))).toBe(false);
  });

  it('never writes when CLAUDE_PROJECT_DIR is a symlink resolving to $HOME', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    mkdirSync(join(sandbox.home, '.git'), { recursive: true });
    const link = join(sandbox.home, '..', 'home-link');
    symlinkSync(sandbox.home, link);
    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { CLAUDE_PROJECT_DIR: link });
    await afterBackground();
    expect(existsSync(join(sandbox.home, '.tagconn'))).toBe(false);
  });

  it('still writes normally for an ordinary project dir once canonicalized (regression check)', async () => {
    sandbox = createHookSandbox();
    writeFileSync(join(sandbox.configDir, 'attribution-README.md'), readFileSync(readmeTemplate, 'utf8'));
    mkdirSync(join(sandbox.projectDir, '.git'), { recursive: true });
    runHook(sandbox, { session_id: 's', hook_event_name: 'SessionStart' }, { CLAUDE_PROJECT_DIR: `${sandbox.projectDir}/` });
    await waitFor(() => existsSync(join(sandbox.projectDir, '.tagconn', 'README.md')));
  });
});
