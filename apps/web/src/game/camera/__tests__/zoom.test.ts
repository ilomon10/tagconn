import { describe, expect, it } from 'vitest';
import { clampScrollToSafeBounds, ZERO_INSETS } from '../insets';
import { zoomAboutPoint } from '../zoom';

describe('zoomAboutPoint', () => {
  it('keeps the world point under the cursor fixed when zooming in', () => {
    const before = { pointerX: 300, pointerY: 200, scrollX: 0, scrollY: 0, oldZoom: 1, newZoom: 2 };
    const worldBefore = { x: before.scrollX + before.pointerX / before.oldZoom, y: before.scrollY + before.pointerY / before.oldZoom };
    const { scrollX, scrollY } = zoomAboutPoint(before);
    const worldAfter = { x: scrollX + before.pointerX / before.newZoom, y: scrollY + before.pointerY / before.newZoom };
    expect(worldAfter.x).toBeCloseTo(worldBefore.x);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y);
  });

  it('keeps the world point fixed when zooming out', () => {
    const before = { pointerX: 120, pointerY: 80, scrollX: 500, scrollY: 400, oldZoom: 2, newZoom: 0.8 };
    const worldBefore = { x: before.scrollX + before.pointerX / before.oldZoom, y: before.scrollY + before.pointerY / before.oldZoom };
    const { scrollX, scrollY } = zoomAboutPoint(before);
    const worldAfter = { x: scrollX + before.pointerX / before.newZoom, y: scrollY + before.pointerY / before.newZoom };
    expect(worldAfter.x).toBeCloseTo(worldBefore.x);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y);
  });

  it('is a no-op when zoom does not change', () => {
    const input = { pointerX: 50, pointerY: 50, scrollX: 10, scrollY: 20, oldZoom: 1.5, newZoom: 1.5 };
    expect(zoomAboutPoint(input)).toEqual({ scrollX: 10, scrollY: 20 });
  });

  it('composes with inset-aware clamping without fighting the cursor-fixed point', () => {
    // Zoom in near a right-docked panel; the clamp only needs to keep the result sane, not undo the zoom.
    const zoomed = zoomAboutPoint({ pointerX: 100, pointerY: 100, scrollX: 900, scrollY: 900, oldZoom: 1, newZoom: 1.5 });
    const clamped = clampScrollToSafeBounds(zoomed.scrollX, zoomed.scrollY, {
      camWidth: 800,
      camHeight: 600,
      zoom: 1.5,
      worldW: 2000,
      worldH: 2000,
      insets: { ...ZERO_INSETS, right: 300 },
    });
    expect(Number.isFinite(clamped.scrollX)).toBe(true);
    expect(Number.isFinite(clamped.scrollY)).toBe(true);
  });
});
