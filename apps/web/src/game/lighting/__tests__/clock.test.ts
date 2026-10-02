import { describe, expect, it } from 'vitest';
import type { HostClock } from '@tagconn/shared';
import { SettingsSchema } from '@tagconn/shared';
import {
  cycleHour,
  effectiveSunStep,
  hostLocalHour,
  hostNow,
  resolveCycle,
  sunStep,
  syncClock,
  type ClockSync,
  type ResolvedCycle,
} from '../clock';

const lighting = SettingsSchema.parse({}).office.lighting;
const sync = (tzOffsetMin: number, skewMs = 0): ClockSync => ({ skewMs, tzOffsetMin, measuredAt: 0 });
// 2026-10-02T00:00:00Z
const MIDNIGHT_UTC = Date.UTC(2026, 9, 2);

describe('syncClock', () => {
  const clock: HostClock = { serverNow: 1_000_000, tzOffsetMin: 420, tz: 'Asia/Jakarta' };
  it('uses the round-trip midpoint (RTT 0 and 200 ms)', () => {
    expect(syncClock(clock, 5000, 5000, 0).skewMs).toBe(1_000_000 - 5000);
    expect(syncClock(clock, 5000, 5200, 0).skewMs).toBe(1_000_000 - 5100);
  });
  it('keeps the host zone and name', () => {
    const s = syncClock(clock, 0, 0, 0);
    expect(s.tzOffsetMin).toBe(420);
    expect(s.tz).toBe('Asia/Jakarta');
  });
  it('a missing clock gives skew 0 and the browser zone', () => {
    const s = syncClock(undefined, 10, 20, -240);
    expect(s).toMatchObject({ skewMs: 0, tzOffsetMin: -240 });
    expect(s.tz).toBeUndefined();
  });
  it('an invalid clock falls back to no clock', () => {
    for (const bad of [
      { serverNow: -1, tzOffsetMin: 0 },
      { serverNow: 1e20, tzOffsetMin: 0 },
      { serverNow: 5, tzOffsetMin: 99_999 },
      { serverNow: 5, tzOffsetMin: 1.5 },
      { serverNow: 5, tzOffsetMin: 0, tz: '../../x y' },
      { serverNow: Number.NaN, tzOffsetMin: 0 },
    ]) {
      const s = syncClock(bad as HostClock, 0, 0, 60);
      expect(s).toMatchObject({ skewMs: 0, tzOffsetMin: 60 });
    }
  });
  it('is finite for non-finite timestamps', () => {
    expect(syncClock(clock, Number.NaN, 1, 0).skewMs).toBe(0);
  });
});

describe('hostLocalHour', () => {
  it('Jakarta (+420) and New York (-240) on a fixed epoch, regardless of the runner zone', () => {
    const now = MIDNIGHT_UTC + 5 * 3_600_000; // 05:00Z
    expect(hostLocalHour(sync(420), now)).toBeCloseTo(12, 9);
    expect(hostLocalHour(sync(-240), now)).toBeCloseTo(1, 9);
  });
  it('applies skew', () => {
    const now = MIDNIGHT_UTC;
    expect(hostLocalHour(sync(0, 90 * 60_000), now)).toBeCloseTo(1.5, 9);
    expect(hostNow(sync(0, 5), 10)).toBe(15);
  });
  it('survives +-10 year skew and stays in [0, 24)', () => {
    const ten = 10 * 365 * 86_400_000;
    for (const skew of [ten, -ten, -1e17, 1e17]) {
      const h = hostLocalHour(sync(420, skew), MIDNIGHT_UTC);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(24);
    }
  });
  it('negative host epoch still lands in range', () => {
    const h = hostLocalHour(sync(-720, -MIDNIGHT_UTC * 3), MIDNIGHT_UTC);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(24);
  });
  it('non-finite now gives noon', () => {
    expect(hostLocalHour(sync(0), Number.NaN)).toBe(12);
  });
});

