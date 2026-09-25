import { describe, expect, it } from 'vitest';
import { themedRoleInfo, type RoleInfo } from './hooks';

/**
 * `themedRoleInfo` is the pure part of `useThemedRoleLookup` (Roster titles, QA follow-up): the
 * hook itself needs a React render to test, but the composition of a `RoleInfo` with a theme's
 * `roleTitles` map is plain data in, data out.
 */
describe('themedRoleInfo', () => {
  const info: RoleInfo = { title: 'Architect', color: '#9013fe' };

  it('uses the themed title for a role the theme knows about', () => {
    const theme = { roleTitles: { architect: 'Archmage' } };
    expect(themedRoleInfo(theme, info, 'architect').themedTitle).toBe('Archmage');
  });

  it('falls back to the plain role title for a custom role the theme has no entry for', () => {
    const theme = { roleTitles: { architect: 'Archmage' } };
    expect(themedRoleInfo(theme, info, 'custom-role').themedTitle).toBe('Architect');
  });

  it('falls back to the plain title when no role name is given', () => {
    const theme = { roleTitles: { architect: 'Archmage' } };
    expect(themedRoleInfo(theme, info, undefined).themedTitle).toBe('Architect');
  });

  it('keeps the rest of the RoleInfo fields untouched', () => {
    const theme = { roleTitles: {} };
    const result = themedRoleInfo(theme, info, 'architect');
    expect(result.title).toBe('Architect');
    expect(result.color).toBe('#9013fe');
  });
});
