import { describe, expect, it } from 'vitest';
import { SFX_CATEGORY, SFX_IDS } from '../../../game/sfxBus';
import { SFX_PRESETS } from '../presets';
import { renderSfx } from '../sfxr';

const RATE = 22050;

describe('SFX_PRESETS', () => {
  it.each([...SFX_IDS])('%s renders within limits', (id) => {
    const p = SFX_PRESETS[id];
    expect(p).toBeDefined();
    const out = renderSfx(p, RATE);
    const secs = out.length / RATE;
    expect(secs).toBeGreaterThan(0);
    expect(secs).toBeLessThanOrEqual(1.5);
    if (id === 'footstep' || id === 'typing') expect(secs).toBeLessThanOrEqual(0.08);
    if (id.startsWith('transition-')) expect(secs).toBeLessThanOrEqual(0.4);
    else if (SFX_CATEGORY[id] === 'ui') expect(secs).toBeLessThanOrEqual(0.15);
    let peak = 0;
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(SFX_CATEGORY[id] === 'ui' || id === 'transition-daynight' ? 0.35 : 0.6);
    if (id === 'ui-hover') expect(peak).toBeLessThanOrEqual(0.1);
  });
  it('has no extra ids', () => {
    expect(Object.keys(SFX_PRESETS).sort()).toEqual([...SFX_IDS].sort());
  });
});
