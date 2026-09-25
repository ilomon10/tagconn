import { describe, expect, it } from 'vitest';
import { MASKED_SECRET, defaultSettings } from '@tagconn/shared';
import { applySettingsPatch, diffSettings, isGuiImmutable, patchKeys, restartKeysIn } from './settingsPatch';

describe('settings diff', () => {
  it('is empty for identical settings', () => {
    expect(diffSettings(defaultSettings(), defaultSettings())).toEqual({});
  });

  it('contains only changed leaves, with arrays/records sent whole', () => {
    const base = defaultSettings();
    const draft = structuredClone(base);
    draft.office.walkSpeed = 200;
    draft.storage.eventRetentionDays = 3;
    draft.agents.typeToRole = { Explore: 'analyst' };
    const patch = diffSettings(base, draft);
    expect(patch).toEqual({ office: { walkSpeed: 200 }, storage: { eventRetentionDays: 3 }, agents: { typeToRole: { Explore: 'analyst' } } });
    expect(patchKeys(patch).sort()).toEqual(['agents.typeToRole', 'office.walkSpeed', 'storage.eventRetentionDays']);
    expect(restartKeysIn({ server: { port: 1 } })).toEqual(['server.port']);
    expect(applySettingsPatch(base, patch)).toEqual(draft);
  });

  it('never sends GUI-immutable keys or the masked secret', () => {
    const base = defaultSettings();
    const draft = structuredClone(base);
    draft.server.port = 5000;
    draft.server.hookToken = MASKED_SECRET;
    draft.paths.claudeDir = '/tmp/x';
    draft.storage.dbPath = '/tmp/db';
    draft.runner.permissionMode = 'plan';
    draft.runner.maxConcurrent = 5;
    draft.office.walkSpeed = 90;
    expect(diffSettings(base, draft)).toEqual({ office: { walkSpeed: 90 } });
    expect(isGuiImmutable('runner.maxConcurrent')).toBe(true);
    expect(isGuiImmutable('auth.protect')).toBe(true);
    expect(isGuiImmutable('server.hookToken')).toBe(true);
    expect(isGuiImmutable('storage.dbPath')).toBe(true);
    expect(isGuiImmutable('storage.eventRetentionDays')).toBe(false);
  });
});
