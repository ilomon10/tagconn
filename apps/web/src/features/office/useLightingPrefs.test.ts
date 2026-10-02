import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@tagconn/shared';
import { formatHour, formatOffset, hostZoneLabel, phaseLabel } from './useLightingPrefs';
import { syncClock } from '../../game/lighting/clock';
import { demoClock } from '../../lib/mock';

const sun = defaultSettings().office.lighting;

describe('useLightingPrefs helpers', () => {
  it('formatHour pads, rolls minutes and wraps', () => {
    expect(formatHour(14.5)).toBe('14:30');
    expect(formatHour(0)).toBe('00:00');
    expect(formatHour(9.999)).toBe('10:00');
    expect(formatHour(24)).toBe('00:00');
    expect(formatHour(Number.NaN)).toBe('12:00');
  });

  it('phaseLabel names the sun phase', () => {
    expect(phaseLabel(13, sun)).toBe('daytime');
    expect(phaseLabel(1, sun)).toBe('night');
  });

  it('formatOffset and hostZoneLabel prefer the zone name, then the offset', () => {
    expect(formatOffset(0)).toBe('UTC');
    expect(formatOffset(420)).toBe('UTC+7');
    expect(formatOffset(-210)).toBe('UTC-3:30');
    expect(hostZoneLabel(undefined)).toBeUndefined();
    expect(hostZoneLabel({ skewMs: 0, tzOffsetMin: 0, measuredAt: 0 })).toBe('UTC');
    expect(hostZoneLabel({ skewMs: 0, tzOffsetMin: 420, tz: 'Asia/Jakarta', measuredAt: 0 })).toBe('Asia/Jakarta');
  });

  it('demoClock syncs to zero skew', () => {
    expect(syncClock(demoClock(1000), 1000, 1000).skewMs).toBe(0);
  });
});
