import { describe, expect, it } from 'vitest';
import { counterScale, labelVisible } from '../lod';

describe('labelVisible', () => {
  it('shows everything once zoomed in past the threshold', () => {
    expect(labelVisible({ zoom: 1, minZoom: 0.8, important: false })).toBe(true);
    expect(labelVisible({ zoom: 0.8, minZoom: 0.8, important: false })).toBe(true);
  });

  it('hides ordinary characters once zoomed out past the threshold', () => {
    expect(labelVisible({ zoom: 0.5, minZoom: 0.8, important: false })).toBe(false);
  });

  it('keeps important characters (selected, waiting/blocked, hovered) visible regardless of zoom', () => {
    expect(labelVisible({ zoom: 0.1, minZoom: 0.8, important: true })).toBe(true);
  });

  it('a labelMinZoom of 0 never hides anything', () => {
    expect(labelVisible({ zoom: 0.01, minZoom: 0, important: false })).toBe(true);
  });
});

describe('counterScale', () => {
  it('is 1 at zoom 1 (baseline, no correction needed)', () => {
    expect(counterScale(1)).toBe(1);
  });

  it('grows as the camera zooms out, to keep the on-screen size constant', () => {
    expect(counterScale(0.5)).toBe(2);
    expect(counterScale(0.4)).toBeCloseTo(2.5, 5); // 1/0.4 = 2.5, right at the default maxScale
  });

  it('never shrinks below 1 when zoomed in — labels get bigger on their own already', () => {
    expect(counterScale(2)).toBe(1);
    expect(counterScale(4)).toBe(1);
  });

  it('is capped so an extreme zoom-out cannot inflate a label without bound', () => {
    expect(counterScale(0.01, 3)).toBe(3);
  });
});
