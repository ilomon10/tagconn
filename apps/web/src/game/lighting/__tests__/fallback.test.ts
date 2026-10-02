import { describe, expect, it } from 'vitest';
import { overlayPlan } from '../fallback';
import { lightingColours } from '../palette';
import { sunAt } from '../sun';
import { modernTheme } from '../../themes/modern';
import { guildTheme } from '../../themes/guild';
import { riftTheme } from '../../themes/rift';

describe('overlayPlan', () => {
  for (const theme of [modernTheme, guildTheme, riftTheme]) {
    const colours = lightingColours(theme);
    const P = { dawnHour: 6.5, duskHour: 18.5, twilightHours: 1.5, nightAmbient: 0 };
    it(`${theme.id}: 01:00 with nightAmbient 0 reproduces today's night`, () => {
      expect(overlayPlan(sunAt(1, P, colours), theme)).toEqual({ color: theme.lighting.nightTint, alpha: theme.lighting.nightAlpha });
    });
    it(`${theme.id}: noon is transparent`, () => {
      expect(overlayPlan(sunAt(12.5, P, colours), theme).alpha).toBe(0);
    });
    it(`${theme.id}: alpha shrinks with nightAmbient`, () => {
      const a = overlayPlan(sunAt(1, { ...P, nightAmbient: 0.5 }, colours), theme).alpha;
      expect(a).toBeCloseTo(theme.lighting.nightAlpha * 0.5, 9);
    });
  }
});

describe('lightingColours', () => {
  it('fills the optional fields per theme and keeps the theme values', () => {
    expect(lightingColours(modernTheme).sunColor).toBe(0xfff2c8);
    expect(lightingColours(guildTheme).roomLight).toBe(0xffb060);
    expect(lightingColours({ ...riftTheme, lighting: { ...riftTheme.lighting, moonTint: 0x123456 } }).moonTint).toBe(0x123456);
  });
  it('unknown ids (including prototype keys) fall back to modern', () => {
    for (const id of ['nope', '__proto__', 'constructor']) {
      expect(lightingColours({ id, lighting: modernTheme.lighting } as never).dawnTint).toBe(0xffd9b0);
    }
  });
});
