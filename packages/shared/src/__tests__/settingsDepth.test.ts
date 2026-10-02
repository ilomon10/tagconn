import { describe, expect, it } from 'vitest';
import { SettingsSchema, defaultSettings } from '../settings';

describe('office.camera and office.depth (M17)', () => {
  it('defaults', () => {
    const o = defaultSettings().office;
    expect(o.camera).toEqual({ follow: 'manual', deadzone: 0.3, followLagMs: 180, integerZoom: true, perspective: 0.1 });
    expect(o.depth).toEqual({ sprites: true, seeThrough: 0.45, seeThroughFadeMs: 160, maxSprites: 1500, fourDirections: true, wallShadows: true });
  });
  it('a partial section keeps the other defaults', () => {
    const s = SettingsSchema.parse({ office: { camera: { follow: 'selected' }, depth: { sprites: false } } });
    expect(s.office.camera.follow).toBe('selected');
    expect(s.office.camera.deadzone).toBe(0.3);
    expect(s.office.depth.sprites).toBe(false);
    expect(s.office.depth.maxSprites).toBe(1500);
  });
  it('rejects out-of-range values', () => {
    expect(() => SettingsSchema.parse({ office: { camera: { deadzone: 0.9 } } })).toThrow();
    expect(() => SettingsSchema.parse({ office: { camera: { follow: 'always' } } })).toThrow();
    expect(() => SettingsSchema.parse({ office: { depth: { seeThrough: 2 } } })).toThrow();
    expect(() => SettingsSchema.parse({ office: { depth: { maxSprites: 5001 } } })).toThrow();
  });
});
