import {
  createContext,
  install,
  mintPairingCode,
  pairFailureHint,
  readRunnerToken,
  runSetupChecks,
  SecretFileError,
  SettingsParseError,
  SettingsRollbackError,
  uninstall,
  type CheckDeps,
  type SetupPaths,
} from '@tagconn/setup';
import {
  DESKTOP_RPC_VERSION,
  SERVICE_IDS,
  type AppInfo,
  type DesktopMethod,
  type DesktopResult,
  type DesktopNotificationMethod,
  type ServiceId,
  type ServiceStatus,
  DESKTOP_METHODS,
} from '@tagconn/shared';
import pkg from '../package.json' with { type: 'json' };
import { ConfigStore, officeUrl } from './config.ts';
import { DockerService, type DockerRun } from './docker.ts';
import { RpcFailure } from './errors.ts';
import { LogHub, type LogService } from './logHub.ts';
import { isSandboxedConfig, resolveBundle, resolvePaths, type Bundle, type Environment } from './paths.ts';
import type { ProcOps } from './proc.ts';
import { redact } from './redact.ts';
import { ManagedService, type HealthFn, type ServiceController, type SpawnFn, type Timing } from './service.ts';
import { dataDirOf, dockerEnv, runnerDefinition, serverDefinition, type DefinitionDeps } from './services.ts';

type ParamsOf<M extends DesktopMethod> = ReturnType<(typeof DESKTOP_METHODS)[M]['params']['parse']>;
export type Handlers = { [M in DesktopMethod]: (params: ParamsOf<M>) => Promise<DesktopResult<M>> | DesktopResult<M> };

export interface SupervisorOptions {
  env?: Environment;
  platform?: NodeJS.Platform;
  bundle?: Bundle;
  paths?: SetupPaths;
  /** Pushes a notification (service.changed / log.line) to the RPC peer. */
  notify?: <M extends DesktopNotificationMethod>(method: M, params: unknown) => void;
  timing?: Partial<Timing>;
  ops?: ProcOps;
  spawn?: SpawnFn;
  health?: HealthFn;
  dockerRun?: DockerRun;
  checkDeps?: CheckDeps;
  /** Logs for the supervisor itself go to stderr. */
  stderr?: (line: string) => void;
}

export interface Supervisor {
  handlers: Handlers;
  services: Record<ServiceId, ServiceController>;
  logs: LogHub;
  config: ConfigStore;
  /** Kills PIDs left behind by a previous supervisor. */
  cleanStale: () => void;
  /** Stops every service (stdin EOF, quit). */
  shutdown: () => Promise<void>;
}

