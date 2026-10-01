import { describe, expect, it } from 'vitest';
import type { Role } from '@tagconn/shared';
import { floorStyleFor, themedRoleInfo, type RoleInfo } from './hooks';
import { getTheme } from '../game/themes';

const role = (name: string, title: string): Role => ({ name, title, description: 'd', prompt: 'p', color: '#9013fe' }) as Role;
const info = (name: string, title: string): RoleInfo => ({ title, color: '#9013fe', role: role(name, title) });

/**
 * `themedRoleInfo` is the pure part of `useThemedRoleLookup`: the hook itself needs a React render,
 * but composing a `RoleInfo` with a floor style's theme (and an optional hero title) is plain data.
 */
describe('themedRoleInfo', () => {
  it('uses the floor style title for a shipped role the theme knows about', () => {
    expect(themedRoleInfo(getTheme('guild'), info('architect', 'Architect'), 'architect').themedTitle).toBe('Archmage');
  });

  it('follows the floor style: the PM is a Guild Master on guild floors only', () => {
    const pm = info('pm', 'Project Manager');
    expect(themedRoleInfo(getTheme('guild'), pm, 'pm').themedTitle).toBe('Guild Master');
    expect(themedRoleInfo(getTheme('modern'), pm, 'pm').themedTitle).toBe('Project Manager');
  });

  it('keeps a role title the user edited, on every style', () => {
    const pm = info('pm', 'Captain');
    expect(themedRoleInfo(getTheme('guild'), pm, 'pm').themedTitle).toBe('Captain');
    expect(themedRoleInfo(getTheme('modern'), pm, 'pm').themedTitle).toBe('Captain');
  });

  it('puts a hero title first', () => {
    expect(themedRoleInfo(getTheme('guild'), info('pm', 'Project Manager'), 'pm', 'Quartermaster').themedTitle).toBe('Quartermaster');
  });

  it('falls back to the plain role title for a custom role the theme has no entry for', () => {
    expect(themedRoleInfo(getTheme('guild'), info('custom-role', 'Architect'), 'custom-role').themedTitle).toBe('Architect');
  });

  it('falls back to the role name for a role that is not configured', () => {
    const unknown: RoleInfo = { title: 'ghost', color: '#000000' };
    expect(themedRoleInfo(getTheme('guild'), unknown, 'ghost').themedTitle).toBe('ghost');
  });

  it('falls back to the plain title when no role name is given', () => {
    expect(themedRoleInfo(getTheme('guild'), { title: 'unknown', color: '#000000' }, undefined).themedTitle).toBe('unknown');
  });

  it('keeps the rest of the RoleInfo fields untouched', () => {
    const result = themedRoleInfo(getTheme('modern'), info('architect', 'Architect'), 'architect');
    expect(result.title).toBe('Architect');
    expect(result.color).toBe('#9013fe');
  });
});

describe('floorStyleFor', () => {
  const settings = { office: { style: 'modern', defaultLayoutId: 'default' } } as Parameters<typeof floorStyleFor>[2];
  it("uses the layout's own style, else the global one", () => {
    expect(floorStyleFor(undefined, {}, settings)).toBe('modern');
  });
});
