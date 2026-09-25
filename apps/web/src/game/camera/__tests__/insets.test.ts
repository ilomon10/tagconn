import { describe, expect, it } from 'vitest';
import { ZERO_INSETS, centerInSafeRect, clampScrollToSafeBounds, insetsFromOverlay, safeViewportRect, type SafeInsets } from '../insets';
import { centerOn, screenToWorld } from './phaserCameraModel';

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

  // Regression for the "Fit" bug: `fitCamera` calls Phaser's own (zoom-independent) `cam.centerOn`
  // and then `clampCamera`. When the world exactly fills the safe rect (as it does right at the fit
  // zoom — a 128x96 layout in an 800x600 viewport hits this at zoom ~0.39), the clamp's pan bounds
  // collapse to a single point, so its result depends *entirely* on getting the world-point-at-the-
  // safe-rect-center conversion right — this is what actually exposed the bug: a stale formula that
  // divided the whole conversion by zoom (instead of just the part beyond the viewport's own,
  // zoom-independent center) landed on the wrong point and silently un-centered the map.
  for (const zoom of [1, 0.5, 4, 8]) {
    it(`reconstructs the exact center when the world fills the safe rect, at zoom ${zoom}`, () => {
      const worldW = base.camWidth / zoom; // world == safe rect exactly -> clamp bounds collapse to a point
      const worldH = base.camHeight / zoom;
      const centered = centerOn(base.camWidth, base.camHeight, worldW / 2, worldH / 2);
      const clamped = clampScrollToSafeBounds(0, 0, { ...base, zoom, worldW, worldH }); // any input scroll -> same forced result
      expect(clamped.scrollX).toBeCloseTo(centered.scrollX);
      expect(clamped.scrollY).toBeCloseTo(centered.scrollY);
    });
  }

  it('collapses to the safe rect (not the raw viewport) center when insets are open, at a high zoom', () => {
    const insets = { ...ZERO_INSETS, right: 300 };
    const zoom = 6;
    const safe = safeViewportRect(base.camWidth, base.camHeight, insets);
    const worldW = safe.w / zoom;
    const worldH = safe.h / zoom;
    const wantScroll = centerInSafeRect(worldW / 2, worldH / 2, base.camWidth, base.camHeight, zoom, insets);
    const clamped = clampScrollToSafeBounds(0, 0, { ...base, zoom, worldW, worldH, insets });
    expect(clamped.scrollX).toBeCloseTo(wantScroll.scrollX);
    expect(clamped.scrollY).toBeCloseTo(wantScroll.scrollY);
  });

  it('a 128x96 layout (2048x1536 world px at the 16px tile size) fits and centers in an 800x600 viewport', () => {
    // The exact repro from the bug report: same aspect ratio as the viewport (4:3), so both axes
    // hit their fit-zoom bound together — a 128x96 layout is where the crop was "dramatic".
    const worldW = 128 * 16;
    const worldH = 96 * 16;
    const fitZoom = Math.min(base.camWidth / worldW, base.camHeight / worldH);
    const centered = centerOn(base.camWidth, base.camHeight, worldW / 2, worldH / 2);
    const clamped = clampScrollToSafeBounds(centered.scrollX, centered.scrollY, { ...base, zoom: fitZoom, worldW, worldH });
    expect(clamped.scrollX).toBeCloseTo(centered.scrollX);
    expect(clamped.scrollY).toBeCloseTo(centered.scrollY);
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

  // Regression for the M7 bug: at zoom !== 1, a stale formula divided the *whole* screen-center
  // offset by zoom, instead of just the delta beyond the viewport's own (zoom-independent) center.
  // With zero insets the safe rect *is* the viewport, so this must match Phaser's own
  // `Camera#centerOn` exactly, at every zoom — that's the case `focusAgent`'s "6-8x zoom centers on
  // the wrong place" bug was really hitting.
  for (const zoom of [1, 0.5, 4, 8]) {
    it(`matches Phaser's own centerOn with no insets, at zoom ${zoom}`, () => {
      const camWidth = 800;
      const camHeight = 600;
      const got = centerInSafeRect(500, 400, camWidth, camHeight, zoom, ZERO_INSETS);
      const want = centerOn(camWidth, camHeight, 500, 400);
      expect(got.scrollX).toBeCloseTo(want.scrollX);
      expect(got.scrollY).toBeCloseTo(want.scrollY);
    });
  }

  // With insets, only the part of the safe-rect center beyond the viewport's own center is a real
  // screen-space distance — verified against the pure Phaser model by round-tripping: scroll to
  // center world point (x, y) in the safe rect, then read back the world point Phaser would show at
  // the safe rect's own screen center. It must be (x, y) again, at every zoom.
  const insetCases: { label: string; insets: SafeInsets }[] = [
    { label: 'no insets', insets: ZERO_INSETS },
    { label: 'a right-docked panel', insets: { ...ZERO_INSETS, right: 300 } },
    { label: 'a bottom sheet', insets: { ...ZERO_INSETS, bottom: 200 } },
    { label: 'top + left insets', insets: { top: 50, left: 120, right: 0, bottom: 0 } },
  ];
  for (const zoom of [1, 0.5, 4, 8]) {
    for (const { label, insets } of insetCases) {
      it(`round-trips through the safe rect's screen center at zoom ${zoom} (${label})`, () => {
        const camWidth = 800;
        const camHeight = 600;
        const x = 500;
        const y = 400;
        const { scrollX, scrollY } = centerInSafeRect(x, y, camWidth, camHeight, zoom, insets);
        const safe = safeViewportRect(camWidth, camHeight, insets);
        const back = screenToWorld({ scrollX, scrollY, zoom, camWidth, camHeight }, safe.x + safe.w / 2, safe.y + safe.h / 2);
        expect(back.x).toBeCloseTo(x);
        expect(back.y).toBeCloseTo(y);
      });
    }
  }
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
