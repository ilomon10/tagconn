import { describe, expect, it } from 'vitest';
import type { RunnerStatus } from '@tagconn/shared';
import { isProjectDirAllowed, questModeOptions } from './modes';

const status = (over: Partial<RunnerStatus> = {}): RunnerStatus => ({
  connected: true,
  verified: true,
  maxConcurrent: 2,
  maxPermissionMode: 'acceptEdits',
  activeRuns: 0,
  queuedRuns: 0,
  allowedProjectDirs: [],
  questMaxAllowedTools: [],
  capabilities: {
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
    bwrap: true,
    systemdScope: true,
  },
  ...over,
});

describe('questModeOptions', () => {
  it('offers every settings-allowed mode when no runner status is known yet', () => {
    const opts = questModeOptions(['plan', 'acceptEdits'], null);
    expect(opts).toEqual([
      { mode: 'plan', label: expect.any(String), allowed: true },
      { mode: 'acceptEdits', label: expect.any(String), allowed: true },
    ]);
  });

  it('disables a mode above the runner-reported maxPermissionMode', () => {
    const opts = questModeOptions(['plan', 'acceptEdits', 'auto'], status({ maxPermissionMode: 'acceptEdits' }));
    expect(opts.find((o) => o.mode === 'auto')).toMatchObject({ allowed: false });
    expect(opts.find((o) => o.mode === 'auto')?.reason).toMatch(/mode cap/);
    expect(opts.find((o) => o.mode === 'acceptEdits')).toMatchObject({ allowed: true });
  });

  it('disables auto/bypassPermissions without a systemd scope, even under the mode cap', () => {
    const opts = questModeOptions(['acceptEdits', 'auto', 'bypassPermissions'], status({ maxPermissionMode: 'bypassPermissions', capabilities: { ...status().capabilities!, systemdScope: false } }));
    expect(opts.find((o) => o.mode === 'acceptEdits')).toMatchObject({ allowed: true });
    expect(opts.find((o) => o.mode === 'auto')).toMatchObject({ allowed: false });
    expect(opts.find((o) => o.mode === 'bypassPermissions')).toMatchObject({ allowed: false });
  });

  it('disables a mode the CLI probe never accepted', () => {
    const opts = questModeOptions(['plan', 'dontAsk'], status({ capabilities: { ...status().capabilities!, permissionModes: ['plan'] } }));
    expect(opts.find((o) => o.mode === 'plan')).toMatchObject({ allowed: true });
    expect(opts.find((o) => o.mode === 'dontAsk')).toMatchObject({ allowed: false });
  });
});

describe('isProjectDirAllowed', () => {
  it('matches an exact dir and a subdirectory, not a sibling with a shared prefix', () => {
    expect(isProjectDirAllowed('/home/user/projects/tagconn', ['/home/user/projects'])).toBe(true);
    expect(isProjectDirAllowed('/home/user/projects', ['/home/user/projects'])).toBe(true);
    expect(isProjectDirAllowed('/home/user/projects-other', ['/home/user/projects'])).toBe(false);
  });
});
