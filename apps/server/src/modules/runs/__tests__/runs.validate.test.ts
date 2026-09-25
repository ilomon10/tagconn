import type { Settings } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../../core/http/index.js';
import { assertNoBareWebFetch, assertPromptWithinLimit, buildQuestAllowedTools, buildQuestDisallowedTools, resolvePermissionMode } from '../runs.validate.js';

function runnerCfg(overrides: Partial<Settings['runner']> = {}): Settings['runner'] {
  return {
    enabled: true,
    maxConcurrent: 2,
    defaultModel: 'sonnet',
    permissionMode: 'acceptEdits',
    allowedProjectDirs: [],
    token: 'a'.repeat(32),
    allowedPermissionModes: ['plan', 'dontAsk', 'default', 'acceptEdits'],
    allowedTools: ['Read', 'Grep'],
    disallowedTools: [],
    maxQueued: 20,
    maxPromptChars: 20_000,
    runTimeoutSec: 3_600,
    maxEventsPerRun: 5_000,
    maxEventBytesPerRun: 4 * 1024 * 1024,
    previewChars: 2_000,
    partialMessages: true,
    runRetentionDays: 30,
    lostGraceSec: 30,
    ...overrides,
  };
}

describe('runs.validate (pure, unit-tested independently of settings schema)', () => {
  it('assertPromptWithinLimit throws over the cap, passes at/under it', () => {
    expect(() => assertPromptWithinLimit('hi', 10)).not.toThrow();
    expect(() => assertPromptWithinLimit('x'.repeat(11), 10)).toThrow(HttpError);
  });

  it('resolvePermissionMode falls back to runner.permissionMode and rejects a mode outside allowedPermissionModes', () => {
    const cfg = runnerCfg({ permissionMode: 'acceptEdits', allowedPermissionModes: ['plan', 'acceptEdits'] });
    expect(resolvePermissionMode(undefined, cfg)).toBe('acceptEdits');
    expect(resolvePermissionMode('plan', cfg)).toBe('plan');
    expect(() => resolvePermissionMode('bypassPermissions', cfg)).toThrow(/mode_not_allowed/);
  });

  it('rejects a bare "WebFetch" allow rule but accepts a scoped one (V11)', () => {
    expect(() => assertNoBareWebFetch(['Read', 'WebFetch(domain:example.com)'])).not.toThrow();
    expect(() => assertNoBareWebFetch(['WebFetch'])).toThrow(/tool_not_allowed/);
    expect(() => assertNoBareWebFetch(['WebFetch()'])).toThrow(/tool_not_allowed/);
  });

  it('buildQuestAllowedTools rejects bare WebFetch even if it slipped past the settings schema', () => {
    // Bypasses SettingsSchema's own refine (which already blocks this at the API layer): this is the
    // SECOND, independent server-side check the design calls for (T6 defense in depth).
    const cfg = runnerCfg({ allowedTools: ['Read', 'WebFetch'] });
    expect(() => buildQuestAllowedTools(cfg)).toThrow(/tool_not_allowed/);
  });

  it('buildQuestDisallowedTools appends the loopback WebFetch backstop and dedupes', () => {
    const cfg = runnerCfg({ disallowedTools: ['WebFetch(domain:127.0.0.1)', 'Bash'] });
    const disallowed = buildQuestDisallowedTools(cfg);
    expect(disallowed).toContain('Bash');
    expect(disallowed).toContain('WebFetch(domain:localhost)');
    expect(disallowed.filter((t) => t === 'WebFetch(domain:127.0.0.1)')).toHaveLength(1);
  });
});
