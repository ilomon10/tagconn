import { describe, expect, it } from 'vitest';
import type { RunnerCapabilities, RunnerStatus } from '@tagconn/shared';
import { receptionistPanelGate, receptionistSendGate } from './gate';

describe('receptionistPanelGate', () => {
  it('is loading before settings arrive, before anything else is checked', () => {
    expect(receptionistPanelGate({ settingsLoaded: false, allowed: false, receptionistEnabled: false })).toBe('loading');
  });

  it('is disabled when the Receptionist is off in settings', () => {
    expect(receptionistPanelGate({ settingsLoaded: true, allowed: true, receptionistEnabled: false })).toBe('disabled');
  });

  it('disabled outranks not_paired (checked first)', () => {
    expect(receptionistPanelGate({ settingsLoaded: true, allowed: false, receptionistEnabled: false })).toBe('disabled');
  });

  it('is not_paired when enabled but this browser is unpaired', () => {
    expect(receptionistPanelGate({ settingsLoaded: true, allowed: false, receptionistEnabled: true })).toBe('not_paired');
  });

  it('is ready once settings are loaded, enabled, and this browser is allowed', () => {
    expect(receptionistPanelGate({ settingsLoaded: true, allowed: true, receptionistEnabled: true })).toBe('ready');
  });
});

const CAPS: RunnerCapabilities = {
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
  bwrap: true,
  systemdScope: true,
};

const status = (patch: Partial<RunnerStatus> = {}): RunnerStatus => ({
  connected: true,
  verified: true,
  maxConcurrent: 2,
  activeRuns: 0,
  queuedRuns: 0,
  allowedProjectDirs: [],
  questMaxAllowedTools: [],
  capabilities: CAPS,
  ...patch,
});

describe('receptionistSendGate', () => {
  it('is not_paired first, even in demo or with everything else fine', () => {
    expect(receptionistSendGate({ demo: true, allowed: false, receptionistEnabled: true, runnerStatus: status() })).toBe('not_paired');
  });

  it('is disabled when the Receptionist is off in settings', () => {
    expect(receptionistSendGate({ demo: false, allowed: true, receptionistEnabled: false, runnerStatus: status() })).toBe('disabled');
  });

  it('demo mode is always ready once paired and enabled, regardless of runner status', () => {
    expect(receptionistSendGate({ demo: true, allowed: true, receptionistEnabled: true, runnerStatus: null })).toBe('ready');
    expect(receptionistSendGate({ demo: true, allowed: true, receptionistEnabled: true, runnerStatus: status({ connected: false }) })).toBe('ready');
  });

  it('treats an unfetched runner status (null) as unknown, not offline', () => {
    expect(receptionistSendGate({ demo: false, allowed: true, receptionistEnabled: true, runnerStatus: null })).toBe('ready');
  });

  it('is runner_offline once the status confirms the runner is disconnected', () => {
    expect(receptionistSendGate({ demo: false, allowed: true, receptionistEnabled: true, runnerStatus: status({ connected: false }) })).toBe(
      'runner_offline',
    );
  });

  it('is capability_missing when connected but a required capability is off', () => {
    expect(
      receptionistSendGate({ demo: false, allowed: true, receptionistEnabled: true, runnerStatus: status({ capabilities: { ...CAPS, tools: false } }) }),
    ).toBe('capability_missing');
  });

  it('is ready when connected with every required capability', () => {
    expect(receptionistSendGate({ demo: false, allowed: true, receptionistEnabled: true, runnerStatus: status() })).toBe('ready');
  });

  it('is ready with no capabilities reported at all (older runner)', () => {
    expect(
      receptionistSendGate({ demo: false, allowed: true, receptionistEnabled: true, runnerStatus: status({ capabilities: undefined }) }),
    ).toBe('ready');
  });
});

describe('receptionistPanelGate while the auth status is loading', () => {
  it('shows loading (not "pair") for a not-yet-admin browser until auth answers', () => {
    expect(receptionistPanelGate({ settingsLoaded: true, allowed: false, receptionistEnabled: true, authLoaded: false })).toBe('loading');
    expect(receptionistPanelGate({ settingsLoaded: true, allowed: false, receptionistEnabled: true, authLoaded: true })).toBe('not_paired');
    expect(receptionistPanelGate({ settingsLoaded: true, allowed: true, receptionistEnabled: true, authLoaded: false })).toBe('ready');
  });
});
