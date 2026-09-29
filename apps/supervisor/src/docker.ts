import { spawn } from 'node:child_process';
import type { ServiceStatus, ServiceState } from '@tagconn/shared';
import { RpcFailure } from './errors.ts';
import type { LogHub } from './logHub.ts';
import type { ServiceController } from './service.ts';

export interface DockerRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs `docker <args>` and streams each output line to `onLine`. */
export type DockerRun = (args: string[], opts: { env: NodeJS.ProcessEnv; onLine: (stream: 'stdout' | 'stderr', line: string) => void; timeoutMs: number }) => Promise<DockerRunResult>;

export const realDockerRun: DockerRun = (args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: DockerRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn('docker', args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const timer = setTimeout(() => {
      child.kill();
      done({ status: null, stdout, stderr, error: new Error(`docker ${args[0]} timed out`) });
    }, opts.timeoutMs);
    const pump = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      for (const l of text.split(/\r?\n/)) if (l.trim()) opts.onLine(stream, l);
    };
    child.stdout.on('data', pump('stdout'));
    child.stderr.on('data', pump('stderr'));
    child.once('error', (error) => done({ status: null, stdout, stderr, error }));
    child.once('close', (status) => done({ status, stdout, stderr }));
  });

export interface DockerDeps {
  logs: LogHub;
  onChange: (status: ServiceStatus) => void;
  run?: DockerRun;
  composeFile: () => string;
  /** OFFICE_PORT, tokens, claude dir... for the compose file's `${...}` substitutions. */
  env: () => NodeJS.ProcessEnv;
  url?: () => string | undefined;
  now?: () => number;
  /** `up` may pull images, so it gets a long budget. */
  upTimeoutMs?: number;
}

/**
 * The optional Docker mode: `docker compose up -d` / `down` with the bundled compose file. `start` returns as
 * soon as the command is under way (state `starting`); the outcome arrives as a `service.changed` push.
 */
export class DockerService implements ServiceController {
  readonly id = 'docker' as const;
  private state: ServiceState = 'stopped';
  private since: number;
  private lastError: string | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly run: DockerRun;
  private readonly now: () => number;

  constructor(private readonly deps: DockerDeps) {
    this.run = deps.run ?? realDockerRun;
    this.now = deps.now ?? Date.now;
    this.since = this.now();
  }

  status(): ServiceStatus {
    const url = this.state === 'running' ? this.deps.url?.() : undefined;
    return { id: 'docker', state: this.state, since: this.since, restarts: 0, ...(this.lastError ? { lastError: this.lastError } : {}), ...(url ? { url } : {}) };
  }

  private setState(state: ServiceState, lastError?: string): void {
    this.state = state;
    this.lastError = lastError;
    this.since = this.now();
    this.deps.onChange(this.status());
  }

  private compose(args: string[], timeoutMs: number): Promise<DockerRunResult> {
    const env = { ...process.env, ...this.deps.env() };
    return this.run(['compose', '-p', 'tagconn', '-f', this.deps.composeFile(), ...args], {
      env,
      timeoutMs,
      onLine: (stream, line) => this.deps.logs.push('docker', stream, line),
    });
  }

  async start(): Promise<ServiceStatus> {
    if (this.state === 'starting' || this.state === 'running') return this.status();
    const info = await this.run(['info'], { env: process.env, timeoutMs: 15_000, onLine: () => {} });
    if (info.error || info.status !== 0) {
      const missing = (info.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      const message = missing ? 'Docker is not installed.' : 'Docker is installed but not running.';
      const hint = missing ? 'Install Docker, or switch to native mode in Settings.' : 'Start Docker Desktop (or the docker service), or switch to native mode in Settings.';
      this.setState('unavailable', `${message} ${hint}`);
      throw new RpcFailure('docker_unavailable', message, hint);
    }
    this.setState('starting');
    this.inFlight = this.compose(['up', '-d'], this.deps.upTimeoutMs ?? 15 * 60_000).then((r) => {
      if (this.state !== 'starting') return; // stopped meanwhile
      if (r.error || r.status !== 0) {
        const detail = r.error?.message ?? (r.stderr.trim().split(/\r?\n/).pop() || `docker compose exited with ${r.status}`);
        this.setState('crashed', `docker compose up failed: ${detail}. Read the Docker logs, then press Start.`);
      } else {
        this.setState('running');
      }
    });
    return this.status();
  }

  async stop(): Promise<ServiceStatus> {
    if (this.state === 'stopped' || this.state === 'unavailable') return this.status();
    await this.inFlight;
    this.setState('stopping');
    const r = await this.compose(['down'], 120_000);
    if (r.error || r.status !== 0) {
      this.setState('crashed', `docker compose down failed: ${r.error?.message ?? (r.stderr.trim().split(/\r?\n/).pop() || `exit ${r.status}`)}`);
    } else {
      this.setState('stopped');
    }
    return this.status();
  }

  async restart(): Promise<ServiceStatus> {
    await this.stop();
    return this.start();
  }

  /** Like the native children, quitting the app brings the stack down. */
  async dispose(): Promise<void> {
    await this.stop();
  }
}
