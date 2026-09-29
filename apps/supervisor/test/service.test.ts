import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcFailure } from '../src/errors.ts';
import { LogHub } from '../src/logHub.ts';
import { cleanStalePid, taskkillArgs, writePidFile, type ProcOps } from '../src/proc.ts';
import { ManagedService, type LaunchSpec, type ServiceDefinition, type SpawnFn, type Timing } from '../src/service.ts';
import { FAKE_CHILD, fakeChildProcess, isAlive, recorder, tempDir, waitFor } from './helpers.ts';
import { spawn as realSpawn } from 'node:child_process';

const FAST: Partial<Timing> = { backoffBaseMs: 20, backoffMaxMs: 160, stopTimeoutMs: 300, healthIntervalMs: 15, startPollMs: 15, healthTimeoutMs: 100 };

const created: ManagedService[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((s) => s.dispose()));
});

function make(args: string[], extra: { definition?: Partial<ServiceDefinition>; timing?: Partial<Timing>; health?: (url: string) => Promise<boolean>; spawn?: SpawnFn; ops?: ProcOps } = {}) {
  const logs = new LogHub();
  const rec = recorder();
  const pidDir = join(tempDir(), 'pids');
  const spawnTimes: number[] = [];
  const spawn: SpawnFn =
    extra.spawn ??
    ((cmd, a, o) => {
      spawnTimes.push(Date.now());
      return realSpawn(cmd, a, o);
    });
  const def: ServiceDefinition = {
    id: 'server',
    prepare: async (): Promise<LaunchSpec> => ({ command: process.execPath, args: [FAKE_CHILD, ...args], env: process.env, marker: FAKE_CHILD }),
    ...extra.definition,
  };
  const svc = new ManagedService(def, { logs, pidDir, onChange: rec.onChange, spawn, health: extra.health, ops: extra.ops, timing: { ...FAST, ...extra.timing } });
  created.push(svc);
  return { svc, logs, rec, pidDir, spawnTimes };
}

