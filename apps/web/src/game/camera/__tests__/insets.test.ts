import { describe, expect, it } from 'vitest';
import { ZERO_INSETS, centerInSafeRect, clampScrollToSafeBounds, insetsFromOverlay, safeViewportRect } from '../insets';

describe('safeViewportRect', () => {
  it('subtracts each edge inset from the camera rect', () => {
    expect(safeViewportRect(800, 600, { top: 10, right: 20, bottom: 30, left: 40 })).toEqual({ x: 40, y: 10, w: 740, h: 560 });
  });

  it('is the full rect when insets are zero', () => {
    expect(safeViewportRect(800, 600, ZERO_INSETS)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('never collapses to a non-positive size', () => {
    const r = safeViewportRect(100, 100, { top: 0, right: 90, bottom: 0, left: 90 });
    expect(r.w).toBeGreaterThan(0);
  });
});

describe('clampScrollToSafeBounds', () => {
  const base = { camWidth: 800, camHeight: 600, zoom: 1, worldW: 2000, worldH: 2000, insets: ZERO_INSETS, margin: 0 };

  it('centers a world smaller than the safe rect', () => {
    const { scrollX, scrollY } = clampScrollToSafeBounds(9999, 9999, { ...base, worldW: 100, worldH: 100 });
    // World center (50,50) should land at the safe rect center (400,300) at zoom 1.
    expect(scrollX).toBeCloseTo(50 - 400);
    expect(scrollY).toBeCloseTo(50 - 300);
  });

  it('matches the classic full-viewport clamp when insets are zero (left edge -> scroll 0)', () => {
    const { scrollX } = clampScrollToSafeBounds(-9999, 0, base);
    expect(scrollX).toBeCloseTo(0);
  });

  it('lets the camera pan further toward an obscured edge, by exactly the inset amount', () => {
    // A right-docked panel eats 300px off the safe rect. At the far-right pan limit, the camera
    // must be able to scroll `300 / zoom` further than with no panel, so that content that used to
    // be hidden behind it can be dragged into the visible strip.
    const withoutPanel = clampScrollToSafeBounds(99999, 0, base);
    const withPanel = clampScrollToSafeBounds(99999, 0, { ...base, insets: { ...ZERO_INSETS, right: 300 } });
    expect(withPanel.scrollX - withoutPanel.scrollX).toBeCloseTo(300);
  });

  it('symmetrically expands the left/top pan limit for left/top insets', () => {
    const withoutPanel = clampScrollToSafeBounds(-99999, -99999, base);
    const withPanel = clampScrollToSafeBounds(-99999, -99999, { ...base, insets: { top: 50, left: 120, right: 0, bottom: 0 } });
    expect(withoutPanel.scrollX - withPanel.scrollX).toBeCloseTo(120);
    expect(withoutPanel.scrollY - withPanel.scrollY).toBeCloseTo(50);
  });

  it('applies the margin beyond the world edges', () => {
    const { scrollX } = clampScrollToSafeBounds(-99999, 0, { ...base, margin: 24 });
    expect(scrollX).toBeCloseTo(-24);
  });
});

describe('centerInSafeRect', () => {
  it('centers a point in the full rect when there are no insets', () => {
    const { scrollX, scrollY } = centerInSafeRect(500, 400, 800, 600, 1, ZERO_INSETS);
    expect(scrollX).toBeCloseTo(500 - 400);
    expect(scrollY).toBeCloseTo(400 - 300);
  });

  it('centers a point in the safe rect, offset away from a right-docked panel', () => {
    const insets = { ...ZERO_INSETS, right: 300 };
    const { scrollX } = centerInSafeRect(500, 400, 800, 600, 1, insets);
    // Safe rect is [0, 500] wide; its center (250) should land on world x 500.
    expect(scrollX).toBeCloseTo(500 - 250);
  });

  it('accounts for zoom', () => {
    const { scrollX, scrollY } = centerInSafeRect(500, 400, 800, 600, 2, ZERO_INSETS);
    expect(scrollX).toBeCloseTo(500 - 200);
    expect(scrollY).toBeCloseTo(400 - 150);
  });
});

describe('insetsFromOverlay', () => {
  const container = { top: 0, left: 0, right: 1000, bottom: 800 };

  it('reads a right-docked panel as a right inset', () => {
    const overlay = { top: 0, left: 680, right: 1000, bottom: 800 };
    expect(insetsFromOverlay(container, overlay)).toEqual({ ...ZERO_INSETS, right: 320 });
  });

  it('reads a bottom sheet as a bottom inset', () => {
    const overlay = { top: 500, left: 0, right: 1000, bottom: 800 };
    expect(insetsFromOverlay(container, overlay)).toEqual({ ...ZERO_INSETS, bottom: 300 });
  });

  it('reads a left toolbar as a left inset', () => {
    const overlay = { top: 0, left: 0, right: 200, bottom: 800 };
    expect(insetsFromOverlay(container, overlay)).toEqual({ ...ZERO_INSETS, left: 200 });
  });

  it('ignores an overlay that does not span a whole edge', () => {
    const overlay = { top: 300, left: 700, right: 900, bottom: 500 };
    expect(insetsFromOverlay(container, overlay)).toEqual(ZERO_INSETS);
  });

  it('tolerates sub-pixel slop at the touching edges', () => {
    const overlay = { top: -0.4, left: 700, right: 1000.3, bottom: 800.2 };
    expect(insetsFromOverlay(container, overlay).right).toBeCloseTo(300);
  });
});
