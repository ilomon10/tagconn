import { describe, expect, it } from 'vitest';
import { renderSfx } from '../sfxr';
import type { SfxParams, Wave } from '../types';

const base: SfxParams = { wave: 'square', attack: 0.01, sustain: 0.05, decay: 0.04, freq: 440, gain: 0.5 };
const RATE = 22050;

describe('renderSfx', () => {
  it('is deterministic', () => {
    const p: SfxParams = { ...base, wave: 'noise', seed: 3, lowpass: 1000 };
    expect(renderSfx(p, RATE)).toEqual(renderSfx(p, RATE));
  });
  it('different noise seeds differ', () => {
    const a = renderSfx({ ...base, wave: 'noise', seed: 1 }, RATE);
    const b = renderSfx({ ...base, wave: 'noise', seed: 2 }, RATE);
    expect(a).not.toEqual(b);
  });
  it('length is attack + sustain + decay', () => {
    expect(renderSfx(base, RATE).length).toBe(Math.round(0.1 * RATE));
  });
  it('length is the notes end', () => {
    const out = renderSfx({ ...base, notes: [{ freq: 440, at: 0, len: 0.1 }, { freq: 660, at: 0.2, len: 0.15 }] }, RATE);
    expect(out.length).toBe(Math.round(0.35 * RATE));
  });
  it.each(['square', 'saw', 'triangle', 'sine', 'noise'] as Wave[])('%s: peak <= gain, no NaN, not silent', (wave) => {
    const out = renderSfx({ ...base, wave, punch: 1, slide: 200, vibratoHz: 6, vibratoDepth: 0.2, lowpass: 2000, highpass: 100 }, RATE);
    let peak = 0;
    for (const v of out) {
      expect(Number.isNaN(v)).toBe(false);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(0.5 + 1e-6);
  });
  it('starts and ends soft (no click)', () => {
    const out = renderSfx({ ...base, attack: 0, decay: 0 }, RATE);
    expect(Math.abs(out[0] ?? 1)).toBeLessThan(0.05);
    expect(Math.abs(out[out.length - 1] ?? 1)).toBeLessThan(0.05);
  });
  it('empty for zero length', () => {
    expect(renderSfx({ ...base, attack: 0, sustain: 0, decay: 0 }, RATE).length).toBe(0);
  });
});
