import { HostClockSchema } from '@tagconn/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostClock } from '../snapshot.service.js';

afterEach(() => vi.restoreAllMocks());

describe('hostClock', () => {
  it('passes the client schema', () => {
    expect(HostClockSchema.safeParse(hostClock(Date.now())).success).toBe(true);
  });
  it('omits a zone name the client schema would reject instead of losing the whole clock', () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: 'Bad Zone<script>' };
    });
    const clock = hostClock(1_700_000_000_000);
    expect(clock.tz).toBeUndefined();
    expect(HostClockSchema.safeParse(clock).success).toBe(true);
  });
});
