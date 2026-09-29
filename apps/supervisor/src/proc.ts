import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceId } from '@tagconn/shared';
import { systemBin } from '@tagconn/setup';

type Env = Record<string, string | undefined>;

/** N1: `%SystemRoot%\System32\taskkill.exe`, never the bare name (a hostile cwd or PATH entry can't stand in). */
export const taskkillBin = (env: Env = process.env): string => systemBin(env, 'taskkill');

/** N1: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. */
export function powershellBin(env: Env = process.env): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** N1: the cwd for helper processes: never an inherited (possibly user-writable) one. */
export const helperCwd = (platform: NodeJS.Platform, env: Env = process.env): string =>
  platform === 'win32' ? env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows' : '/';

/** Everything the process code needs from the OS, so tests can mock win32 and stale PIDs. */
export interface ProcOps {
  platform: NodeJS.Platform;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** The environment used to locate system binaries (%SystemRoot%). Default: process.env. */
  env?: Env;
  /** Runs a helper synchronously (taskkill, powershell, ps). Never throws. */
  run: (cmd: string, args: string[]) => { status: number | null; stdout: string };
  isAlive: (pid: number) => boolean;
  /** The command line of `pid`, or null when it is gone or unreadable. */
  readCmdline: (pid: number) => string | null;
  /**
   * N7: an opaque, stable start time of `pid` (Linux: /proc/<pid>/stat field 22; win32: the process CreationDate
   * ticks; else `ps lstart`), or null when unreadable. Recorded in the PID file and compared before a stale kill,
   * so a recycled PID is never mistaken for the old process. Optional so tests can omit it (then nothing is recorded).
   */
  startTime?: (pid: number) => string | null;
}

/** Field 22 of /proc/<pid>/stat (starttime in clock ticks since boot); `comm` may contain spaces and parens. */
export function parseProcStatStartTime(stat: string): string | null {
  const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  const v = rest[19]; // fields 3.. start after `comm`; starttime is field 22
  return v && /^\d+$/.test(v) ? v : null;
}

export function realProcOps(env: Env = process.env): ProcOps {
  const platform = process.platform;
  const run: ProcOps['run'] = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false, cwd: helperCwd(platform, env) });
    return { status: r.status, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
  };
  /** Runs one PowerShell expression that takes the (integer) pid as its argument. */
  const psPid = (expr: string, pid: number): string | null => {
    const r = run(powershellBin(env), ['-NoProfile', '-NonInteractive', '-Command', `& { param([int]$p) ${expr} } ${pid}`]);
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  return {
    platform,
    env,
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
      if (platform === 'win32') return psPid("(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p)).CommandLine", pid);
      const r = run('/bin/ps', ['-o', 'command=', '-p', String(pid)]);
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    startTime: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      if (platform === 'linux') {
        try {
          return parseProcStatStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
        } catch {
          return null;
        }
      }
      if (platform === 'win32') {
        const out = psPid("(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p)).CreationDate.ToUniversalTime().Ticks", pid);
        return out && /^\d+$/.test(out) ? out : null;
      }
      const r = run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
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
    ops.run(taskkillBin(ops.env), taskkillArgs(pid));
    return;
  }
  try {
    ops.kill(-pid, signal);
  } catch {
    // N7: no fallback to a single-PID kill: if the group is gone, the pid may already belong to someone else.
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
  /** N7: `ProcOps.startTime` of the process right after the spawn; a stale kill requires it to match. */
  startTime?: string;
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
      return {
        pid: parsed.pid as number,
        marker: parsed.marker,
        startedAt: Number(parsed.startedAt) || 0,
        ...(typeof parsed.startTime === 'string' && parsed.startTime ? { startTime: parsed.startTime } : {}),
      };
    }
  } catch {
    /* corrupt: treated as stale */
  }
  return null;
}

export type StaleResult = 'none' | 'stale' | 'killed' | 'foreign';

/**
 * Cleans a PID file left by a previous supervisor (crash, SIGKILL). The recorded process is killed ONLY if it
 * is still alive AND (N7) its start time equals the recorded one AND its command line contains `expectedMarker`,
 * the bundle path the CURRENT bundle expects (never the marker the file itself claims: a tampered PID file must
 * not pick what gets killed). A process that fails any check ('foreign') is never touched. The file is removed
 * in every case.
 */
export function cleanStalePid(dir: string, id: ServiceId, ops: ProcOps, expectedMarker: string): StaleResult {
  const path = pidPath(dir, id);
  if (!existsSync(path)) return 'none';
  const rec = readPidFile(dir, id);
  let result: StaleResult = 'stale';
  if (rec && rec.pid !== process.pid && ops.isAlive(rec.pid)) {
    const cmd = ops.readCmdline(rec.pid);
    const started = rec.startTime !== undefined && ops.startTime?.(rec.pid) === rec.startTime;
    if (started && cmd && cmdlineMatches(cmd, expectedMarker, ops.platform)) {
      killTree(rec.pid, 'SIGKILL', ops);
      result = 'killed';
    } else {
      result = 'foreign';
    }
  }
  removePidFile(dir, id);
  return result;
}
