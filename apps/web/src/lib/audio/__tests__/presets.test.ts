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
  it('battle presets meet the design durations', () => {
    const secs = (id: (typeof SFX_IDS)[number]) => renderSfx(SFX_PRESETS[id], RATE).length / RATE;
    expect(secs('battle-swirl')).toBeCloseTo(0.65, 1);
    expect(secs('battle-return')).toBeCloseTo(0.3, 1);
    expect(secs('battle-sting')).toBeLessThanOrEqual(0.2);
    expect(secs('battle-text')).toBeLessThanOrEqual(0.03);
    for (const id of ['battle-victory', 'battle-defeat', 'battle-level-up'] as const) expect(secs(id)).toBeLessThanOrEqual(1.5);
    for (const id of ['battle-hit', 'battle-hit-super', 'battle-hit-weak', 'battle-crit', 'battle-miss'] as const) expect(secs(id)).toBeLessThanOrEqual(0.25);
  });
  it('has no extra ids', () => {
    expect(Object.keys(SFX_PRESETS).sort()).toEqual([...SFX_IDS].sort());
  });
});
