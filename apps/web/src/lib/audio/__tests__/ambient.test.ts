import { afterEach, describe, expect, it, vi } from 'vitest';
import { ambientFor, createAmbient } from '../ambient';
import type { AmbientKind } from '../types';

function fakeCtx() {
  const created: { disconnect: ReturnType<typeof vi.fn>; start?: ReturnType<typeof vi.fn>; stop?: ReturnType<typeof vi.fn> }[] = [];
  const param = () => ({ value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const node = (extra: object = {}) => {
    const n = { connect: vi.fn(), disconnect: vi.fn(), ...extra };
    created.push(n);
    return n;
  };
  const ctx = {
    sampleRate: 8000,
    currentTime: 0,
    createBuffer: (_c: number, len: number) => {
      const data = new Float32Array(len);
      return { getChannelData: () => data };
    },
    createGain: () => node({ gain: param() }),
    createBufferSource: () => node({ start: vi.fn(), stop: vi.fn(), loop: false, buffer: null }),
    createBiquadFilter: () => node({ frequency: param(), Q: param(), type: 'lowpass' }),
    createOscillator: () => node({ start: vi.fn(), stop: vi.fn(), frequency: param(), type: 'sine' }),
  };
  return { ctx: ctx as unknown as BaseAudioContext, created };
}

describe('ambientFor', () => {
  it('maps style x night', () => {
    expect(ambientFor('modern', false)).toBe('office-day');
    expect(ambientFor('modern', true)).toBe('office-night');
    expect(ambientFor('guild', false)).toBe('tavern-day');
    expect(ambientFor('guild', true)).toBe('tavern-night');
    expect(ambientFor('rift', false)).toBe('rift');
    expect(ambientFor('rift', true)).toBe('rift');
  });
});

describe('createAmbient', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['office-day', 'office-night', 'tavern-day', 'tavern-night', 'rift'] as AmbientKind[])('%s builds and stops', (kind) => {
    vi.useFakeTimers();
    const { ctx, created } = fakeCtx();
    const out = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
    const a = createAmbient(ctx, kind, out);
    expect(created.some((n) => n.start)).toBe(true);
    for (const n of created) if (n.start) expect(n.start).toHaveBeenCalled();
    a.stop();
    const bus = created.find((n) => 'gain' in n) as unknown as { gain: { linearRampToValueAtTime: ReturnType<typeof vi.fn> } };
    expect(bus.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, expect.any(Number));
    vi.advanceTimersByTime(1000);
    for (const n of created) {
      expect(n.disconnect).toHaveBeenCalled();
      if (n.stop) expect(n.stop).toHaveBeenCalled();
    }
    a.stop(); // idempotent
    expect(created.find((n) => n.stop)?.stop).toHaveBeenCalledTimes(1);
  });
});