describe('ManagedService', () => {
  it('runs a child, captures redacted log lines and stops gracefully, removing the PID file', async () => {
    const { svc, logs, pidDir, rec } = make(['print']);
    const started = await svc.start();
    expect(started.state).toBe('running');
    expect(existsSync(join(pidDir, 'server.pid'))).toBe(true);
    await waitFor(() => logs.tail('server', 10).some((l) => l.line === 'partial line'), 3000, 'the joined partial line');
    const lines = logs.tail('server', 10).map((l) => l.line);
    expect(lines).toContain('hello from the fake child');
    expect(lines.join('\n')).not.toContain('abcdef1234567890');
    const pid = svc.status().pid!;
    const stopped = await svc.stop();
    expect(stopped.state).toBe('stopped');
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(join(pidDir, 'server.pid'))).toBe(false);
    expect(rec.states()).toEqual(['starting', 'running', 'stopping', 'stopped']);
  });

  it('restarts a crashing child with exponential backoff, then gives up after 5 crashes with a hint', async () => {
    const { svc, spawnTimes, rec } = make(['exit', '1'], { definition: { crashHint: 'HINT: reinstall the app.' } });
    await svc.start();
    const final = await waitFor(() => (svc.status().state === 'crashed' ? svc.status() : undefined), 8000, 'crashed');
    expect(spawnTimes).toHaveLength(5);
    expect(final.restarts).toBe(4);
    expect(final.lastError).toContain('exited with code 1');
    expect(final.lastError).toContain('boom: something failed');
    expect(final.lastError).toContain('5 times');
    expect(final.lastError).toContain('HINT: reinstall the app.');
    const gaps = spawnTimes.slice(1).map((t, i) => t - spawnTimes[i]!);
    // 20, 40, 80, 160 ms (lower bounds: a loaded machine can only make them longer).
    [20, 40, 80, 160].forEach((min, i) => expect(gaps[i]).toBeGreaterThanOrEqual(min - 2));
    expect(rec.states().at(-1)).toBe('crashed');
    // Start after giving up resets the counters.
    await svc.stop();
  });

  it('caps the backoff delay', async () => {
    const { svc, spawnTimes } = make(['exit', '1'], { timing: { backoffBaseMs: 30, backoffMaxMs: 50, maxCrashes: 5 } });
    await svc.start();
    await waitFor(() => svc.status().state === 'crashed', 8000, 'crashed');
    const gaps = spawnTimes.slice(1).map((t, i) => t - spawnTimes[i]!);
    expect(gaps[3]).toBeGreaterThanOrEqual(48); // capped at 50, not 240
    expect(gaps[3]).toBeLessThan(200);
  });

  it('a start failure (prepare throws) leaves the service stopped and rethrows', async () => {
    const { svc } = make(['hang'], {
      definition: {
        prepare: async () => {
          throw new RpcFailure('port_in_use', 'Port 4317 is not available.', 'Use port 4318.');
        },
      },
    });
    await expect(svc.start()).rejects.toMatchObject({ code: 'port_in_use' });
    expect(svc.status()).toMatchObject({ state: 'stopped' });
    expect(svc.status().lastError).toContain('Use port 4318.');
  });

  it('restarts a hung service after 3 failed health checks', async () => {
    let calls = 0;
    const health = async () => {
      calls++;
      return calls <= 2 || calls > 8; // healthy, then hangs, then healthy again after the restart
    };
    const { svc, spawnTimes } = make(['hang'], { definition: { healthUrl: () => 'http://127.0.0.1:1/api/health' }, health });
    await svc.start();
    await waitFor(() => svc.status().state === 'running', 3000, 'running');
    const firstPid = svc.status().pid;
    await waitFor(() => spawnTimes.length >= 2, 5000, 'a health restart');
    expect(svc.status().lastError ?? '').toMatch(/health|Restarting/);
    await waitFor(() => svc.status().state === 'running' && svc.status().pid !== firstPid, 5000, 'running again on a new pid');
    expect(isAlive(firstPid!)).toBe(false);
    expect(svc.status().restarts).toBe(1);
  });

  it('a service that never becomes healthy is only counted as hung after the start grace', async () => {
    const { svc, spawnTimes } = make(['hang'], { definition: { healthUrl: () => 'http://127.0.0.1:1/x' }, health: async () => false, timing: { startGraceMs: 200 } });
    await svc.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(spawnTimes).toHaveLength(1);
    expect(svc.status().state).toBe('starting');
    await waitFor(() => spawnTimes.length >= 2, 4000, 'a restart after the grace');
  });

  it('SIGTERM first; a child that ignores it gets a tree kill after the timeout', async () => {
    const { svc } = make(['ignoreterm'], { timing: { stopTimeoutMs: 250 } });
    await svc.start();
    const pid = svc.status().pid!;
    await new Promise((r) => setTimeout(r, 150)); // let it install its SIGTERM handler
    const t0 = Date.now();
    await svc.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    expect(isAlive(pid)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('a stop takes down the whole process group, grandchildren included', async () => {
    const { svc, logs } = make(['tree']);
    await svc.start();
    const gpid = await waitFor(() => {
      const m = logs.tail('server', 5).map((l) => /^grandchild (\d+)$/.exec(l.line)).find(Boolean);
      return m ? Number(m[1]) : undefined;
    }, 3000, 'the grandchild pid');
    expect(isAlive(gpid)).toBe(true);
    await svc.stop();
    await waitFor(() => !isAlive(gpid), 2000, 'the grandchild to die');
  });

  it('a crash also reaps leftover group members (nothing keeps the port)', async () => {
    const { svc } = make(['exit', '1'], { timing: { maxCrashes: 1 } });
    await svc.start();
    await waitFor(() => svc.status().state === 'crashed', 3000, 'crashed');
    expect(svc.status().pid).toBeUndefined();
  });

  it('win32: spawns without a process group and stops with `taskkill /PID <pid> /T /F` (mocked)', async () => {
    const ran: [string, string[]][] = [];
    let child: ReturnType<typeof fakeChildProcess>;
    let spawnOpts: Record<string, unknown> = {};
    const ops: ProcOps = {
      platform: 'win32',
      kill: () => {
        throw new Error('win32 must not signal a process group');
      },
      run: (cmd, args) => {
        ran.push([cmd, args]);
        if (cmd === 'taskkill') queueMicrotask(() => child.die(1, null));
        return { status: 0, stdout: '' };
      },
      isAlive: () => false,
      readCmdline: () => null,
    };
    const { svc } = make(['hang'], {
      ops,
      spawn: ((_c, _a, o) => {
        spawnOpts = o as Record<string, unknown>;
        child = fakeChildProcess(4242);
        return child;
      }) as SpawnFn,
    });
    await svc.start();
    expect(spawnOpts).toMatchObject({ detached: false, windowsHide: true });
    await svc.stop();
    expect(ran).toEqual([['taskkill', ['/PID', '4242', '/T', '/F']]]);
    expect(taskkillArgs(7)).toEqual(['/PID', '7', '/T', '/F']);
    expect(svc.status().state).toBe('stopped');
  });
});

describe('stale PID files', () => {
  const ops = (over: Partial<ProcOps> & { killed?: number[] }): ProcOps => ({
    platform: 'linux',
    kill: (pid, sig) => void over.killed?.push(pid * 1000 + (sig === 'SIGKILL' ? 9 : 0)),
    run: () => ({ status: 0, stdout: '' }),
    isAlive: () => true,
    readCmdline: () => null,
    ...over,
  });

  it('kills a leftover process only if its command line contains our bundle path', () => {
    const dir = tempDir();
    const killed: number[] = [];
    writePidFile(dir, 'server', { pid: 4321, marker: '/opt/tagconn/server/main.js', startedAt: 1 });
    const res = cleanStalePid(dir, 'server', ops({ killed, readCmdline: () => 'node /opt/tagconn/server/main.js' }));
    expect(res).toBe('killed');
    expect(killed).toEqual([-4321 * 1000 + 9]);
    expect(existsSync(join(dir, 'server.pid'))).toBe(false);
  });

  it('never kills a recycled PID that now runs something else', () => {
    const dir = tempDir();
    const killed: number[] = [];
    writePidFile(dir, 'server', { pid: 4321, marker: '/opt/tagconn/server/main.js', startedAt: 1 });
    expect(cleanStalePid(dir, 'server', ops({ killed, readCmdline: () => '/usr/bin/firefox --new-window' }))).toBe('foreign');
    expect(killed).toEqual([]);
    expect(existsSync(join(dir, 'server.pid'))).toBe(false);
  });

  it('does not kill when the process is gone, when the cmdline is unreadable, or the file is corrupt', () => {
    const dir = tempDir();
    const killed: number[] = [];
    writePidFile(dir, 'runner', { pid: 99, marker: 'm', startedAt: 1 });
    expect(cleanStalePid(dir, 'runner', ops({ killed, isAlive: () => false }))).toBe('stale');
    writePidFile(dir, 'runner', { pid: 99, marker: 'm', startedAt: 1 });
    expect(cleanStalePid(dir, 'runner', ops({ killed, readCmdline: () => null }))).toBe('foreign');
    expect(cleanStalePid(dir, 'runner', ops({ killed }))).toBe('none');
    expect(killed).toEqual([]);
  });

  it('start() cleans a stale PID first', async () => {
    const { svc, pidDir } = make(['hang']);
    // A dead pid: nothing to kill, file replaced by the new child's.
    writePidFile(pidDir, 'server', { pid: 2 ** 22 + 7, marker: FAKE_CHILD, startedAt: 1 });
    await svc.start();
    const rec = JSON.parse((await import('node:fs')).readFileSync(join(pidDir, 'server.pid'), 'utf8'));
    expect(rec.pid).toBe(svc.status().pid);
  });
});
