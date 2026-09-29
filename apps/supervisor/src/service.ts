import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ServiceId, ServiceState, ServiceStatus } from '@tagconn/shared';
import { RpcFailure } from './errors.ts';
import type { LogHub } from './logHub.ts';
import { cleanStalePid, killTree, realProcOps, removePidFile, writePidFile, type ProcOps } from './proc.ts';

/** What a service needs to launch, resolved fresh on every (re)start so a moved port or new token is picked up. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** The bundle path: recorded in the PID file and matched before a stale PID is killed. */
  marker: string;
}

export interface ServiceDefinition {
  id: ServiceId;
  /** Throws an RpcFailure (port_in_use, spawn_failed...) when the service cannot start. */
  prepare: () => Promise<LaunchSpec>;
  /** The bundle path this install expects its process to run (N7): stale PIDs are matched against it, never the PID file's own. */
  marker?: () => string;
  /** Polled for readiness and hangs. Without it the service counts as running once spawned. */
  healthUrl?: () => string;
  url?: () => string | undefined;
  /** The "next step" appended when it gives up after repeated crashes. */
  crashHint?: string;
}

export interface Timing {
  backoffBaseMs: number;
  backoffMaxMs: number;
  crashWindowMs: number;
  maxCrashes: number;
  /** SIGTERM, then a tree kill after this long. */
  stopTimeoutMs: number;
  healthIntervalMs: number;
  /** Poll interval while starting (fast, to notice readiness early). */
  startPollMs: number;
  healthMisses: number;
  healthTimeoutMs: number;
  /** A service that has never been healthy is only counted as hung after this long. */
  startGraceMs: number;
  /** `start()` rejects when the service is still not `running` after this long. */
  startTimeoutMs: number;
}

export const DEFAULT_TIMING: Timing = {
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  crashWindowMs: 120_000,
  maxCrashes: 5,
  stopTimeoutMs: 8_000,
  healthIntervalMs: 5_000,
  startPollMs: 500,
  healthMisses: 3,
  healthTimeoutMs: 2_000,
  startGraceMs: 30_000,
  startTimeoutMs: 30_000,
};

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type HealthFn = (url: string, timeoutMs: number) => Promise<boolean>;

export const defaultHealth: HealthFn = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
};

export interface ServiceDeps {
  logs: LogHub;
  pidDir: string;
  onChange: (status: ServiceStatus) => void;
  ops?: ProcOps;
  spawn?: SpawnFn;
  health?: HealthFn;
  timing?: Partial<Timing>;
  now?: () => number;
}

/** The surface the RPC handlers use; ManagedService (child processes) and DockerService both implement it. */
export interface ServiceController {
  readonly id: ServiceId;
  status(): ServiceStatus;
  start(): Promise<ServiceStatus>;
  stop(): Promise<ServiceStatus>;
  restart(): Promise<ServiceStatus>;
  /** Stops for good (supervisor shutdown). */
  dispose(): Promise<void>;
}

/**
 * One native child process (server or runner): spawn, restart with exponential backoff, give up after
 * `maxCrashes` in `crashWindowMs`, health-poll for hangs, graceful stop with a tree-kill fallback, and a PID
 * file so a supervisor that died hard doesn't leave orphans behind.
 */
export class ManagedService implements ServiceController {
  readonly id: ServiceId;
  private readonly def: ServiceDefinition;
  private readonly d: Required<Pick<ServiceDeps, 'logs' | 'pidDir' | 'onChange' | 'ops' | 'spawn' | 'health' | 'now'>>;
  private readonly t: Timing;

  private state: ServiceState = 'stopped';
  private since: number;
  private restarts = 0;
  private lastError: string | undefined;
  private child: ChildProcess | undefined;
  private pid: number | undefined;
  private startedAt = 0;
  private generation = 0;
  private crashes: number[] = [];
  private stopping = false;
  private killReason: string | undefined;
  private exited: Promise<void> = Promise.resolve();
  private resolveExited: () => void = () => {};
  private restartTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private forceTimer: NodeJS.Timeout | undefined;
  private lastStderr = '';
  private disposed = false;
  private lastSignal: NodeJS.Signals | null = null;
  private waiters = new Set<() => void>();

  constructor(def: ServiceDefinition, deps: ServiceDeps) {
    this.def = def;
    this.id = def.id;
    this.t = { ...DEFAULT_TIMING, ...deps.timing };
    this.d = {
      logs: deps.logs,
      pidDir: deps.pidDir,
      onChange: deps.onChange,
      ops: deps.ops ?? realProcOps(),
      spawn: deps.spawn ?? nodeSpawn,
      health: deps.health ?? defaultHealth,
      now: deps.now ?? Date.now,
    };
    this.since = this.d.now();
  }

  status(): ServiceStatus {
    const url = this.state === 'running' || this.state === 'starting' ? this.def.url?.() : undefined;
    return {
      id: this.id,
      state: this.state,
      ...(this.pid !== undefined && this.child ? { pid: this.pid } : {}),
      since: this.since,
      restarts: this.restarts,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(url ? { url } : {}),
    };
  }

