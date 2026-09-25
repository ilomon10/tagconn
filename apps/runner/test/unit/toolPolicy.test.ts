import { DEFAULT_QUEST_ALWAYS_DENY, DEFAULT_QUEST_MAX_ALLOWED_TOOLS } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { checkQuestPolicy, type PolicyCheckContext } from '../../src/toolPolicy.js';

const baseCtx: PolicyCheckContext = {
  maxPermissionMode: 'acceptEdits',
  allowBypassPermissions: false,
  questToolPolicy: { maxAllowedTools: [...DEFAULT_QUEST_MAX_ALLOWED_TOOLS], alwaysDeny: [...DEFAULT_QUEST_ALWAYS_DENY] },
  systemdScopeAvailable: false,
};

describe('checkQuestPolicy', () => {
  it('accepts a mode within the cap and tools within the local allowlist', () => {
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['Read', 'Edit'], availablePermissionModes: ['acceptEdits'] }, baseCtx);
    expect(r.ok).toBe(true);
  });

  it('rejects a mode above maxPermissionMode', () => {
    const r = checkQuestPolicy({ mode: 'bypassPermissions', allowedTools: [], availablePermissionModes: ['bypassPermissions'] }, baseCtx);
    expect(r).toEqual({ ok: false, failure: 'mode_not_allowed' });
  });

  it('rejects a mode the CLI did not accept in the capability probe', () => {
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: [], availablePermissionModes: ['plan'] }, baseCtx);
    expect(r).toEqual({ ok: false, failure: 'mode_not_allowed' });
  });

  it('bypassPermissions additionally requires allowBypassPermissions', () => {
    const ctx = { ...baseCtx, maxPermissionMode: 'bypassPermissions' as const, systemdScopeAvailable: true };
    const withoutFlag = checkQuestPolicy({ mode: 'bypassPermissions', allowedTools: [], availablePermissionModes: ['bypassPermissions'] }, ctx);
    expect(withoutFlag).toEqual({ ok: false, failure: 'mode_not_allowed' });
    const withFlag = checkQuestPolicy({ mode: 'bypassPermissions', allowedTools: [], availablePermissionModes: ['bypassPermissions'] }, { ...ctx, allowBypassPermissions: true });
    expect(withFlag.ok).toBe(true);
  });

  it('rejects an allow rule outside questToolPolicy.maxAllowedTools', () => {
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['SomeUnknownTool'], availablePermissionModes: ['acceptEdits'] }, baseCtx);
    expect(r).toEqual({ ok: false, failure: 'tool_not_allowed' });
  });

  it('always rejects a bare WebFetch rule, even if somehow listed locally', () => {
    const ctx = { ...baseCtx, questToolPolicy: { ...baseCtx.questToolPolicy, maxAllowedTools: [...baseCtx.questToolPolicy.maxAllowedTools, 'WebFetch'] } };
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['WebFetch'], availablePermissionModes: ['acceptEdits'] }, ctx);
    expect(r).toEqual({ ok: false, failure: 'tool_not_allowed' });
  });

  it('accepts WebFetch(domain:x) when listed locally', () => {
    const ctx = { ...baseCtx, questToolPolicy: { ...baseCtx.questToolPolicy, maxAllowedTools: [...baseCtx.questToolPolicy.maxAllowedTools, 'WebFetch(domain:example.com)'] } };
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['WebFetch(domain:example.com)'], availablePermissionModes: ['acceptEdits'] }, ctx);
    expect(r.ok).toBe(true);
  });

  it('Bash is not in the default allowlist, so a Bash rule fails tool_not_allowed before containment is even checked', () => {
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['Bash(git *:*)'], availablePermissionModes: ['acceptEdits'] }, baseCtx);
    expect(r).toEqual({ ok: false, failure: 'tool_not_allowed' });
  });

  it('a locally-allowed Bash rule requires a systemd scope, else isolation_unavailable', () => {
    const ctx = { ...baseCtx, questToolPolicy: { ...baseCtx.questToolPolicy, maxAllowedTools: [...baseCtx.questToolPolicy.maxAllowedTools, 'Bash(git *:*)'] } };
    const withoutScope = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['Bash(git *:*)'], availablePermissionModes: ['acceptEdits'] }, ctx);
    expect(withoutScope).toEqual({ ok: false, failure: 'isolation_unavailable' });
    const withScope = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['Bash(git *:*)'], availablePermissionModes: ['acceptEdits'] }, { ...ctx, systemdScopeAvailable: true });
    expect(withScope.ok).toBe(true);
    if (withScope.ok) expect(withScope.requiresScope).toBe(true);
  });

  it('auto and bypassPermissions modes require a systemd scope even with no Bash allow rule', () => {
    const ctx = { ...baseCtx, maxPermissionMode: 'auto' as const };
    const r = checkQuestPolicy({ mode: 'auto', allowedTools: ['Read'], availablePermissionModes: ['auto'] }, ctx);
    expect(r).toEqual({ ok: false, failure: 'isolation_unavailable' });
  });

  it('appends questToolPolicy.alwaysDeny to the caller-supplied disallowedTools, deduped', () => {
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: [], availablePermissionModes: ['acceptEdits'] }, baseCtx, ['Edit(.claude/**)', 'Read(secret/**)']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.disallowedTools).toContain('Read(secret/**)');
      expect(r.disallowedTools).toContain('Edit(.git/**)');
      expect(r.disallowedTools.filter((t) => t === 'Edit(.claude/**)')).toHaveLength(1); // deduped
    }
  });
});
