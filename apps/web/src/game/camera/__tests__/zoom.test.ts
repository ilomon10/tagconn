import { describe, expect, it } from 'vitest';
import { clampScrollToSafeBounds, ZERO_INSETS } from '../insets';
import { fixedPositionForScreenPoint, zoomAboutPoint, zoomCameraAboutPoint } from '../zoom';
import { screenToWorld } from './phaserCameraModel';

/** Phaser's own render matrix for a `setScrollFactor(0)` object (see `zoom.ts`'s doc comment and
 *  `Camera#preRender` / `GetCalcMatrix`): scales the object's `x`/`y` about the viewport center. */
function forwardScreenPoint(objX: number, objY: number, zoom: number, camWidth: number, camHeight: number): { x: number; y: number } {
  return {
    x: camWidth / 2 + (objX - camWidth / 2) * zoom,
    y: camHeight / 2 + (objY - camHeight / 2) * zoom,
  };
}

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

describe('zoomCameraAboutPoint', () => {
  const CAM = { camWidth: 800, camHeight: 600 };

  it('keeps the world point under the cursor fixed when zooming in', () => {
    const before = { pointerX: 300, pointerY: 200, scrollX: 0, scrollY: 0, oldZoom: 1, newZoom: 2, ...CAM };
    const worldBefore = screenToWorld({ scrollX: before.scrollX, scrollY: before.scrollY, zoom: before.oldZoom, ...CAM }, before.pointerX, before.pointerY);
    const { scrollX, scrollY } = zoomCameraAboutPoint(before);
    const worldAfter = screenToWorld({ scrollX, scrollY, zoom: before.newZoom, ...CAM }, before.pointerX, before.pointerY);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y);
  });

  it('is a no-op when zoom does not change', () => {
    const input = { pointerX: 50, pointerY: 50, scrollX: 10, scrollY: 20, oldZoom: 1.5, newZoom: 1.5, ...CAM };
    expect(zoomCameraAboutPoint(input)).toEqual({ scrollX: 10, scrollY: 20 });
  });

  // Regression: the office scene used to call the plain `zoomAboutPoint` (no `camWidth/2`
  // correction), which only kept the cursor's point fixed when zooming exactly at the viewport's
  // center — never true for a real mouse wheel. Sweep zoom pairs and off-center pointers.
  const zoomPairs: [number, number][] = [
    [1, 2],
    [1, 0.5],
    [0.5, 4],
    [4, 8],
    [8, 1],
  ];
  const pointers = [
    { pointerX: 0, pointerY: 0 }, // the far corner from center
    { pointerX: 700, pointerY: 500 }, // off-center, near the opposite corner
    { pointerX: 400, pointerY: 300 }, // dead center — the one case the plain formula also gets right
  ];
  for (const [oldZoom, newZoom] of zoomPairs) {
    for (const { pointerX, pointerY } of pointers) {
      it(`keeps (${pointerX}, ${pointerY}) fixed zooming ${oldZoom} -> ${newZoom}`, () => {
        const before = { pointerX, pointerY, scrollX: 133, scrollY: -47, oldZoom, newZoom, ...CAM };
        const worldBefore = screenToWorld({ scrollX: before.scrollX, scrollY: before.scrollY, zoom: oldZoom, ...CAM }, pointerX, pointerY);
        const { scrollX, scrollY } = zoomCameraAboutPoint(before);
        const worldAfter = screenToWorld({ scrollX, scrollY, zoom: newZoom, ...CAM }, pointerX, pointerY);
        expect(worldAfter.x).toBeCloseTo(worldBefore.x);
        expect(worldAfter.y).toBeCloseTo(worldBefore.y);
      });
    }
  }

  it('composes with inset-aware clamping without fighting the cursor-fixed point', () => {
    const zoomed = zoomCameraAboutPoint({ pointerX: 100, pointerY: 100, scrollX: 900, scrollY: 900, oldZoom: 1, newZoom: 1.5, ...CAM });
    const clamped = clampScrollToSafeBounds(zoomed.scrollX, zoomed.scrollY, {
      ...CAM,
      zoom: 1.5,
      worldW: 2000,
      worldH: 2000,
      insets: { ...ZERO_INSETS, right: 300 },
    });
    expect(Number.isFinite(clamped.scrollX)).toBe(true);
    expect(Number.isFinite(clamped.scrollY)).toBe(true);
  });
});

describe('fixedPositionForScreenPoint', () => {
  const CAM = { camWidth: 800, camHeight: 600 };

  it('is the identity at zoom 1', () => {
    expect(fixedPositionForScreenPoint({ screenX: 234, screenY: 88, zoom: 1, ...CAM })).toEqual({ x: 234, y: 88 });
  });

  it('leaves the viewport center fixed regardless of zoom', () => {
    for (const zoom of [0.4, 1, 2, 6]) {
      expect(fixedPositionForScreenPoint({ screenX: CAM.camWidth / 2, screenY: CAM.camHeight / 2, zoom, ...CAM })).toEqual({
        x: CAM.camWidth / 2,
        y: CAM.camHeight / 2,
      });
    }
  });

  // Regression: an object with `setScrollFactor(0)` still scales about the viewport center under
  // Phaser's camera matrix (see `zoom.ts`'s doc comment) — so naively positioning it at the pointer
  // renders it offset once the camera is zoomed. Round-trip against the forward formula (what
  // Phaser's own render matrix does to an object's x/y) to prove the exact inverse holds.
  const zooms = [0.5, 2];
  const points = [
    { screenX: 0, screenY: 0 },
    { screenX: 700, screenY: 500 },
    { screenX: 400, screenY: 300 },
    { screenX: 133, screenY: 587 },
  ];
  for (const zoom of zooms) {
    for (const { screenX, screenY } of points) {
      it(`round-trips (${screenX}, ${screenY}) at zoom ${zoom}`, () => {
        const obj = fixedPositionForScreenPoint({ screenX, screenY, zoom, ...CAM });
        const rendered = forwardScreenPoint(obj.x, obj.y, zoom, CAM.camWidth, CAM.camHeight);
        expect(rendered.x).toBeCloseTo(screenX);
        expect(rendered.y).toBeCloseTo(screenY);
      });
    }
  }
});
