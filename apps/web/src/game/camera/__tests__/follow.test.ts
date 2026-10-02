import { describe, expect, it } from 'vitest';
import { followStep, type FollowInput } from '../follow';
import { centerInSafeRect, ZERO_INSETS } from '../insets';

const base: FollowInput = {
  target: { x: 400, y: 300 },
  scrollX: 0,
  scrollY: 0,
  camWidth: 800,
  camHeight: 600,
  zoom: 1,
  insets: ZERO_INSETS,
  worldW: 2000,
  worldH: 1500,
  deadzone: 0.3,
  lagMs: 180,
  dtMs: 16,
  instant: false,
};
const centred = (x: number, y: number, o: Partial<FollowInput> = {}) => {
  const c = centerInSafeRect(x, y, 800, 600, o.zoom ?? 1, o.insets ?? ZERO_INSETS);
  return { scrollX: c.scrollX, scrollY: c.scrollY };
};

describe('followStep', () => {
  it('does nothing while the target is inside the deadzone', () => {
    const s = centred(1000, 750);
    const r = followStep({ ...base, ...s, target: { x: 1050, y: 780 } });
    expect(r.moved).toBe(false);
    expect(r.scrollX).toBeCloseTo(s.scrollX);
    expect(r.scrollY).toBeCloseTo(s.scrollY);
  });

  it('instant puts the target on the nearest deadzone edge, not the centre', () => {
    const s = centred(1000, 750);
    const r = followStep({ ...base, ...s, target: { x: 1300, y: 750 }, instant: true });
    // deadzone half width = 800 * 0.3 / 2 = 120 world px
    expect(r.scrollX + 400).toBeCloseTo(1300 - 120);
    expect(r.scrollY).toBeCloseTo(s.scrollY);
    expect(r.moved).toBe(true);
  });

  it('deadzone 0 centres the target', () => {
    const r = followStep({ ...base, ...centred(1000, 750), target: { x: 1100, y: 700 }, deadzone: 0, instant: true });
    expect(r.scrollX + 400).toBeCloseTo(1100);
    expect(r.scrollY + 300).toBeCloseTo(700);
  });

  it('lag moves a fraction per step and converges', () => {
    let s = centred(1000, 750);
    const target = { x: 1100, y: 750 };
    const first = followStep({ ...base, ...s, target, deadzone: 0 });
    const a = 1 - Math.exp(-16 / 180);
    expect(first.scrollX - s.scrollX).toBeCloseTo(100 * a);
    for (let i = 0; i < 200; i++) s = followStep({ ...base, ...s, target, deadzone: 0 });
    expect(s.scrollX + 400).toBeCloseTo(1100, 1);
  });

  it('lagMs 0 is instant', () => {
    const r = followStep({ ...base, ...centred(1000, 750), target: { x: 1100, y: 750 }, deadzone: 0, lagMs: 0 });
    expect(r.scrollX + 400).toBeCloseTo(1100);
  });

  it('clamps to the world bounds', () => {
    const r = followStep({ ...base, scrollX: 500, scrollY: 400, target: { x: 5000, y: 5000 }, instant: true });
    expect(r.scrollX + 400).toBeLessThan(2000 + 24);
    expect(r.scrollY + 300).toBeLessThan(1500 + 24);
  });

  it('respects insets and zoom', () => {
    const insets = { top: 0, right: 200, bottom: 0, left: 0 };
    const s = centred(1000, 750, { zoom: 2, insets });
    const r = followStep({ ...base, ...s, zoom: 2, insets, target: { x: 1000, y: 750 }, deadzone: 0, instant: true });
    expect(r.moved).toBe(false);
  });
});
