// tagconn host runner daemon entry point (docs/design/runner-and-helpdesk.md §2).
// Usage: node apps/runner/src/main.ts --config <path to runner.json>
//   (dev: `pnpm --filter @tagconn/runner dev`; production: build then `node dist/main.js --config ...`)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { type RunEnd, type RunEventEnvelope, type RunnerCapabilities, type RunnerHello } from '@tagconn/shared';
import { assertRequiredCapabilities } from './argv.js';
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
import { buildRunEnv } from './env.js';
import { loadLedger } from './ledger.js';
import { createLogger } from './logger.js';
import { reapStaleQuestScopes } from './runProcess.js';
import { createRunManager } from './runManager.js';
import { connectRunner } from './socketClient.js';
import { defaultClaudeJsonPath } from './trust.js';
import { auditUserSettings } from './userSettingsAudit.js';
import { announceVerified, wireRunnerSocket } from './wireSocket.js';

const logger = createLogger();

async function probeCapabilities(claudePath: string, cwd: string, stateDir: string): Promise<{ caps: RunnerCapabilities; version: string }> {
  // L8: every probe turn actually spawns the real `claude` CLI (some print --help/--version, but
  // the mode/stdin/transcript-key probes send a real prompt). It must get the SAME env hygiene as a
  // real run — no ANTHROPIC_* passthrough (the whole point of "no API key") — not the runner's raw
  // process.env, which could carry an inherited ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL from its own
  // parent shell or systemd unit.
  const probeEnv = buildRunEnv({ runId: 'capability-probe', runKind: 'quest', passEnv: [] });
  const versionResult = realSpawn(claudePath, ['--version'], { cwd, env: probeEnv });
  const version = parseVersion(versionResult.stdout);
  if (versionResult.status !== 0) {
    // SC5 re-review: diagnostics for a probe that came back empty/false in the field (real-CLI QA) —
    // `claude --version` failing outright (bad claudePath, PATH not set up for this process, etc.)
    // silently poisons every downstream probe (they all spawn the SAME claudePath).
    logger.warn('capability probe: `claude --version` did not exit 0', { claudePath, cwd, status: versionResult.status, error: versionResult.error, stderr: versionResult.stderr.slice(0, 500) });
  }

  const cached = loadCachedCapabilities(stateDir, version);
  if (cached) return { caps: cached, version };

  const helpResult = realSpawn(claudePath, ['--help'], { cwd, env: probeEnv });
  if (helpResult.status !== 0 || !helpResult.stdout) {
    logger.warn('capability probe: `claude --help` produced no usable output — every help-derived capability flag will read false', {
      status: helpResult.status,
      error: helpResult.error,
      stderr: helpResult.stderr.slice(0, 500),
    });
  }
  const flags = parseHelpFlags(helpResult.stdout);

  const probeCwd = join(stateDir, 'probe');
  const acceptedModes = probePermissionModes(realSpawn, claudePath, probeCwd, probeEnv);
  if (acceptedModes.length === 0) {
    logger.warn('capability probe: no permission mode was accepted — every quest/Receptionist run will be refused (mode_not_allowed) until this is fixed', { claudePath, probeCwd });
  }
  const stdinPrompt = probeStdinPrompt(realSpawn, claudePath, probeCwd, probeEnv);
  if (!stdinPrompt) {
    logger.warn('capability probe: stdin prompt delivery was not confirmed — every run falls back to `-- <prompt>` on argv instead', { claudePath, probeCwd });
  }
  const systemdScope = probeSystemdScope(realSpawn);
  const bwrapBinaryPresent = bwrapAvailable(realSpawn);
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  const bwrap = bwrapBinaryPresent && verifyTranscriptKeyDerivation(realSpawn, claudePath, probeCwd, claudeProjectsDir, probeEnv);

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
  // L1: this log is informational only now — the REAL gate is assertRequiredCapabilities() called
  // per run inside runManager.startQuest/startReceptionist (it used to be dead code: this was the
  // only place it ran, and it never stopped a spawn).
  try {
    assertRequiredCapabilities(caps);
  } catch (err) {
    logger.error('capability_missing: every run will be refused until this claude CLI supports it', { error: err instanceof Error ? err.message : String(err) });
  }
  const claudeBinRealPath = resolveClaudePath(cfg.claudePath);

  // H2: advisory-only audit of the user's OWN ~/.claude/settings.json (still in effect on every run:
  // --setting-sources=user). Logged for the operator; office:doctor (scripts/) surfaces the same
  // check. `bareWebFetchAllowed` additionally makes the Receptionist drop WebFetch for a turn.
  const userSettingsRisk = auditUserSettings();
  if (userSettingsRisk.findings.length > 0) {
    logger.warn('~/.claude/settings.json carries permissive rules that also apply to quests and the Receptionist (--setting-sources=user)', {
      path: userSettingsRisk.path,
      findings: userSettingsRisk.findings,
    });
  }

  // L9: a previous runner process that crashed (rather than shutting down cleanly) can leave
  // transient quest scopes still running; a fresh process has no in-memory record of them.
  const reaped = reapStaleQuestScopes();
  if (reaped.length > 0) logger.warn('reaped stale quest scopes from a previous runner instance', { units: reaped });

  if (caps.bwrap) {
    const repoRoot = defaultRepoRoot();
    if (repoRoot) refreshReceptionistDocs(repoRoot, cfg.stateDir);
  }

  const ledgerPath = join(cfg.stateDir, 'session-ledger.json');
  const ledger = loadLedger(ledgerPath);
  const offlineQueue = createOfflineQueue(cfg.offlineBufferEvents, cfg.offlineBufferBytes);

  if (!cfg.runnerId) throw new ConfigError('runnerId missing after config load (should have been generated)');

  // H1: `connection.socket` is the SAME Socket object across every reconnect (socket.io-client
  // reuses it), and `connection.isVerified()` is true only between a successful handshake and the
  // next 'disconnect'. `wireRunnerSocket` registers 'run:start'/'run:stop'/'attribution:write' on it
  // EXACTLY ONCE (below), gated on that flag; `announceVerified` re-sends `runner:hello` and drains
  // the offline queue on every (re)verification, which is the only part that should re-run.
  const connection = connectRunner({
    url: cfg.url,
    token: cfg.token,
    runnerId: cfg.runnerId,
    onVerified: () => announceVerified(connection.socket, { runManager, offlineQueue, hello, logger }),
  });

  const hello: RunnerHello = {
    protocol: 1,
    runnerId: cfg.runnerId,
    version: process.env.npm_package_version ?? '0.3.0',
    hostname: process.env.HOSTNAME ?? 'unknown',
    platform: process.platform,
    claudeVersion: version,
    capabilities: caps,
    maxConcurrent: cfg.maxConcurrent,
    maxPermissionMode: cfg.maxPermissionMode,
    allowedProjectDirs: cfg.allowedProjectDirs,
    questMaxAllowedTools: cfg.questToolPolicy.maxAllowedTools,
    // L2: report what will ACTUALLY be used given receptionistSandbox, not just what was probed.
    receptionistSandbox: cfg.receptionistSandbox !== 'none' && caps.bwrap ? 'bwrap' : 'none',
    receptionistFlags: { restricted: caps.restricted, safeModeProjectScope: caps.safeMode },
    get activeRunIds() {
      return runManager.activeRunIds();
    },
  };

  const runManager = createRunManager({
    cfg,
    caps,
    ledger,
    ledgerPath,
    claudeJsonPath: defaultClaudeJsonPath(),
    claudeBinRealPath,
    logger,
    userSettingsRisk,
    // H1 (L5): route through the offline queue unless THIS process itself verified the connection
    // and it is still up. Never emit straight onto `connection.socket` just because `.connected` is
    // true — that flips true again on the transport level before our own re-handshake completes.
    emitEvent: (env: RunEventEnvelope) => {
      if (connection.isVerified() && connection.socket.connected) connection.socket.emit('run:event', env);
      else offlineQueue.pushEvent(env);
    },
    emitEnd: (end: RunEnd) => {
      if (connection.isVerified() && connection.socket.connected) connection.socket.emit('run:end', end);
      else offlineQueue.pushEnd(end);
    },
  });

  wireRunnerSocket(connection.socket, {
    runManager,
    offlineQueue,
    cfg,
    hello,
    logger,
    isVerified: connection.isVerified,
  });

  const shutdown = () => {
    logger.info('shutting down');
    for (const runId of runManager.activeRunIds()) runManager.stop({ runId, reason: 'runner_shutdown' });
    connection.socket.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('fatal', { err: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
