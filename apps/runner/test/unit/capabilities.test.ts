import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guessTranscriptKey } from '../../src/bwrap.js';
import {
  bwrapAvailable,
  capabilitiesCachePath,
  loadCachedCapabilities,
  parseHelpFlags,
  parseVersion,
  probePermissionModes,
  probeStdinPrompt,
  probeSystemdScope,
  resolveClaudePath,
  saveCachedCapabilities,
  verifyTranscriptKeyDerivation,
} from '../../src/capabilities.js';
import type { RunnerCapabilities } from '@tagconn/shared';
import { fakeClaudeSpawn, mkSandbox, rmSandbox, FAKE_CLAUDE_PATH } from '../helpers.js';

describe('parseHelpFlags / parseVersion', () => {
  it('detects every flag the runner requires from --help text', () => {
    const helpText = ['--tools', '--restricted', '--safe-mode', '--permission-prompts', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '--include-partial-messages'].join(
      '\n',
    );
    const flags = parseHelpFlags(helpText);
    expect(Object.values(flags).every(Boolean)).toBe(true);
  });

  it('reports a missing flag as false', () => {
    expect(parseHelpFlags('--tools\n--restricted').settingSources).toBe(false);
  });

  it('parses a semver-ish version string out of noisy --version output', () => {
    expect(parseVersion('2.1.282 (Claude Code)')).toBe('2.1.282');
  });
});

describe('probePermissionModes (via the fake CLI)', () => {
  it('accepts every mode the fake CLI does not reject', () => {
    const modes = probePermissionModes(fakeClaudeSpawn, FAKE_CLAUDE_PATH, '/tmp', { ...process.env });
    expect(modes.length).toBeGreaterThan(0);
  });

  it('excludes a mode the CLI rejects (FAKE_CLAUDE_REJECT_MODES)', () => {
    const modes = probePermissionModes(fakeClaudeSpawn, FAKE_CLAUDE_PATH, '/tmp', { ...process.env, FAKE_CLAUDE_REJECT_MODES: 'bypassPermissions' }, ['plan', 'bypassPermissions']);
    expect(modes).toEqual(['plan']);
  });

  it('SC5 re-review (HIGH, real-CLI QA): still works when `cwd` does not exist yet (a brand-new runner\'s first boot)', () => {
    // node:child_process silently fails a nonexistent cwd (status: null, no thrown error) — this used
    // to make EVERY mode read as "not accepted" the first time a fresh runner probed (the dir was only
    // ever created as a side effect of the LATER verifyTranscriptKeyDerivation call). Deliberately NOT
    // pre-created here (mkSandbox() only creates its own root, not this nested path).
    const sandbox = mkSandbox();
    try {
      const freshCwd = join(sandbox, 'probe'); // does not exist yet
      const modes = probePermissionModes(fakeClaudeSpawn, FAKE_CLAUDE_PATH, freshCwd, { ...process.env });
      expect(modes.length).toBeGreaterThan(0);
    } finally {
      rmSandbox(sandbox);
    }
  });
});

describe('probeStdinPrompt (V9)', () => {
  it('is true when a flag-looking stdin prompt does not change init.permissionMode', () => {
    expect(probeStdinPrompt(fakeClaudeSpawn, FAKE_CLAUDE_PATH, '/tmp', { ...process.env })).toBe(true);
  });

  it('SC5 re-review (HIGH, real-CLI QA): still works when `cwd` does not exist yet (a brand-new runner\'s first boot)', () => {
    const sandbox = mkSandbox();
    try {
      const freshCwd = join(sandbox, 'probe'); // does not exist yet
      expect(probeStdinPrompt(fakeClaudeSpawn, FAKE_CLAUDE_PATH, freshCwd, { ...process.env })).toBe(true);
    } finally {
      rmSandbox(sandbox);
    }
  });
});

describe('probeSystemdScope / bwrapAvailable (real system binaries)', () => {
  it('detects systemd-run --user --scope availability on this host', () => {
    // This runs the REAL systemd-run (not the fake CLI); the dev/CI box either has it or doesn't.
    expect(typeof probeSystemdScope()).toBe('boolean');
  });

  it('detects bwrap availability on this host', () => {
    expect(typeof bwrapAvailable()).toBe('boolean');
  });
});

