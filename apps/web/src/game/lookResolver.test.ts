import { describe, expect, it } from 'vitest';
import { resolveCostume, resolveTitle } from './lookResolver';

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
