// tagconn host runner daemon entry point (docs/design/runner-and-helpdesk.md §2).
// Usage: node apps/runner/src/main.ts --config <path to runner.json>
//   (dev: `pnpm --filter @tagconn/runner dev`; production: build then `node dist/main.js --config ...`)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { type RunEnd, type RunEventEnvelope, type RunnerCapabilities, type RunnerHello } from '@tagconn/shared';
import { createOfflineQueue } from './buffer.js';
import {
  bwrapAvailable,
  loadCachedCapabilities,
  parseHelpFlags,
  parseVersion,
  probePermissionModes,
  probeStdinPrompt,
  probeSystemdScope,
  realSpawn,
  resolveClaudePath,
  saveCachedCapabilities,
  verifyTranscriptKeyDerivation,
} from './capabilities.js';
import { ConfigError, loadRunnerConfig, parseCliArgs } from './config.js';
import { defaultRepoRoot, refreshReceptionistDocs } from './docsCopy.js';
import { loadLedger } from './ledger.js';
import { createLogger } from './logger.js';
import { createRunManager } from './runManager.js';
import { connectRunner } from './socketClient.js';
import { defaultClaudeJsonPath } from './trust.js';
import { wireRunnerSocket } from './wireSocket.js';

const logger = createLogger();

async function probeCapabilities(claudePath: string, cwd: string, stateDir: string): Promise<{ caps: RunnerCapabilities; version: string }> {
  const versionResult = realSpawn(claudePath, ['--version'], { cwd, env: process.env });
  const version = parseVersion(versionResult.stdout);

  const cached = loadCachedCapabilities(stateDir, version);
  if (cached) return { caps: cached, version };

  const helpResult = realSpawn(claudePath, ['--help'], { cwd, env: process.env });
  const flags = parseHelpFlags(helpResult.stdout);

  const probeCwd = join(stateDir, 'probe');
  const acceptedModes = probePermissionModes(realSpawn, claudePath, probeCwd, process.env);
  const stdinPrompt = probeStdinPrompt(realSpawn, claudePath, probeCwd, process.env);
  const systemdScope = probeSystemdScope(realSpawn);
  const bwrapBinaryPresent = bwrapAvailable(realSpawn);
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  const bwrap = bwrapBinaryPresent && verifyTranscriptKeyDerivation(realSpawn, claudePath, probeCwd, claudeProjectsDir, process.env);

  const caps: RunnerCapabilities = {
    stdinPrompt,
    includePartialMessages: flags.includePartialMessages,
    settingSources: flags.settingSources,
    strictMcpConfig: flags.strictMcpConfig,
    tools: flags.tools,
    permissionPrompts: flags.permissionPrompts,
    disableSlashCommands: flags.disableSlashCommands,
    restricted: flags.restricted,
    safeMode: flags.safeMode,
    permissionModes: acceptedModes,
    bwrap,
    systemdScope,
  };
  saveCachedCapabilities(stateDir, version, caps);
  return { caps, version };
}

async function main(): Promise<void> {
  const { configPath } = parseCliArgs(process.argv.slice(2));
  const cfg = loadRunnerConfig(configPath);
  logger.info('runner config loaded', { configPath: cfg.configPath, stateDir: cfg.stateDir, allowedProjectDirs: cfg.allowedProjectDirs.length });

  const { caps, version } = await probeCapabilities(cfg.claudePath, cfg.stateDir, cfg.stateDir);
  if (!caps.settingSources || !caps.strictMcpConfig || !caps.permissionPrompts) {
    logger.error('capability_missing: refusing to spawn anything', { caps });
  }
  const claudeBinRealPath = resolveClaudePath(cfg.claudePath);

  if (caps.bwrap) {
    const repoRoot = defaultRepoRoot();
    if (repoRoot) refreshReceptionistDocs(repoRoot, cfg.stateDir);
  }

  const ledgerPath = join(cfg.stateDir, 'session-ledger.json');
  const ledger = loadLedger(ledgerPath);
  const offlineQueue = createOfflineQueue(cfg.offlineBufferEvents, cfg.offlineBufferBytes);

  let currentSocket: ReturnType<typeof connectRunner> | undefined;

  const runManager = createRunManager({
    cfg,
    caps,
    ledger,
    ledgerPath,
    claudeJsonPath: defaultClaudeJsonPath(),
    claudeBinRealPath,
    logger,
    emitEvent: (env: RunEventEnvelope) => {
      if (currentSocket?.connected) currentSocket.emit('run:event', env);
      else offlineQueue.push(env);
    },
    emitEnd: (end: RunEnd) => {
      currentSocket?.emit('run:end', end);
    },
  });

  if (!cfg.runnerId) throw new ConfigError('runnerId missing after config load (should have been generated)');

  const socket = connectRunner({
    url: cfg.url,
    token: cfg.token,
    runnerId: cfg.runnerId,
    onSocket: (sock) => {
      const hello: RunnerHello = {
        protocol: 1,
        runnerId: cfg.runnerId!,
        version: process.env.npm_package_version ?? '0.3.0',
        hostname: process.env.HOSTNAME ?? 'unknown',
        platform: process.platform,
        claudeVersion: version,
        capabilities: caps,
        maxConcurrent: cfg.maxConcurrent,
        maxPermissionMode: cfg.maxPermissionMode,
        allowedProjectDirs: cfg.allowedProjectDirs,
        questMaxAllowedTools: cfg.questToolPolicy.maxAllowedTools,
        receptionistSandbox: caps.bwrap ? 'bwrap' : 'none',
        receptionistFlags: { restricted: caps.restricted, safeModeProjectScope: caps.safeMode },
        activeRunIds: runManager.activeRunIds(),
      };
      wireRunnerSocket(sock, {
        runManager,
        offlineQueue,
        cfg,
        hello,
        logger,
        setCurrentSocket: (s) => {
          currentSocket = s;
        },
      });
    },
  });

  const shutdown = () => {
    logger.info('shutting down');
    for (const runId of runManager.activeRunIds()) runManager.stop({ runId, reason: 'runner_shutdown' });
    socket.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('fatal', { err: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