describe('cycleHour', () => {
  const base: ResolvedCycle = { cycle: 'fixed', fixedHour: 14, cycleMinutes: 24, source: 'settings' };
  const s = sync(0);
  it('host-clock follows the host hour', () => {
    expect(cycleHour({ ...base, cycle: 'host-clock' }, s, MIDNIGHT_UTC + 3 * 3_600_000, 0)).toBeCloseTo(3, 9);
  });
  it('fixed returns fixedHour, 24 wraps to 0', () => {
    expect(cycleHour(base, s, 1, 0)).toBe(14);
    expect(cycleHour({ ...base, fixedHour: 24 }, s, 1, 0)).toBe(0);
  });
  it('accelerated advances 24 h per cycleMinutes and wraps at 24', () => {
    const acc: ResolvedCycle = { ...base, cycle: 'accelerated', fixedHour: 20, cycleMinutes: 24 };
    expect(cycleHour(acc, s, 60_000, 0)).toBeCloseTo(21, 9);
    expect(cycleHour(acc, s, 4 * 60_000, 0)).toBeCloseTo(0, 9);
    expect(cycleHour(acc, s, 24 * 60_000, 0)).toBeCloseTo(20, 9);
  });
  it('accelerated tolerates now < epoch (negative elapsed)', () => {
    const acc: ResolvedCycle = { ...base, cycle: 'accelerated', fixedHour: 2, cycleMinutes: 24 };
    const h = cycleHour(acc, s, 0, 3 * 60_000);
    expect(h).toBeCloseTo(23, 9);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(24);
  });
  it('degenerate cycleMinutes / non-finite now stay finite', () => {
    const acc: ResolvedCycle = { ...base, cycle: 'accelerated', cycleMinutes: 0 };
    expect(cycleHour(acc, s, 5, 0)).toBe(14);
    expect(cycleHour({ ...acc, cycleMinutes: 5 }, s, Number.NaN, 0)).toBe(12);
  });
});

describe('sunStep', () => {
  it('floors on step boundaries', () => {
    expect(sunStep(0, 15)).toBe(0);
    expect(sunStep(0.2499, 15)).toBe(0);
    expect(sunStep(0.25, 15)).toBe(1);
    expect(sunStep(23.99, 15)).toBe(95);
  });
});

describe('effectiveSunStep', () => {
  it('uses sunStepMinutes unless accelerated', () => {
    expect(effectiveSunStep({ ...lighting, cycle: 'host-clock', cycleMinutes: 1 })).toBe(lighting.sunStepMinutes);
  });
  it('floors accelerated at ceil(12 / cycleMinutes)', () => {
    expect(effectiveSunStep({ cycle: 'accelerated', cycleMinutes: 1, sunStepMinutes: 1 })).toBe(12);
    expect(effectiveSunStep({ cycle: 'accelerated', cycleMinutes: 24, sunStepMinutes: 15 })).toBe(15);
    expect(effectiveSunStep({ cycle: 'accelerated', cycleMinutes: 5, sunStepMinutes: 1 })).toBe(3);
  });
});

describe('resolveCycle precedence', () => {
  const l = { ...lighting, cycle: 'accelerated' as const, fixedHour: 9 };
  it('override beats everything', () => {
    expect(resolveCycle('night', l, { hour: 15 })).toMatchObject({ cycle: 'fixed', fixedHour: 15, source: 'override' });
  });
  it('override 24 becomes 0', () => {
    expect(resolveCycle('auto', l, { hour: 24 }).fixedHour).toBe(0);
  });
  it('theme day / night pin 13:00 / 01:00', () => {
    expect(resolveCycle('day', l, null)).toMatchObject({ cycle: 'fixed', fixedHour: 13, source: 'theme' });
    expect(resolveCycle('night', l, null)).toMatchObject({ cycle: 'fixed', fixedHour: 1, source: 'theme' });
  });
  it('auto defers to the settings', () => {
    expect(resolveCycle('auto', l, null)).toMatchObject({ cycle: 'accelerated', fixedHour: 9, source: 'settings' });
    expect(resolveCycle('auto', { ...l, fixedHour: 24 }, null).fixedHour).toBe(0);
  });
});
