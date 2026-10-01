import { describe, expect, it, vi } from 'vitest';
import { createMusic, musicLoopSeconds, renderMusicLoop } from '../music';
import type { MusicStyle } from '../types';

const STYLES: MusicStyle[] = ['modern', 'guild', 'rift'];

describe('battle music', () => {
  it.each(STYLES)('%s renders a deterministic, bounded 4-bar loop', (style) => {
    const a = renderMusicLoop(style, 8000);
    const b = renderMusicLoop(style, 8000);
    expect(a).toEqual(b);
    expect(a.length).toBe(Math.round(musicLoopSeconds(style) * 8000));
    expect(musicLoopSeconds(style)).toBeGreaterThan(5);
    expect(musicLoopSeconds(style)).toBeLessThan(12);
    let peak = 0;
    for (const v of a) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThanOrEqual(0.8001);
  });
  it('styles differ', () => {
    expect(renderMusicLoop('modern', 8000)).not.toEqual(renderMusicLoop('guild', 8000));
  });
  it('fades in, loops, and fades out on stop', () => {
    vi.useFakeTimers();
    const node = () => ({
      gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), loop: false, buffer: null as unknown,
    });
    const src = node();
    const bus = node();
    const ctx = {
      currentTime: 1, sampleRate: 8000,
      createBuffer: () => ({ getChannelData: () => new Float32Array(Math.round(musicLoopSeconds('modern') * 8000)) }),
      createGain: () => bus, createBufferSource: () => src,
    } as unknown as BaseAudioContext;
    const m = createMusic(ctx, 'modern', {} as AudioNode, 400);
    expect(src.loop).toBe(true);
    expect(src.start).toHaveBeenCalled();
    expect(bus.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 1.4);
    m.stop(300);
    expect(bus.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 1.3);
    expect(src.stop).toHaveBeenCalledWith(1.3);
    vi.runAllTimers();
    expect(bus.disconnect).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
