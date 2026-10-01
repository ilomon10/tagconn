import { describe, expect, it } from 'vitest';
import { guildTheme } from './themes/guild';
import { modernTheme } from './themes/modern';
import { resolveCostume, resolveTitle, titleFor } from './lookResolver';

describe('resolveTitle', () => {
  const theme = { roleTitles: { pm: 'Guild Master', developer: 'Artificer' } };

  it('uses the themed title for a known role', () => {
    expect(resolveTitle(theme, 'pm', 'Project Manager')).toBe('Guild Master');
    expect(resolveTitle(theme, 'developer', 'Developer')).toBe('Artificer');
  });

  it('falls back to the given title for an unknown (custom) role', () => {
    expect(resolveTitle(theme, 'custom-role', 'Custom Role')).toBe('Custom Role');
  });
});

describe('resolveCostume', () => {
  const theme = {
    costumes: {
      pm: { hat: 'crown' as const, staff: 'staff' as const },
      default: { hat: 'hood' as const },
    },
  };

  it('uses the costume for a known role', () => {
    expect(resolveCostume(theme, 'pm')).toEqual({ hat: 'crown', staff: 'staff' });
  });

  it('falls back to the theme default for an unknown role', () => {
    expect(resolveCostume(theme, 'custom-role')).toEqual({ hat: 'hood' });
  });

  it('falls back to an empty costume when the theme has no default either', () => {
    expect(resolveCostume({ costumes: {} }, 'custom-role')).toEqual({});
  });
});

describe('titleFor', () => {
  const theme = { roleTitles: { pm: 'Guild Master', developer: 'Artificer' } };

  it('a hero title beats everything', () => {
    expect(titleFor(theme, 'pm', 'Lead', 'Keeper of Tests')).toBe('Keeper of Tests');
  });

  it('an edited role title beats the theme title; the shipped default does not', () => {
    expect(titleFor(theme, 'pm', 'Boss')).toBe('Boss');
    expect(titleFor(theme, 'pm', 'Project Manager')).toBe('Guild Master');
  });

  it('the Receptionist is themed per style', () => {
    expect(titleFor(modernTheme, 'receptionist', undefined)).toBe('Receptionist');
    expect(titleFor(guildTheme, 'receptionist', undefined)).toBe('Gatekeeper');
    expect(resolveCostume(guildTheme, 'receptionist').hat).toBe('circlet');
  });
});
