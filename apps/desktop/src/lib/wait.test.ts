import { afterEach, describe, expect, it, vi } from 'vitest';
import { countdown, waitFor } from './wait';

afterEach(() => vi.useRealTimers());

describe('waitFor', () => {
  it('resolves true when the predicate turns true', async () => {
    vi.useFakeTimers();
    let up = false;
    const p = waitFor(() => up, 5000, 100);
    await vi.advanceTimersByTimeAsync(300);
    up = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe(true);
  });

  it('resolves false on timeout', async () => {
    vi.useFakeTimers();
    const p = waitFor(() => false, 1000, 100);
    await vi.advanceTimersByTimeAsync(1200);
    await expect(p).resolves.toBe(false);
  });
});

describe('countdown', () => {
  it('formats the time left and ends at expiry', () => {
    expect(countdown(125_000, 0)).toBe('2:05');
    expect(countdown(1_000, 0)).toBe('0:01');
    expect(countdown(1_000, 1_000)).toBeNull();
  });
});
