import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bwrapAvailable, probeSystemdScope } from '../../src/capabilities.js';
import { reapStaleQuestScopes, spawnRun, type SpawnSpec, type SystemctlSpawn } from '../../src/runProcess.js';
import { FAKE_CLAUDE_PATH, mkSandbox, rmSandbox } from '../helpers.js';
import type { RunEvent } from '@tagconn/shared';

const limits = { previewChars: 2000, maxStderrLines: 50, maxLineBytes: 1024 * 1024 };

function collect() {
  const events: RunEvent[] = [];
  let exitInfo: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  let resolveDone!: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    events,
    callbacks: {
      onEvent: (e: RunEvent) => events.push(e),
      onExit: (info: { exitCode: number | null; signal: NodeJS.Signals | null }) => {
        exitInfo = info;
        resolveDone();
      },
    },
    waitForExit: async () => {
      await donePromise;
      return exitInfo!;
    },
  };
}

describe('spawnRun: plain wrapper', () => {
  it('parses stream-json stdout into RunEvents and reports the exit code', async () => {
    const c = collect();
    const spec: SpawnSpec = { command: process.execPath, args: [FAKE_CLAUDE_PATH, '--permission-mode=acceptEdits', '--model=sonnet'], cwd: '/tmp', env: { PATH: process.env.PATH ?? '' }, wrapper: 'plain', stdin: 'hello' };
    spawnRun(spec, limits, 2000, c.callbacks);
    const exit = await c.waitForExit();
    expect(exit.exitCode).toBe(0);
    expect(c.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['init', 'text', 'result']));
  });

  it('reports stderr lines as warn notices, capped at maxStderrLines', async () => {
    const c = collect();
    const spec: SpawnSpec = {
      command: process.execPath,
      args: ['-e', 'for (let i=0;i<5;i++) console.error("line"+i)'],
      cwd: '/tmp',
      env: { PATH: process.env.PATH ?? '' },
      wrapper: 'plain',
    };
    spawnRun(spec, { ...limits, maxStderrLines: 2 }, 2000, c.callbacks);
    await c.waitForExit();
    const notices = c.events.filter((e): e is Extract<RunEvent, { kind: 'notice' }> => e.kind === 'notice');
    expect(notices.length).toBe(3); // 2 forwarded lines + 1 cap-reached summary
  });

  it('SC5 re-review: an ENOENT spawn (bad command) ends the run cleanly via onExit, instead of crashing the process', async () => {
    // Node's child_process emits 'error' (not a synchronous throw) for a command that does not exist.
    // An EventEmitter's 'error' event with no listener throws and crashes the whole process — this
    // only proves spawnRun's own 'error' listener absorbs it and still reports the run as ended.
    const c = collect();
    const spec: SpawnSpec = { command: '/definitely/not/a/real/binary-xyz', args: [], cwd: '/tmp', env: { PATH: process.env.PATH ?? '' }, wrapper: 'plain' };
    expect(() => spawnRun(spec, limits, 500, c.callbacks)).not.toThrow();
    const exit = await c.waitForExit();
    expect(exit.exitCode).toBeNull();
    const notices = c.events.filter((e): e is Extract<RunEvent, { kind: 'notice' }> => e.kind === 'notice');
    expect(notices.some((n) => n.message.includes('spawn error'))).toBe(true);
  });

  it('stop() terminates a long-running plain process', async () => {
    const c = collect();
    const spec: SpawnSpec = {
      command: process.execPath,
      args: [FAKE_CLAUDE_PATH],
      cwd: '/tmp',
      env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: '30000' } as Record<string, string>,
      wrapper: 'plain',
      stdin: 'hi',
    };
    const handle = spawnRun(spec, limits, 500, c.callbacks);
    setTimeout(() => handle.stop(), 200);
    const exit = await c.waitForExit();
    expect(exit.exitCode === null || exit.exitCode !== 0 || exit.signal !== null).toBe(true);
  }, 10_000);
});

