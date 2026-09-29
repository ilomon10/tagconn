import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceId } from '@tagconn/shared';

/** Everything the process code needs from the OS, so tests can mock win32 and stale PIDs. */
export interface ProcOps {
  platform: NodeJS.Platform;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Runs a helper synchronously (taskkill, powershell, ps). Never throws. */
  run: (cmd: string, args: string[]) => { status: number | null; stdout: string };
  isAlive: (pid: number) => boolean;
  /** The command line of `pid`, or null when it is gone or unreadable. */
  readCmdline: (pid: number) => string | null;
}

export function realProcOps(): ProcOps {
  const platform = process.platform;
  const run: ProcOps['run'] = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false });
    return { status: r.status, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
  };
  return {
    platform,
    kill: (pid, signal) => void process.kill(pid, signal),
    run,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    readCmdline: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      if (platform === 'linux') {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null;
        } catch {
          return null;
        }
      }
      const r =
        platform === 'win32'
          ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`])
          : run('ps', ['-o', 'command=', '-p', String(pid)]);
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
  };
}

/** win32: `taskkill /PID <pid> /T /F` (whole tree, no graceful phase). Same argv as apps/runner/src/platform.ts. */
export function taskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

/**
 * Kills the process tree rooted at `pid`. win32 uses taskkill (the signal is ignored: a console child has no
 * graceful signal); POSIX signals the process group (children are spawned detached, so pgid == pid). Never throws.
 */
export function killTree(pid: number, signal: NodeJS.Signals, ops: ProcOps): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (ops.platform === 'win32') {
    ops.run('taskkill', taskkillArgs(pid));
    return;
  }
  try {
    ops.kill(-pid, signal);
  } catch {
    try {
      ops.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** True when a process command line is ours: it contains the exact bundle path we launched. */
export function cmdlineMatches(cmdline: string, marker: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? cmdline.toLowerCase().includes(marker.toLowerCase()) : cmdline.includes(marker);
}

// ---------------------------------------------------------------------------- PID files

export interface PidRecord {
  pid: number;
  /** The bundle path the process was launched with; the only thing a stale-PID kill is matched against. */
  marker: string;
  startedAt: number;
}

const pidPath = (dir: string, id: ServiceId): string => join(dir, `${id}.pid`);

export function writePidFile(dir: string, id: ServiceId, rec: PidRecord): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidPath(dir, id), JSON.stringify(rec) + '\n');
}

export function removePidFile(dir: string, id: ServiceId): void {
  rmSync(pidPath(dir, id), { force: true });
}

export function readPidFile(dir: string, id: ServiceId): PidRecord | null {
  const path = pidPath(dir, id);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PidRecord>;
    if (Number.isInteger(parsed.pid) && typeof parsed.marker === 'string') {
      return { pid: parsed.pid as number, marker: parsed.marker, startedAt: Number(parsed.startedAt) || 0 };
    }
  } catch {
    /* corrupt: treated as stale */
  }
  return null;
}

export type StaleResult = 'none' | 'stale' | 'killed' | 'foreign';

/**
 * Cleans a PID file left by a previous supervisor (crash, SIGKILL). The recorded process is killed ONLY if it
 * is still alive AND its command line contains the bundle path we recorded; a recycled PID that now belongs to
 * something else ('foreign') is never touched. The file is removed in every case.
 */
export function cleanStalePid(dir: string, id: ServiceId, ops: ProcOps): StaleResult {
  const path = pidPath(dir, id);
  if (!existsSync(path)) return 'none';
  const rec = readPidFile(dir, id);
  let result: StaleResult = 'stale';
  if (rec && rec.pid !== process.pid && ops.isAlive(rec.pid)) {
    const cmd = ops.readCmdline(rec.pid);
    if (cmd && cmdlineMatches(cmd, rec.marker, ops.platform)) {
      killTree(rec.pid, 'SIGKILL', ops);
      result = 'killed';
    } else {
      result = 'foreign';
    }
  }
  removePidFile(dir, id);
  return result;
}
