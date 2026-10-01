import { describe, expect, it } from 'vitest';
import { dayNightChanged, resolveMix } from '../mix';

const office = { sound: true, audio: { volume: 0.6, sfx: true, ambient: false, alerts: true, footsteps: false } };

describe('resolveMix', () => {
  it('uses the server defaults without prefs', () => {
    expect(resolveMix(office, { muted: null, volume: null }, false)).toEqual({ master: 0.6, sfx: true, ambient: false, alerts: true, footsteps: false });
  });
  it('server sound off mutes unless the pref overrides', () => {
    const off = { ...office, sound: false };
    expect(resolveMix(off, { muted: null, volume: null }, false).master).toBe(0);
    expect(resolveMix(off, { muted: false, volume: null }, false).master).toBe(0.6);
  });
  it('pref mute and volume win', () => {
    expect(resolveMix(office, { muted: true, volume: 0.9 }, false).master).toBe(0);
    expect(resolveMix(office, { muted: false, volume: 0.2 }, false).master).toBe(0.2);
  });
  it('hidden tab is silent', () => {
    expect(resolveMix(office, { muted: false, volume: 1 }, true).master).toBe(0);
  });
});

describe('dayNightChanged', () => {
  it('only fires when the light flips on the same style', () => {
    const modernDay = { style: 'modern', night: false } as const;
    expect(dayNightChanged(null, modernDay)).toBe(false);
    expect(dayNightChanged(modernDay, modernDay)).toBe(false);
    expect(dayNightChanged(modernDay, { style: 'modern', night: true })).toBe(true);
    expect(dayNightChanged(modernDay, { style: 'guild', night: true })).toBe(false);
  });
});
