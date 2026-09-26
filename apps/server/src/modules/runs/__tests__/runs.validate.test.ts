import { isValidWebFetchAllowRule, type Settings } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../../core/http/index.js';
import {
  assertNoBareWebFetch,
  assertProjectDirAllowed,
  assertPromptWithinLimit,
  buildQuestAllowedTools,
  buildQuestDisallowedTools,
  buildReceptionistDisallowedTools,
  resolvePermissionMode,
} from '../runs.validate.js';

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

function receptionistCfg(overrides: Partial<Settings['receptionist']> = {}): Settings['receptionist'] {
  return {
    enabled: true,
    model: 'sonnet',
    webSearch: true,
    webFetch: 'never',
    webFetchAllowDomains: [],
    extraDenyReadGlobs: [],
    allowTagconnDocs: true,
    projectSafeMode: false,
    timeoutSec: 300,
    maxTurns: 30,
    maxConversations: 50,
    maxMessagesPerConversation: 200,
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

  it('L3: buildReceptionistDisallowedTools forwards settings.receptionist.extraDenyReadGlobs as Read(<glob>) rules, on top of the quest-level denies', () => {
    const runner = runnerCfg({ disallowedTools: ['Bash'] });
    const receptionist = receptionistCfg({ extraDenyReadGlobs: ['**/*.pem', '.ssh/**'] });
    const disallowed = buildReceptionistDisallowedTools(runner, receptionist);
    expect(disallowed).toContain('Bash');
    expect(disallowed).toContain('Read(**/*.pem)');
    expect(disallowed).toContain('Read(.ssh/**)');
  });

  it('L3: an empty extraDenyReadGlobs adds nothing beyond the quest-level denies', () => {
    const runner = runnerCfg({ disallowedTools: ['Bash'] });
    const receptionist = receptionistCfg({ extraDenyReadGlobs: [] });
    expect(buildReceptionistDisallowedTools(runner, receptionist)).toEqual(buildQuestDisallowedTools(runner));
  });

  describe('assertProjectDirAllowed (M4, §2.3/§2.7 server-side dir check)', () => {
    it('allows an exact match or a path lexically below an allowed root', () => {
      expect(() => assertProjectDirAllowed('/home/user/proj', ['/home/user'])).not.toThrow();
      expect(() => assertProjectDirAllowed('/home/user', ['/home/user'])).not.toThrow();
      expect(() => assertProjectDirAllowed('/home/user/proj/', ['/home/user/'])).not.toThrow(); // trailing separators normalize
    });

    it('an empty allowlist denies everything', () => {
      expect(() => assertProjectDirAllowed('/home/user/proj', [])).toThrow(/dir_not_allowed/);
    });

    it('denies a non-absolute path', () => {
      expect(() => assertProjectDirAllowed('relative/path', ['/home/user'])).toThrow(/dir_not_allowed/);
    });

    it('denies a sibling directory that merely shares a string prefix (not a real path boundary)', () => {
      expect(() => assertProjectDirAllowed('/home/username-evil', ['/home/user'])).toThrow(/dir_not_allowed/);
    });
  });

  describe('isValidWebFetchAllowRule / assertNoBareWebFetch (L4: exactly WebFetch(domain:x))', () => {
    it('accepts a non-WebFetch rule and the exact WebFetch(domain:x) shape; rejects everything else', () => {
      expect(isValidWebFetchAllowRule('Read')).toBe(true);
      expect(isValidWebFetchAllowRule('WebFetch(domain:example.com)')).toBe(true);
      expect(isValidWebFetchAllowRule('WebFetch')).toBe(false);
      expect(isValidWebFetchAllowRule('WebFetch()')).toBe(false);
      expect(isValidWebFetchAllowRule('WebFetch(url:example.com)')).toBe(false);
      expect(isValidWebFetchAllowRule('WebFetch(domain:127.0.0.1)')).toBe(false); // IP literal, not DOMAIN_RE
      expect(isValidWebFetchAllowRule('WebFetch(domain:example.com,domain:evil.com)')).toBe(false);
    });

    it('assertNoBareWebFetch/buildQuestAllowedTools reject a WebFetch rule that is well-formed-looking but not exactly WebFetch(domain:x)', () => {
      const cfg = runnerCfg({ allowedTools: ['Read', 'WebFetch(url:evil.com)'] });
      expect(() => buildQuestAllowedTools(cfg)).toThrow(/tool_not_allowed/);
    });
  });
});
