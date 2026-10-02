import { describe, expect, it } from 'vitest';
import { lightingColours } from '../palette';
import { moonPhase, sunAt, sunShadowVector, type SunParams } from '../sun';
import { modernTheme } from '../../themes/modern';

const colours = lightingColours(modernTheme);
const P: SunParams = { dawnHour: 6.5, duskHour: 18.5, twilightHours: 1.5, nightAmbient: 0.35 };

describe('sunAt table', () => {
  it('midnight: night', () => {
    const s = sunAt(0, P, colours);
    expect(s).toMatchObject({ phase: 'night', daylight: 0, elevation: 0, ambient: 0.35 });
    expect(s.moon).toBeGreaterThan(0.39);
  });
  it('dawn centre: half light, horizon, east', () => {
    const s = sunAt(6.5, P, colours);
    expect(s.phase).toBe('dawn');
    expect(s.daylight).toBeCloseTo(0.5, 6);
    expect(s.elevation).toBeCloseTo(0, 6);
    expect(s.skew).toBeCloseTo(-1, 6);
  });
  it('noon: full day, overhead', () => {
    const s = sunAt(12.5, P, colours);
    expect(s).toMatchObject({ phase: 'day', daylight: 1, ambient: 1, moon: 0 });
    expect(s.elevation).toBeCloseTo(1, 6);
    expect(s.skew).toBeCloseTo(0, 6);
  });
  it('dusk centre: half light, west', () => {
    const s = sunAt(18.5, P, colours);
    expect(s.phase).toBe('dusk');
    expect(s.daylight).toBeCloseTo(0.5, 6);
    expect(s.skew).toBeCloseTo(1, 6);
  });
  it('23.99 is night and wraps to hour 0 within one step', () => {
    const a = sunAt(24 - 1e-6, P, colours);
    const b = sunAt(0, P, colours);
    expect(a.phase).toBe('night');
    expect(Math.abs(a.daylight - b.daylight)).toBeLessThan(0.01);
    expect(sunAt(24, P, colours).hour).toBe(0);
    expect(sunAt(-1, P, colours).hour).toBe(23);
  });
});

describe('daylight ramps', () => {
  it('continuous (<= 0.05 per minute) and monotonic across each twilight', () => {
    let prev = sunAt(0, P, colours).daylight;
    let rising = true;
    for (let m = 1; m <= 1440; m++) {
      const d = sunAt(m / 60, P, colours).daylight;
      expect(Math.abs(d - prev)).toBeLessThanOrEqual(0.05);
      const h = m / 60;
      if (h < 12.5) expect(d).toBeGreaterThanOrEqual(prev - 1e-12);
      else if (h > 12.5) expect(d).toBeLessThanOrEqual(prev + 1e-12);
      prev = d;
      rising = rising && true;
    }
  });
  it('skew is antisymmetric about the day centre', () => {
    for (const t of [0.5, 2, 5]) {
      expect(sunAt(6.5 + t, P, colours).skew).toBeCloseTo(-sunAt(18.5 - t, P, colours).skew, 9);
    }
  });
  it('elevation peaks at the day centre', () => {
    let best = -1;
    let at = 0;
    for (let m = 0; m < 1440; m++) {
      const e = sunAt(m / 60, P, colours).elevation;
      if (e > best) { best = e; at = m / 60; }
    }
    expect(at).toBeCloseTo(12.5, 1);
  });
  it('nightAmbient 1 keeps ambient 1 all day', () => {
    for (let h = 0; h < 24; h += 0.5) expect(sunAt(h, { ...P, nightAmbient: 1 }, colours).ambient).toBe(1);
  });
  it('tint warms inside the ramps', () => {
    expect(sunAt(6.5, P, colours).tint).not.toBe(sunAt(12, P, colours).tint);
    expect(sunAt(12, P, colours).tint).toBe(0xffffff);
    expect(sunAt(0, P, colours).tint).toBe(colours.moonTint);
  });
});

describe('degenerate params stay finite and in range', () => {
  const check = (h: number, p: SunParams) => {
    const s = sunAt(h, p, colours, 3);
    for (const k of ['daylight', 'elevation', 'moon', 'ambient'] as const) {
      expect(Number.isFinite(s[k])).toBe(true);
      expect(s[k]).toBeGreaterThanOrEqual(0);
      expect(s[k]).toBeLessThanOrEqual(1);
    }
    expect(Number.isFinite(s.skew)).toBe(true);
    expect(Math.abs(s.skew)).toBeLessThanOrEqual(1);
    expect(Number.isFinite(s.tint)).toBe(true);
    expect(s.hour).toBeGreaterThanOrEqual(0);
    expect(s.hour).toBeLessThan(24);
  };
  it('dawn=11 dusk=13 twilight=4', () => {
    for (let m = 0; m < 1440; m += 7) check(m / 60, { dawnHour: 11, duskHour: 13, twilightHours: 4, nightAmbient: 0.35 });
  });
  it('ramps that straddle midnight (dawn 0, dusk 24)', () => {
    for (let m = 0; m < 1440; m += 7) check(m / 60, { dawnHour: 0, duskHour: 24, twilightHours: 4, nightAmbient: 0.2 });
  });
  it('NaN / Infinity inputs give the noon state', () => {
    for (const h of [Number.NaN, Infinity, -Infinity]) {
      const s = sunAt(h, P, colours);
      expect(s).toMatchObject({ hour: 12, daylight: 1, phase: 'day' });
    }
    check(5, { ...P, dawnHour: Number.NaN });
    check(5, { ...P, dawnHour: 13, duskHour: 12 });
    check(5, { ...P, nightAmbient: Number.NaN });
  });
});

describe('moonPhase / sunShadowVector', () => {
  it('moonPhase stays in [0.4, 1]', () => {
    for (let d = -40; d < 80; d++) {
      const m = moonPhase(d);
      expect(m).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(m).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(moonPhase(Number.NaN)).toBeCloseTo(1, 9);
  });
  it('zero at night, longer at dawn than noon, leans opposite the skew', () => {
    const T = 16;
    expect(sunShadowVector(sunAt(0, P, colours), 32, T)).toEqual({ x: 0, y: 0 });
    const dawn = sunShadowVector(sunAt(7.5, P, colours), 32, T);
    const noon = sunShadowVector(sunAt(12.5, P, colours), 32, T);
    expect(dawn.y).toBeGreaterThan(noon.y);
    expect(dawn.x).toBeGreaterThan(0); // morning: sun east, shadow west->east lean = -skew > 0
    expect(Math.hypot(sunShadowVector(sunAt(7, P, colours), 1000, T).y)).toBeLessThanOrEqual(2 * T);
  });
});
