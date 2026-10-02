import { describe, expect, it } from 'vitest';
import { HostClockSchema } from '../domain.js';
import { defaultSettings, SettingsSchema } from '../settings.js';

describe('HostClockSchema (M16)', () => {
  const ok = (o: Record<string, unknown>) => HostClockSchema.safeParse({ serverNow: 1_700_000_000_000, tzOffsetMin: 420, ...o }).success;
  it('accepts a real clock, with and without a zone name', () => {
    expect(ok({})).toBe(true);
    expect(ok({ tz: 'Asia/Jakarta' })).toBe(true);
    expect(ok({ tz: 'Etc/GMT+5', tzOffsetMin: -300 })).toBe(true);
  });
  it('rejects out-of-range, fractional and non-numeric values', () => {
    expect(ok({ serverNow: -1 })).toBe(false);
    expect(ok({ serverNow: 8.64e15 + 2 })).toBe(false);
    expect(ok({ serverNow: Number.NaN })).toBe(false);
    expect(ok({ serverNow: 1.5 })).toBe(false);
    expect(ok({ tzOffsetMin: 841 })).toBe(false);
    expect(ok({ tzOffsetMin: -721 })).toBe(false);
    expect(ok({ tzOffsetMin: 330.5 })).toBe(false);
  });
  it('rejects a hostile or oversized zone name', () => {
    expect(ok({ tz: '<img src=x>' })).toBe(false);
    expect(ok({ tz: 'A'.repeat(65) })).toBe(false);
    expect(ok({ tz: '' })).toBe(false);
  });
});

describe('office.lighting settings (M16)', () => {
  it('defaults parse and an old settings object without lighting still parses', () => {
    const d = defaultSettings();
    expect(d.office.lighting.cycle).toBe('host-clock');
    expect(d.office.lighting.duskHour).toBe(18.5);
    const { lighting: _l, ...rest } = d.office;
    expect(SettingsSchema.safeParse({ ...d, office: rest }).success).toBe(true);
  });
  it('keeps dawn and dusk at least two hours apart', () => {
    const p = (lighting: Record<string, unknown>) => SettingsSchema.safeParse({ ...defaultSettings(), office: { ...defaultSettings().office, lighting } }).success;
    expect(p({ dawnHour: 11, duskHour: 13 })).toBe(true);
    expect(p({ dawnHour: 12 })).toBe(false);
    expect(p({ duskHour: 12 })).toBe(false);
  });
});