const hasSystemdScope = probeSystemdScope();
describe.skipIf(!hasSystemdScope)('spawnRun: systemd-scope wrapper (V13 containment)', () => {
  it('systemctl --user stop <unit> reaches a setsid grandchild that a plain kill would miss', async () => {
    const sandbox = mkSandbox();
    const pidFile = join(sandbox, 'grandchild.pid');
    const c = collect();
    const claudeArgv = [process.execPath, FAKE_CLAUDE_PATH];
    const runId = `test-${Date.now()}`;
    const spec: SpawnSpec = {
      command: 'systemd-run',
      args: ['--user', '--scope', '--quiet', `--unit=tagconn-test-${runId}`, '-p', 'KillMode=control-group', '--', ...claudeArgv],
      cwd: sandbox,
      env: { ...process.env, FAKE_CLAUDE_SPAWN_GRANDCHILD: '1', FAKE_CLAUDE_GRANDCHILD_PIDFILE: pidFile, FAKE_CLAUDE_SLEEP_MS: '10000' } as Record<string, string>,
      wrapper: 'systemd-scope',
      scopeUnitName: `tagconn-test-${runId}.scope`,
      stdin: 'hi',
    };
    const handle = spawnRun(spec, limits, 1000, c.callbacks);
    // Wait for the fake CLI to report its grandchild's pid.
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(pidFile)).toBe(true);
    const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(grandchildPid).toBeGreaterThan(0);

    handle.stop();
    await new Promise((r) => setTimeout(r, 1500));
    expect(isAlive(grandchildPid)).toBe(false);
    rmSandbox(sandbox);
  }, 15_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const hasBwrap = bwrapAvailable();
describe.skipIf(!hasBwrap)('spawnRun: bwrap wrapper (--unshare-pid takes the whole namespace down)', () => {
  it('killing the bwrap process also ends its sandboxed grandchild', async () => {
    const c = collect();
    const claudeArgv = [process.execPath, FAKE_CLAUDE_PATH];
    const spec: SpawnSpec = {
      command: 'bwrap',
      args: ['--die-with-parent', '--unshare-pid', '--dev', '/dev', '--proc', '/proc', '--ro-bind', '/', '/', '--chdir', '/tmp', '--', ...claudeArgv],
      cwd: '/tmp',
      env: { ...process.env, FAKE_CLAUDE_SLEEP_MS: '10000' } as Record<string, string>,
      wrapper: 'bwrap',
      stdin: 'hi',
    };
    const handle = spawnRun(spec, limits, 500, c.callbacks);
    await new Promise((r) => setTimeout(r, 500));
    handle.stop();
    const exit = await c.waitForExit();
    expect(exit).toBeDefined();
  }, 10_000);
});

describe('reapStaleQuestScopes (SC5 L9)', () => {
  it('stops every listed tagconn-quest-*.scope unit and returns their names', () => {
    const calls: string[][] = [];
    const fakeSystemctl: SystemctlSpawn = (args) => {
      calls.push(args);
      if (args[1] === 'list-units') {
        return { status: 0, stdout: 'tagconn-quest-aaa.scope loaded active running\ntagconn-quest-bbb.scope loaded active running\n' };
      }
      return { status: 0, stdout: '' };
    };
    const stopped = reapStaleQuestScopes(fakeSystemctl);
    expect(stopped).toEqual(['tagconn-quest-aaa.scope', 'tagconn-quest-bbb.scope']);
    expect(calls).toContainEqual(['--user', 'stop', 'tagconn-quest-aaa.scope']);
    expect(calls).toContainEqual(['--user', 'stop', 'tagconn-quest-bbb.scope']);
  });

  it('returns an empty list when nothing matches, without stopping anything', () => {
    const fakeSystemctl: SystemctlSpawn = () => ({ status: 0, stdout: '' });
    expect(reapStaleQuestScopes(fakeSystemctl)).toEqual([]);
  });

  it('fails safe (never throws) when systemctl --user is unavailable', () => {
    const throwing: SystemctlSpawn = () => {
      throw new Error('systemctl: command not found');
    };
    expect(() => reapStaleQuestScopes(throwing)).not.toThrow();
    expect(reapStaleQuestScopes(throwing)).toEqual([]);
  });

  it('ignores a non-zero exit (e.g. no systemd user session)', () => {
    const fakeSystemctl: SystemctlSpawn = () => ({ status: 1, stdout: '' });
    expect(reapStaleQuestScopes(fakeSystemctl)).toEqual([]);
  });
});
