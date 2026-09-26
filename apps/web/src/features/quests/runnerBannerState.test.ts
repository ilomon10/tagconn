import { describe, expect, it } from 'vitest';
import type { RunnerCapabilities, RunnerStatus } from '@tagconn/shared';
import { runnerBannerState } from './runnerBannerState';

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

describe('runnerBannerState', () => {
  it('is disabled when the runner is off in settings, even with a healthy status', () => {
    expect(runnerBannerState({ demo: false, enabled: false, status: status() })).toEqual({ kind: 'disabled' });
  });

  it('demo mode is never "disabled", regardless of the enabled flag', () => {
    expect(runnerBannerState({ demo: true, enabled: false, status: null })).not.toEqual({ kind: 'disabled' });
  });

  it('is offline with no status at all', () => {
    expect(runnerBannerState({ demo: false, enabled: true, status: null })).toEqual({ kind: 'offline' });
  });

  it('is offline when connected is false', () => {
    expect(runnerBannerState({ demo: false, enabled: true, status: status({ connected: false }) })).toEqual({ kind: 'offline' });
  });

  it('is offline when connected but not yet verified', () => {
    expect(runnerBannerState({ demo: false, enabled: true, status: status({ verified: false }) })).toEqual({ kind: 'offline' });
  });

  it('offline outranks a missing capability (checked first)', () => {
    expect(
      runnerBannerState({ demo: false, enabled: true, status: status({ connected: false, capabilities: { ...CAPS, settingSources: false } }) }),
    ).toEqual({ kind: 'offline' });
  });

  it('flags a missing required capability once connected and verified', () => {
    expect(runnerBannerState({ demo: false, enabled: true, status: status({ capabilities: { ...CAPS, settingSources: false } }) })).toEqual({
      kind: 'capability_missing',
    });
    expect(runnerBannerState({ demo: false, enabled: true, status: status({ capabilities: { ...CAPS, strictMcpConfig: false } }) })).toEqual({
      kind: 'capability_missing',
    });
    expect(runnerBannerState({ demo: false, enabled: true, status: status({ capabilities: { ...CAPS, permissionPrompts: false } }) })).toEqual({
      kind: 'capability_missing',
    });
  });

  it('is ok with the connection counters when every required capability is present', () => {
    expect(runnerBannerState({ demo: false, enabled: true, status: status({ activeRuns: 1, queuedRuns: 2, maxConcurrent: 3 }) })).toEqual({
      kind: 'ok',
      activeRuns: 1,
      queuedRuns: 2,
      maxConcurrent: 3,
      noSystemdScope: false,
    });
  });

  it('flags a missing systemd scope inside the ok state rather than blocking it', () => {
    expect(runnerBannerState({ demo: false, enabled: true, status: status({ capabilities: { ...CAPS, systemdScope: false } }) })).toEqual({
      kind: 'ok',
      activeRuns: 0,
      queuedRuns: 0,
      maxConcurrent: 2,
      noSystemdScope: true,
    });
  });

  it('is ok with no capabilities reported at all (older runner)', () => {
    expect(runnerBannerState({ demo: false, enabled: true, status: status({ capabilities: undefined }) })).toEqual({
      kind: 'ok',
      activeRuns: 0,
      queuedRuns: 0,
      maxConcurrent: 2,
      noSystemdScope: false,
    });
  });
});
