import { describe, expect, it } from 'vitest';
import {
  AUTO_QUALITY_WINDOW_MS,
  createAutoQualityState,
  effectiveQuality,
  maxLightsForQuality,
  resolveAutoQuality,
  sampleAutoQuality,
} from '../quality';

function feed(deltaMs: number, totalMs: number) {
  let state = createAutoQualityState();
  for (let elapsed = 0; elapsed < totalMs; elapsed += deltaMs) state = sampleAutoQuality(state, deltaMs);
  return state;
}

describe('auto quality measurement', () => {
  it('stays unresolved before the measurement window closes', () => {
    const state = feed(16, AUTO_QUALITY_WINDOW_MS - 100);
    expect(resolveAutoQuality(state)).toBeNull();
  });

  it('resolves to high once the window closes at a healthy frame rate (60fps)', () => {
    const state = feed(16.6, AUTO_QUALITY_WINDOW_MS + 50);
    expect(resolveAutoQuality(state)).toBe('high');
  });

  it('resolves to low when most frames blow the budget (e.g. 20fps)', () => {
    const state = feed(50, AUTO_QUALITY_WINDOW_MS + 50);
    expect(resolveAutoQuality(state)).toBe('low');
  });

  it('tolerates occasional slow frames without dropping to low', () => {
    let state = createAutoQualityState();
    for (let i = 0; i < 150; i++) {
      // one slow frame every 10 (10%), well under the 35% ratio
      state = sampleAutoQuality(state, i % 10 === 0 ? 40 : 16);
    }
    expect(state.elapsedMs).toBeGreaterThan(AUTO_QUALITY_WINDOW_MS);
    expect(resolveAutoQuality(state)).toBe('high');
  });
});

describe('effectiveQuality', () => {
  it('passes through an explicit low/high regardless of measurement', () => {
    expect(effectiveQuality('low', 'high')).toBe('low');
    expect(effectiveQuality('high', 'low')).toBe('high');
  });

  it('optimistically renders high while auto is still measuring', () => {
    expect(effectiveQuality('auto', null)).toBe('high');
  });

  it('adopts the measured tier once auto resolves', () => {
    expect(effectiveQuality('auto', 'low')).toBe('low');
    expect(effectiveQuality('auto', 'high')).toBe('high');
  });
});

describe('maxLightsForQuality', () => {
  it('caps low quality well below high quality', () => {
    expect(maxLightsForQuality('low')).toBe(48);
    expect(maxLightsForQuality('high')).toBeGreaterThan(maxLightsForQuality('low'));
  });
});