export function createSupervisor(opts: SupervisorOptions = {}): Supervisor {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const paths = opts.paths ?? resolvePaths(env, platform);
  const bundle = opts.bundle ?? resolveBundle(env);
  const notify = opts.notify ?? (() => {});
  const stderr = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
  const version = env.TAGCONN_APP_VERSION || pkg.version;

  const logs = new LogHub((line) => {
    notify('log.line', line);
    if (line.service === 'supervisor') stderr(`[supervisor] ${line.line}`);
  });
  const supLog = (msg: string) => logs.push('supervisor', 'supervisor', msg);
  const config = new ConfigStore({ configDir: paths.config, env, platform, warn: supLog });
  const defDeps: DefinitionDeps = { env, paths, bundle, config, logs, checkDeps: opts.checkDeps };
  const onChange = (status: ServiceStatus) => notify('service.changed', status);
  const pidDir = `${paths.state}${platform === 'win32' ? '\\' : '/'}pids`;
  const shared = { logs, pidDir, onChange, ops: opts.ops, spawn: opts.spawn, health: opts.health, timing: opts.timing };

  const services: Record<ServiceId, ServiceController> = {
    server: new ManagedService(serverDefinition(defDeps), shared),
    runner: new ManagedService(runnerDefinition(defDeps), shared),
    docker: new DockerService({
      logs,
      onChange,
      run: opts.dockerRun,
      composeFile: () => bundle.composeFile,
      env: () => dockerEnv(defDeps, version),
      url: () => officeUrl(config.get().serverPort),
    }),
  };

  let setupBusy = false;
  /** install/uninstall rewrite the user's settings.json: never two at once. */
  async function exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    if (setupBusy) throw new RpcFailure('busy', 'Another setup step is still running.', 'Wait for it to finish.');
    setupBusy = true;
    try {
      return await fn();
    } finally {
      setupBusy = false;
    }
  }

  const setupContext = () =>
    createContext({
      log: (m) => supLog(m.trim()),
      warn: (m) => supLog(m.trim()),
      platform,
      env,
      resources: bundle.resources,
      changed: [],
    });

  function asInstallFailure(err: unknown): never {
    if (err instanceof RpcFailure) throw err;
    if (err instanceof SettingsRollbackError) {
      throw new RpcFailure('rolled_back', err.message, err.restored ? 'Nothing was changed. Fix the cause and try again.' : `Copy ${err.backup ?? 'the backup'} over ${err.path} by hand.`);
    }
    if (err instanceof SettingsParseError) {
      throw new RpcFailure('install_failed', err.message, 'tagconn will not touch this file until it is valid JSON. Fix it, then retry.');
    }
    if (err instanceof SecretFileError) {
      throw new RpcFailure('install_failed', err.message, err.hint);
    }
    throw new RpcFailure('install_failed', (err as Error).message, 'Read the log, fix the cause and retry.');
  }

  const serviceOf = (id: ServiceId): ServiceController => services[id];

  async function appInfo(): Promise<AppInfo> {
    return {
      rpcVersion: DESKTOP_RPC_VERSION,
      appVersion: version,
      nodeVersion: process.version,
      platform,
      arch: process.arch,
      paths: { config: paths.config, state: paths.state, data: dataDirOf({ config, paths }), claudeDir: paths.claudeDir },
    };
  }

  async function runChecks() {
    const cfg = config.get();
    return runSetupChecks(
      { claudeDir: paths.claudeDir, configDir: paths.config, dataDir: dataDirOf({ config, paths }), port: cfg.serverPort, dockerMode: cfg.runMode === 'docker' },
      opts.checkDeps,
    );
  }

  const handlers: Handlers = {
    'app.info': appInfo,
    'setup.check': runChecks,
    'setup.install': () =>
      exclusive(async () => {
        const cfg = config.get();
        const sandboxed = isSandboxedConfig(env, platform);
        try {
          return await install(
            {
              claudeDir: paths.claudeDir,
              configDir: paths.config,
              url: officeUrl(cfg.serverPort),
              urlExplicit: true,
              noAgents: false,
              noSkills: false,
              envFile: null,
              allowDirs: cfg.allowedProjectDirs,
              configDirExplicit: sandboxed,
              hook: 'node',
              nodePath: process.execPath,
              attribution: cfg.attributionReadme,
              isDefaultConfigDir: !sandboxed,
            },
            setupContext(),
          );
        } catch (err) {
          return asInstallFailure(err);
        }
      }),
    'setup.uninstall': () =>
      exclusive(async () => {
        try {
          return await uninstall({ claudeDir: paths.claudeDir, configDir: paths.config, noAgents: false, noSkills: false }, setupContext());
        } catch (err) {
          return asInstallFailure(err);
        }
      }),
    'config.get': () => config.get(),
    'config.set': (patch) => config.set(patch),
    'service.status': () => SERVICE_IDS.map((id) => serviceOf(id).status()),
    'service.start': ({ id }) => serviceOf(id).start(),
    'service.stop': ({ id }) => serviceOf(id).stop(),
    'service.restart': ({ id }) => serviceOf(id).restart(),
    'logs.tail': ({ service, lines }) => logs.tail(service, lines),
    'pair.mint': async () => {
      const server = services.server.status();
      const docker = services.docker.status();
      if (server.state !== 'running' && docker.state !== 'running') {
        throw new RpcFailure('not_running', 'The server is not running.', 'Start the server, then try again.');
      }
      const base = officeUrl(config.get().serverPort);
      try {
        const token = readRunnerToken(paths.config, { platform, env });
        logs.addSecret(token);
        // The server serves the web app itself, so the web origin is the server origin.
        const res = await mintPairingCode(base, base, token, false);
        if (res.squatterCheckPassed === false) {
          throw new Error('Refusing to reveal the pairing code: the server that answered is not the one that owns this URL.');
        }
        return { code: res.code, url: res.url, expiresAt: res.expiresAt };
      } catch (err) {
        const message = (err as Error).message;
        throw new RpcFailure('internal', message, pairFailureHint(message) ?? 'Install the hooks first (that creates the runner token), restart the server and retry.');
      }
    },
    'diagnostics.collect': async () => {
      const lines: string[] = [];
      lines.push('# tagconn diagnostics', JSON.stringify(await appInfo(), null, 2), '', '## config', JSON.stringify(config.get(), null, 2), '', '## setup checks');
      try {
        for (const c of await runChecks()) lines.push(`[${c.status}] ${c.title}: ${c.detail}`);
      } catch (err) {
        lines.push(`checks failed: ${(err as Error).message}`);
      }
      lines.push('', '## services');
      for (const id of SERVICE_IDS) lines.push(JSON.stringify(serviceOf(id).status()));
      for (const svc of [...SERVICE_IDS, 'supervisor'] as LogService[]) {
        lines.push('', `## log: ${svc} (last 200 lines)`);
        for (const l of logs.tail(svc, 200)) lines.push(`${new Date(l.ts).toISOString()} ${l.stream} ${l.line}`);
      }
      // Belt and braces: everything in the report passes the redaction once more.
      return { text: redact(lines.join('\n')) };
    },
  };

  return {
    handlers,
    services,
    logs,
    config,
    cleanStale: () => {
      for (const id of ['server', 'runner'] as const) (services[id] as ManagedService).cleanStale();
    },
    shutdown: async () => {
      await Promise.allSettled(SERVICE_IDS.map((id) => serviceOf(id).dispose()));
    },
  };
}
