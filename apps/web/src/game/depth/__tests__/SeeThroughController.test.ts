import { describe, expect, it } from 'vitest';
import { HOLD_MS, SeeThroughController, type AlphaHandle, type SeeThroughHost } from '../SeeThroughController';
import { sprite } from './seeThrough.test';

const T = 16;
interface Img extends AlphaHandle { alpha: number; calls: number }
const img = (): Img => {
  const i: Img = { alpha: 1, calls: 0, setAlpha(a: number) { i.alpha = a; i.calls++; return i; } };
  return i;
};

function setup(reduced = false) {
  const sprites = [sprite(8, 5, 1, 1, 14), sprite(2, 5, 1, 1, 14)]; // baseY 96 / 96
  const images = [img(), img()];
  const chars = [{ x: 8.5 * T, y: 90, gone: false }];
  const host: SeeThroughHost = {
    characters: () => chars,
    render: () => ({ cols: 30, rows: 24, tileSize: T, sprites, images }),
    reducedMotion: () => reduced,
  };
  const c = new SeeThroughController(null as never, host);
  c.applySettings({ seeThrough: 0.45, seeThroughFadeMs: 160 });
  return { c, images, chars };
}

/** Runs frames of 16 ms from `t0` for `ms`, returns the end time. */
function run(c: SeeThroughController, t0: number, ms: number): number {
  let t = t0;
  for (; t < t0 + ms; t += 16) c.update(t, 16);
  return t;
}

describe('SeeThroughController', () => {
  it('fades only the occluder of a hidden character to seeThrough within fadeMs', () => {
    const { c, images } = setup();
    let t = run(c, 0, 16 * 4);
    expect(images[0]!.alpha).toBeLessThan(1);
    expect(images[0]!.alpha).toBeGreaterThan(0.45);
    t = run(c, t, 200);
    expect(images[0]!.alpha).toBeCloseTo(0.45, 6);
    expect(images[1]!.alpha).toBe(1);
    expect(images[1]!.calls).toBe(0);
  });

  it('holds HOLD_MS after the character leaves, then restores', () => {
    const { c, images, chars } = setup();
    let t = run(c, 0, 400);
    chars[0]!.y = 130; // walked out in front
    const leftAt = t;
    t = run(c, t, HOLD_MS - 20);
    expect(images[0]!.alpha).toBeCloseTo(0.45, 6);
    t = run(c, t, 400);
    expect(images[0]!.alpha).toBe(1);
    expect(t - leftAt).toBeGreaterThan(HOLD_MS);
  });

  it('stops touching an image once it is back at 1 and no one is behind it', () => {
    const { c, images, chars } = setup();
    let t = run(c, 0, 400);
    chars[0]!.y = 130;
    t = run(c, t, 600);
    const calls = images[0]!.calls;
    run(c, t, 400);
    expect(images[0]!.calls).toBe(calls);
  });

  it('reduced motion snaps both ways', () => {
    const { c, images, chars } = setup(true);
    c.update(0, 16);
    expect(images[0]!.alpha).toBeCloseTo(0.45, 6);
    chars[0]!.y = 130;
    c.update(50, 16);
    expect(images[0]!.alpha).toBeCloseTo(0.45, 6);
    c.update(50 + HOLD_MS + 1, 16);
    expect(images[0]!.alpha).toBe(1);
  });

  it('seeThrough = 1 restores everything and then never touches an alpha', () => {
    const { c, images } = setup();
    run(c, 0, 400);
    c.applySettings({ seeThrough: 1, seeThroughFadeMs: 160 });
    expect(images[0]!.alpha).toBe(1);
    const calls = images.map((i) => i.calls);
    run(c, 1000, 400);
    expect(images.map((i) => i.calls)).toEqual(calls);
    c.applySettings({ seeThrough: 0.5, seeThroughFadeMs: 0 });
    c.update(2000, 16);
    expect(images[0]!.alpha).toBe(0.5);
  });

  it('gone characters are ignored and a rebuilt floor resets without touching old images', () => {
    const { c, images, chars } = setup();
    chars[0]!.gone = true;
    run(c, 0, 200);
    expect(images[0]!.calls).toBe(0);
    chars[0]!.gone = false;
    run(c, 300, 300);
    const calls = images[0]!.calls;
    expect(calls).toBeGreaterThan(0);
    c.destroy();
    expect(images[0]!.alpha).toBe(1);
  });
});
