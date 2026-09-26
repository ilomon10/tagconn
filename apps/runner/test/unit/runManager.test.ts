// Direct unit tests for createRunManager (no socket/server involved), covering the SC5 fixes that
// live inside runManager.ts itself: L1 (assertRequiredCapabilities actually gates a spawn), L2
// (receptionistSandbox is honored), and M2 (the runner's own timeout, independent of the server).

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_QUEST_ALWAYS_DENY,
  DEFAULT_QUEST_MAX_ALLOWED_TOOLS,
  type RunEnd,
  type RunnerCapabilities,
  type RunStartCommand,
} from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLedger } from '../../src/ledger.js';
import { createLogger } from '../../src/logger.js';
import { createRunManager, type RunManagerDeps } from '../../src/runManager.js';
import { FAKE_CLAUDE_BIN_PATH, mkSandbox, rmSandbox } from '../helpers.js';

const FULL_CAPS: RunnerCapabilities = {
  stdinPrompt: true,
  includePartialMessages: true,
  settingSources: true,
  strictMcpConfig: true,
  tools: true,
  permissionPrompts: true,
  disableSlashCommands: true,
  restricted: true,
  safeMode: true,
  permissionModes: ['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
  bwrap: false,
  systemdScope: false,
};

function baseCfg(stateDir: string, overrides: Partial<RunManagerDeps['cfg']> = {}): RunManagerDeps['cfg'] {
  return {
    configPath: join(stateDir, 'runner.json'),
    url: 'http://127.0.0.1:0',
    token: 'a'.repeat(32),
    runnerId: randomUUID(),
    allowedProjectDirs: [stateDir],
    trustOverrideDirs: [stateDir],
    questToolPolicy: { maxAllowedTools: [...DEFAULT_QUEST_MAX_ALLOWED_TOOLS], alwaysDeny: [...DEFAULT_QUEST_ALWAYS_DENY] },
    maxConcurrent: 2,
    maxPermissionMode: 'acceptEdits',
    allowBypassPermissions: false,
    passEnv: ['FAKE_CLAUDE_SLEEP_MS'],
    claudePath: FAKE_CLAUDE_BIN_PATH,
    stateDir,
    receptionistSandbox: 'none',
    processIsolation: 'none',
    memoryMax: '4G',
    tasksMax: 512,
    maxLineBytes: 1024 * 1024,
    maxStderrLines: 200,
    killGraceMs: 500,
    offlineBufferEvents: 100,
    offlineBufferBytes: 1_000_000,
    sessionLedgerSize: 100,
    questTimeoutCapSec: 3_600,
    receptionistTimeoutCapSec: 300,
    ...overrides,
  };
}

function makeDeps(stateDir: string, overrides: { caps?: Partial<RunnerCapabilities>; cfg?: Partial<RunManagerDeps['cfg']> } = {}) {
  const ends: RunEnd[] = [];
  const deps: RunManagerDeps = {
    cfg: baseCfg(stateDir, overrides.cfg),
    caps: { ...FULL_CAPS, ...overrides.caps },
    ledger: loadLedger(join(stateDir, 'session-ledger.json')),
    ledgerPath: join(stateDir, 'session-ledger.json'),
    claudeJsonPath: join(stateDir, '.claude.json'),
    logger: createLogger('error'),
    emitEvent: () => {},
    emitEnd: (end) => ends.push(end),
  };
  return { deps, ends };
}

function baseQuestCmd(projectDir: string, overrides: Partial<RunStartCommand> = {}): RunStartCommand {
  return {
    runId: randomUUID(),
    kind: 'quest',
    projectDir,
    prompt: 'reply with the single word ok',
    permissionMode: 'acceptEdits',
    model: 'sonnet',
    allowedTools: ['Read'],
    disallowedTools: [],
    timeoutSec: 60,
    readOnly: false,
    addTagconnDocs: false,
    allowWebSearch: true,
    webFetchDomains: [],
    safeMode: false,
    partialMessages: true,
    limits: { maxEvents: 1000, maxEventBytes: 1_000_000, previewChars: 2000 },
    ...overrides,
  };
}

function baseReceptionistCmd(overrides: Partial<RunStartCommand> = {}): RunStartCommand {
  return {
    runId: randomUUID(),
    kind: 'receptionist',
    projectDir: null,
    prompt: 'what does this repo do?',
    permissionMode: 'plan',
    model: 'haiku',
    allowedTools: [],
    disallowedTools: [],
    timeoutSec: 60,
    readOnly: true,
    addTagconnDocs: false,
    allowWebSearch: false,
    webFetchDomains: [],
    safeMode: false,
    partialMessages: true,
    limits: { maxEvents: 1000, maxEventBytes: 1_000_000, previewChars: 2000 },
    ...overrides,
  };
}

/** A trusted project dir (§2.3 step 3: a real ~/.claude.json copy with hasTrustDialogAccepted). */
function trustedProject(stateDir: string): string {
  const project = join(stateDir, 'proj');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(stateDir, '.claude.json'), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
  return project;
}

describe('createRunManager', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
    delete process.env.FAKE_CLAUDE_SLEEP_MS;
  });

  // -------------------------------------------------------------------------------------------- L1

  describe('L1: assertRequiredCapabilities actually gates a spawn (it used to be dead code)', () => {
    it('startQuest refuses capability_missing when a required capability is false', () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const project = trustedProject(stateDir);
      const { deps, ends } = makeDeps(stateDir, { caps: { settingSources: false } });
      const runManager = createRunManager(deps);

      const result = runManager.startQuest(baseQuestCmd(project));
      expect(result).toEqual({ pid: null });
      expect(ends).toHaveLength(1);
      expect(ends[0]?.status).toBe('rejected');
      expect(ends[0]?.reason).toBe('capability_missing');
    });

    it('startQuest refuses capability_missing when `tools` is false (H2: quests need --tools too)', () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const project = trustedProject(stateDir);
      const { deps, ends } = makeDeps(stateDir, { caps: { tools: false } });
      const runManager = createRunManager(deps);

      runManager.startQuest(baseQuestCmd(project));
      expect(ends[0]?.reason).toBe('capability_missing');
    });

    it('startReceptionist refuses capability_missing when a required capability is false', () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const { deps, ends } = makeDeps(stateDir, { caps: { strictMcpConfig: false } });
      const runManager = createRunManager(deps);

      runManager.startReceptionist(baseReceptionistCmd(), { scope: 'general' });
      expect(ends[0]?.reason).toBe('capability_missing');
    });

    it('startReceptionist PROJECT scope additionally refuses capability_missing without --restricted', () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const project = trustedProject(stateDir);
      const { deps, ends } = makeDeps(stateDir, { caps: { restricted: false } });
      const runManager = createRunManager(deps);

      runManager.startReceptionist(baseReceptionistCmd({ projectDir: project }), { scope: 'project' });
      expect(ends[0]?.reason).toBe('capability_missing');
    });

    it('startReceptionist GENERAL scope does not require --restricted', () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const { deps, ends } = makeDeps(stateDir, { caps: { restricted: false } });
      const runManager = createRunManager(deps);

      const result = runManager.startReceptionist(baseReceptionistCmd(), { scope: 'general' });
      expect(typeof result.pid).toBe('number'); // spawned fine; not refused
      expect(ends.some((e) => e.reason === 'capability_missing')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------- L2

  describe('L2: receptionistSandbox is honored', () => {
    it("'bwrap' required: refuses (does not silently fall back) when bwrap was not probed", () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const { deps, ends } = makeDeps(stateDir, { cfg: { receptionistSandbox: 'bwrap' }, caps: { bwrap: false } });
      const runManager = createRunManager(deps);

      const result = runManager.startReceptionist(baseReceptionistCmd(), { scope: 'general' });
      expect(result).toEqual({ pid: null });
      expect(ends[0]?.reason).toBe('isolation_unavailable');
    });

    it("'bwrap' required: also refuses without a resolved claude binary path (needed for the --ro-bind)", () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const { deps, ends } = makeDeps(stateDir, { cfg: { receptionistSandbox: 'bwrap' }, caps: { bwrap: true } });
      const runManager = createRunManager({ ...deps, claudeBinRealPath: undefined });

      runManager.startReceptionist(baseReceptionistCmd(), { scope: 'general' });
      expect(ends[0]?.reason).toBe('isolation_unavailable');
    });

    it("'none': never refuses for lack of bwrap (it was never going to use it)", () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const { deps, ends } = makeDeps(stateDir, { cfg: { receptionistSandbox: 'none' }, caps: { bwrap: false } });
      const runManager = createRunManager(deps);

      const result = runManager.startReceptionist(baseReceptionistCmd(), { scope: 'general' });
      expect(typeof result.pid).toBe('number');
      expect(ends.some((e) => e.reason === 'isolation_unavailable')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------- M2

  describe('M2: the runner enforces its own timeout, independent of the server', () => {
    it('a quest past questTimeoutCapSec is stopped with status timeout / reason timeout, even with no run:stop', async () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const project = trustedProject(stateDir);
      const { deps, ends } = makeDeps(stateDir, { cfg: { questTimeoutCapSec: 1 } }); // 1s cap
      const runManager = createRunManager(deps);

      process.env.FAKE_CLAUDE_SLEEP_MS = '10000'; // the fake CLI would otherwise run far past the cap
      // cmd.timeoutSec (60) is way over the 1s local cap: the cap must win.
      const result = runManager.startQuest(baseQuestCmd(project, { timeoutSec: 60 }));
      expect(typeof result.pid).toBe('number');

      for (let i = 0; i < 50 && ends.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(ends).toHaveLength(1);
      expect(ends[0]?.status).toBe('timeout');
      expect(ends[0]?.reason).toBe('timeout');
    }, 10_000);

    it('does not fire the timeout timer once the run already ended normally', async () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const project = trustedProject(stateDir);
      const { deps, ends } = makeDeps(stateDir, { cfg: { questTimeoutCapSec: 2 } }); // longer than the fake CLI takes
      const runManager = createRunManager(deps);

      runManager.startQuest(baseQuestCmd(project, { timeoutSec: 60 }));
      for (let i = 0; i < 50 && ends.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(ends).toHaveLength(1);
      expect(ends[0]?.status).toBe('succeeded');

      // Wait past where the timeout timer WOULD have fired, and confirm no second (spurious) end.
      await new Promise((r) => setTimeout(r, 2_200));
      expect(ends).toHaveLength(1);
    }, 10_000);
  });

  // -------------------------------------------------------------------------------------------- L6

  describe('L6: a run killed for policy_violation never gets a resumable ledger session', () => {
    it('a receptionist init reporting a non-empty mcpServers is killed, and its session id is NOT recorded', async () => {
      const stateDir = mkSandbox();
      sandboxes.push(stateDir);
      const sessionId = `fake-l6-${randomUUID()}`;
      // Receptionist runs always get passEnv:[] (runManager.ts hardcodes it), so this fixture is
      // signaled via the PROMPT instead (stdin always reaches it, unlike env) — see fake-claude.mjs.
      const prompt = `__FAKE_SESSION_ID__:${sessionId} __FAKE_MCP_SERVERS__:evil-mcp what does this repo do?`;
      const { deps, ends } = makeDeps(stateDir);
      const runManager = createRunManager(deps);

      runManager.startReceptionist(baseReceptionistCmd({ prompt }), { scope: 'general' });
      for (let i = 0; i < 50 && ends.length === 0; i++) await new Promise((r) => setTimeout(r, 50));

      expect(ends).toHaveLength(1);
      expect(ends[0]?.reason).toBe('policy_violation');
      expect(deps.ledger.has(sessionId)).toBe(false);
    }, 10_000);
  });
});