describe('resolveClaudePath', () => {
  it('resolves an absolute path via realpath', () => {
    expect(resolveClaudePath(FAKE_CLAUDE_PATH)).toBe(FAKE_CLAUDE_PATH);
  });

  it('returns undefined for a name not on PATH', () => {
    expect(resolveClaudePath('definitely-not-a-real-binary-xyz')).toBeUndefined();
  });
});

describe('verifyTranscriptKeyDerivation', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('is true when the fake CLI creates the transcript dir the guessed key predicts', () => {
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const probeCwd = join(stateDir, 'probe');
    const projectsDir = join(stateDir, 'claude-projects');
    const env = { ...process.env, FAKE_CLAUDE_TRANSCRIPT_MODE: 'correct', FAKE_CLAUDE_PROJECTS_DIR: projectsDir };
    expect(verifyTranscriptKeyDerivation(fakeClaudeSpawn, FAKE_CLAUDE_PATH, probeCwd, projectsDir, env)).toBe(true);
  });

  it('is false when the CLI derives a different directory name than guessed (falls back to sandbox=none)', () => {
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const probeCwd = join(stateDir, 'probe');
    const projectsDir = join(stateDir, 'claude-projects');
    const env = { ...process.env, FAKE_CLAUDE_TRANSCRIPT_MODE: 'wrong', FAKE_CLAUDE_PROJECTS_DIR: projectsDir };
    expect(verifyTranscriptKeyDerivation(fakeClaudeSpawn, FAKE_CLAUDE_PATH, probeCwd, projectsDir, env)).toBe(false);
  });

  it('QA10 (HIGH): is still true after earlier probes already created a transcript dir for the same probe cwd', () => {
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const probeCwd = join(stateDir, 'probe');
    const projectsDir = join(stateDir, 'claude-projects');
    const env = { ...process.env, FAKE_CLAUDE_TRANSCRIPT_MODE: 'correct', FAKE_CLAUDE_PROJECTS_DIR: projectsDir };
    // Simulates probePermissionModes/probeStdinPrompt (or a previous boot) running in probeCwd first.
    mkdirSync(join(projectsDir, guessTranscriptKey(probeCwd)), { recursive: true });
    expect(verifyTranscriptKeyDerivation(fakeClaudeSpawn, FAKE_CLAUDE_PATH, probeCwd, projectsDir, env)).toBe(true);
    expect(verifyTranscriptKeyDerivation(fakeClaudeSpawn, FAKE_CLAUDE_PATH, probeCwd, projectsDir, env)).toBe(true);
  });

  it('is false when the CLI creates nothing at all', () => {
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const probeCwd = join(stateDir, 'probe');
    const projectsDir = join(stateDir, 'claude-projects');
    const env = { ...process.env, FAKE_CLAUDE_TRANSCRIPT_MODE: 'none' };
    expect(verifyTranscriptKeyDerivation(fakeClaudeSpawn, FAKE_CLAUDE_PATH, probeCwd, projectsDir, env)).toBe(false);
  });
});

describe('capabilities cache', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('round-trips through capabilitiesCachePath / save / load', () => {
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    expect(loadCachedCapabilities(stateDir, '2.1.282')).toBeUndefined();
    const caps: RunnerCapabilities = {
      stdinPrompt: true,
      includePartialMessages: true,
      settingSources: true,
      strictMcpConfig: true,
      tools: true,
      permissionPrompts: true,
      disableSlashCommands: true,
      restricted: true,
      safeMode: true,
      permissionModes: ['plan'],
      bwrap: false,
      systemdScope: false,
    };
    saveCachedCapabilities(stateDir, '2.1.282', caps);
    expect(loadCachedCapabilities(stateDir, '2.1.282')).toEqual(caps);
  });

  it('sanitizes the version string in the cache filename', () => {
    expect(capabilitiesCachePath('/state', '2.1.282 (beta)')).toBe('/state/capabilities-v2-2.1.282__beta_.json');
  });
});
