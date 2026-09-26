// Shared harness for packages/hook/office-hook.sh tests (functional in
// hook-attribution.test.ts, timing/perf-budget in hook-attribution.perf.test.ts):
// a fake `curl` on PATH so nothing ever touches the network, and a sandboxed
// HOME/CLAUDE_PROJECT_DIR (never the real ones - see support/real-paths-guard.ts).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './sandbox.ts';

export const hookScript = join(repoRoot, 'packages', 'hook', 'office-hook.sh');

/**
 * Creates a fake `curl` that never touches the network: it appends its argv and
 * stdin to $FAKE_CURL_LOG, then exits 0 (mirroring a real successful POST).
 * Returns the bin dir to prepend to PATH.
 */
export function makeFakeCurlBin(): string {
  const binDir = mkdtempSync(join(tmpdir(), 'tagconn-fake-bin-'));
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
  return binDir;
}

export interface HookSandbox {
  home: string;
  configDir: string;
  curlConf: string;
  projectDir: string;
  logFile: string;
}

export function createHookSandbox(): HookSandbox {
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
export function runHook(binDir: string, sandbox: HookSandbox, body: unknown, extraEnv: NodeJS.ProcessEnv = {}) {
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
