// SC5 R2 (re-review): `absoluteRulePath` (packages/shared/src/runner.ts) doubles an absolute path's
// leading slash so a Claude Code permission rule glob built around it matches the filesystem path
// itself, instead of being silently reinterpreted relative to the settings source (project dir /
// $HOME). See apps/runner/src/validate.ts's stateDir deny for the one caller in this app today.

import { absoluteRulePath } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';

describe('absoluteRulePath', () => {
  it('doubles the leading slash of an absolute path', () => {
    expect(absoluteRulePath('/home/u/.local/state/tagconn')).toBe('//home/u/.local/state/tagconn');
  });

  it('doubles the leading slash of the filesystem root itself', () => {
    expect(absoluteRulePath('/')).toBe('//');
  });

  it('produces a rule glob that reads as an absolute path, not a project-relative one', () => {
    const rule = `Edit(${absoluteRulePath('/state')}/**)`;
    expect(rule).toBe('Edit(//state/**)');
    expect(rule).not.toBe('Edit(/state/**)'); // R2: the bug this helper fixes
  });
});