  /** Kills a PID left behind by a previous supervisor. Safe to call at boot. */
  cleanStale(expectedMarker: string | undefined = this.def.marker?.()): void {
    // Without an expected marker nothing can be verified as ours: the file is just dropped, no process is killed.
    const res = cleanStalePid(this.d.pidDir, this.id, this.d.ops, expectedMarker ?? '\0');
    if (res === 'killed') this.log(`killed a stale ${this.id} process left by a previous run`);
    else if (res === 'foreign') this.log(`ignored a stale ${this.id} PID file: that PID now belongs to another program`);
  }

  async start(): Promise<ServiceStatus> {
    if (this.disposed) throw new RpcFailure('busy', 'The supervisor is shutting down.');
    if (this.state === 'stopping') await this.exited;
    if (this.state === 'running') return this.status();
    if (this.state === 'starting') {
      await this.untilRunning();
      return this.status();
    }
    this.restarts = 0;
    this.crashes = [];
    this.lastError = undefined;
    this.setState('starting');
    try {
      await this.launch();
    } catch (err) {
      this.lastError = err instanceof RpcFailure ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : (err as Error).message;
      this.setState('stopped');
      throw err;
    }
    await this.untilRunning();
    return this.status();
  }

  /**
   * Resolves once the service is `running` (first health OK when it has a health URL); rejects with a clear error
   * when it gives up (crashed), is stopped meanwhile, or is still not running after `startTimeoutMs`. Automatic
   * restarts in between (state `starting` again) keep waiting. On a timeout the service is left as it is.
   */
  private untilRunning(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new RpcFailure(
              'spawn_failed',
              `${this.id} did not become ready within ${Math.round(this.t.startTimeoutMs / 1000)} s.`,
              'It may still be starting: check the logs, then press Start again or pick another port in Settings.',
            ),
          ),
        );
      }, this.t.startTimeoutMs);
      const check = () => {
        if (this.state === 'running') finish(resolve);
        else if (this.state === 'crashed') finish(() => reject(new RpcFailure('spawn_failed', this.lastError ?? `${this.id} crashed.`)));
        else if (this.state === 'stopped' || this.state === 'stopping' || this.state === 'unavailable') {
          finish(() => reject(new RpcFailure('spawn_failed', this.lastError ?? `${this.id} was stopped before it became ready.`)));
        }
      };
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        fn();
      };
      this.waiters.add(check);
      check();
    });
  }

  async stop(): Promise<ServiceStatus> {
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.state === 'stopping') {
      await this.exited;
      return this.status();
    }
    if (!this.child) {
      if (this.state !== 'stopped') this.setState('stopped');
      return this.status();
    }
    this.stopping = true;
    this.setState('stopping');
    this.terminate();
    await this.exited;
    return this.status();
  }

  async restart(): Promise<ServiceStatus> {
    await this.stop();
    return this.start();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  // -------------------------------------------------------------------------------------------

  private setState(state: ServiceState): void {
    this.state = state;
    this.since = this.d.now();
    this.d.onChange(this.status());
    for (const w of [...this.waiters]) w();
  }

  private log(msg: string): void {
    this.d.logs.push('supervisor', 'supervisor', `[${this.id}] ${msg}`);
  }

  private async launch(): Promise<void> {
    const spec = await this.def.prepare();
    this.cleanStale(spec.marker);
    const gen = ++this.generation;
    this.stopping = false;
    this.killReason = undefined;
    this.lastStderr = '';
    this.lastSignal = null;
    this.exited = new Promise<void>((resolve) => (this.resolveExited = resolve));
    const win32 = this.d.ops.platform === 'win32';
    this.log(`starting: ${spec.command} ${spec.args.join(' ')}`);
    let child: ChildProcess;
    try {
      child = this.d.spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A POSIX process group so a tree kill reaches grandchildren; win32 uses taskkill /T instead.
        detached: !win32,
        windowsHide: true,
      });
    } catch (err) {
      this.resolveExited();
      throw new RpcFailure('spawn_failed', `Could not start ${this.id}: ${(err as Error).message}`, 'Reinstall the app if this keeps happening.');
    }
    this.child = child;
    this.pid = child.pid;
    this.startedAt = this.d.now();
    if (child.pid !== undefined) {
      const startTime = this.d.ops.startTime?.(child.pid) ?? undefined;
      writePidFile(this.d.pidDir, this.id, { pid: child.pid, marker: spec.marker, startedAt: this.startedAt, ...(startTime ? { startTime } : {}) });
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => this.d.logs.feed(this.id, 'stdout', c));
    child.stderr?.on('data', (c: string) => {
      this.lastStderr = c.trim().split(/\r?\n/).pop() ?? this.lastStderr;
      this.d.logs.feed(this.id, 'stderr', c);
    });
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (done) return;
      done = true;
      this.onExit(gen, code, signal, spawnError);
    };
    child.once('error', (err) => finish(null, null, err));
    child.once('exit', (code, signal) => finish(code, signal));
    if (this.def.healthUrl) {
      this.scheduleHealth(gen, 0, this.t.startPollMs);
    } else {
      this.setState('running');
    }
  }

  private onExit(gen: number, code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void {
    if (gen !== this.generation) return;
    clearTimeout(this.healthTimer);
    clearTimeout(this.forceTimer);
    this.d.logs.flush(this.id);
    // N7 (same as runner L6): the child has ended, so its pid may already belong to someone else. Never signal it.
    this.lastSignal = signal;
    removePidFile(this.d.pidDir, this.id);
    this.child = undefined;
    this.pid = undefined;
    const intentional = this.stopping && !this.killReason;
    const reason =
      this.killReason ??
      (spawnError
        ? `could not be started (${spawnError.message})`
        : signal
          ? `was killed by ${signal}`
          : `exited with code ${code}`) + (this.lastStderr ? `. Last error: ${this.lastStderr}` : '');
    this.resolveExited();
    if (intentional) {
      this.log('stopped');
      this.setState('stopped');
      return;
    }
    this.stopping = false;
    this.log(`${this.id} ${reason}`);
    this.recordCrash(reason);
  }

  /** A signal exit (not one we sent for a hang) is not a port or sqlite problem: say what it looks like instead. */
  private hint(): string {
    if (this.lastSignal && !this.killReason) {
      return `It was killed by a signal (${this.lastSignal}), possibly by you (a task manager, kill) or by the operating system's out-of-memory killer. Free some memory, then press Start.`;
    }
    return this.def.crashHint ?? 'Read the logs, fix the cause, then press Start. "Copy diagnostics" gathers everything for a bug report.';
  }

  private recordCrash(reason: string): void {
    const now = this.d.now();
    this.crashes = this.crashes.filter((c) => now - c < this.t.crashWindowMs);
    this.crashes.push(now);
    if (this.crashes.length >= this.t.maxCrashes) {
      this.lastError =
        `${this.id} ${reason}. It crashed ${this.crashes.length} times within ${Math.round(this.t.crashWindowMs / 1000)} s, so the supervisor gave up. ` +
        this.hint();
      this.log('giving up after repeated crashes');
      this.setState('crashed');
      return;
    }
    const delay = Math.min(this.t.backoffBaseMs * 2 ** (this.crashes.length - 1), this.t.backoffMaxMs);
    this.restarts++;
    this.lastError = `${this.id} ${reason}. Restarting in ${(delay / 1000).toFixed(delay < 1000 ? 1 : 0)} s (attempt ${this.restarts}).`;
    this.log(`restarting in ${delay} ms`);
    this.setState('starting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.disposed || this.state !== 'starting') return;
      this.launch().catch((err: Error) => {
        this.lastError = `${err.message}${err instanceof RpcFailure && err.hint ? ` ${err.hint}` : ''}`;
        this.log(`restart failed: ${err.message}`);
        this.recordCrash(`could not be restarted (${err.message})`);
      });
    }, delay);
  }

  private scheduleHealth(gen: number, misses: number, delay: number): void {
    this.healthTimer = setTimeout(() => void this.pollHealth(gen, misses), delay);
  }

  private async pollHealth(gen: number, misses: number): Promise<void> {
    const url = this.def.healthUrl?.();
    if (gen !== this.generation || !url) return;
    const ok = await this.d.health(url, this.t.healthTimeoutMs);
    if (gen !== this.generation || !this.child || this.stopping) return;
    if (ok) {
      if (this.state === 'starting') {
        this.lastError = undefined;
        this.setState('running');
      }
      this.scheduleHealth(gen, 0, this.t.healthIntervalMs);
      return;
    }
    const counting = this.state === 'running' || this.d.now() - this.startedAt > this.t.startGraceMs;
    const next = counting ? misses + 1 : misses;
    if (next >= this.t.healthMisses) {
      this.log(`${next} health checks in a row failed; restarting`);
      this.killReason = `stopped answering ${url} (${next} failed health checks)`;
      this.terminate();
      return;
    }
    this.scheduleHealth(gen, next, this.state === 'running' ? this.t.healthIntervalMs : this.t.startPollMs);
  }

  /** SIGTERM the tree, then kill it for good after `stopTimeoutMs` (win32: taskkill /T /F straight away). */
  private terminate(): void {
    const pid = this.pid;
    clearTimeout(this.healthTimer);
    if (pid === undefined) return;
    killTree(pid, 'SIGTERM', this.d.ops);
    clearTimeout(this.forceTimer);
    this.forceTimer = setTimeout(() => {
      this.log('did not stop in time; killing the process tree');
      killTree(pid, 'SIGKILL', this.d.ops);
    }, this.t.stopTimeoutMs);
  }
}
