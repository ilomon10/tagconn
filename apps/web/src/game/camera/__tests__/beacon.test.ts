import { describe, expect, it } from 'vitest';
import { beaconScale, edgeArrowPlacement, worldToScreen } from '../beacon';
import { screenToWorld } from './phaserCameraModel';

describe('beaconScale', () => {
  it('is 1 at and above zoom 1', () => {
    expect(beaconScale(1)).toBe(1);
    expect(beaconScale(3)).toBe(1);
  });

  it('keeps a constant screen size when zoomed out, with no cap', () => {
    expect(beaconScale(0.5)).toBe(2);
    expect(beaconScale(0.2)).toBeCloseTo(5, 5);
    expect(beaconScale(0.05)).toBeCloseTo(20, 5);
  });

  it('survives a nonsense zoom', () => {
    expect(beaconScale(0)).toBe(1);
    expect(beaconScale(NaN)).toBe(1);
  });
});

describe('worldToScreen', () => {
  it('inverts the Phaser camera model', () => {
    const cam = { scrollX: 40, scrollY: -20, zoom: 0.5, camWidth: 800, camHeight: 600 };
    const s = worldToScreen(cam, 123, 77);
    const back = screenToWorld(cam, s.x, s.y);
    expect(back.x).toBeCloseTo(123, 5);
    expect(back.y).toBeCloseTo(77, 5);
  });
});

describe('edgeArrowPlacement', () => {
  const safe = { x: 0, y: 0, w: 800, h: 600 };

  it('is not offscreen for a point inside the safe rect', () => {
    expect(edgeArrowPlacement(400, 300, safe, 20).offscreen).toBe(false);
  });

  it('pins to the right edge for a target far to the right', () => {
    const a = edgeArrowPlacement(2000, 300, safe, 20);
    expect(a.offscreen).toBe(true);
    expect(a.x).toBeCloseTo(780, 5);
    expect(a.y).toBeCloseTo(300, 5);
    expect(a.angle).toBeCloseTo(0, 5);
  });

  it('pins to the top edge for a target above', () => {
    const a = edgeArrowPlacement(400, -900, safe, 20);
    expect(a.x).toBeCloseTo(400, 5);
    expect(a.y).toBeCloseTo(20, 5);
    expect(a.angle).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('lands on a corner for a diagonal target and stays inside the margin box', () => {
    const a = edgeArrowPlacement(-5000, 5000, safe, 20);
    expect(a.x).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(a.y).toBeLessThanOrEqual(580 + 1e-6);
  });

  it('respects safe insets (an overlay on the left shifts the pin point)', () => {
    const inset = { x: 300, y: 0, w: 500, h: 600 };
    const a = edgeArrowPlacement(-100, 300, inset, 20);
    expect(a.offscreen).toBe(true);
    expect(a.x).toBeCloseTo(320, 5);
  });
});
