import { describe, expect, it } from 'vitest';
import { stageLayout } from '../stageLayout';

const cases: [number, number, number][] = [[375, 667, 293], [375, 667, 0], [1920, 1080, 240], [1920, 1080, 0], [320, 480, 211]];

describe('stageLayout', () => {
  it.each(cases)('keeps everything inside the stage at %ix%i (inset %i)', (w, h, inset) => {
    const l = stageLayout(w, h, inset);
    const stageH = h - inset;
    expect(l.stageH).toBe(stageH);
    for (const e of [l.enemyPlatform, l.heroPlatform]) {
      expect(e.cx - e.rx).toBeGreaterThanOrEqual(0);
      expect(e.cx + e.rx).toBeLessThanOrEqual(w);
      expect(e.cy - e.ry).toBeGreaterThanOrEqual(0);
      expect(e.cy + e.ry).toBeLessThanOrEqual(stageH);
    }
    // The enemy's head stays on screen, the hero is bottom-left and the enemy top-right.
    expect(l.enemy.y - 28 * l.enemy.scale).toBeGreaterThanOrEqual(0);
    expect(l.hero.y).toBeLessThanOrEqual(stageH);
    expect(l.enemy.x).toBeGreaterThan(l.hero.x);
    expect(l.enemy.y).toBeLessThan(l.hero.y);
    for (const p of [l.dmgAnchor.enemy, l.dmgAnchor.hero]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(w);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses integer scales within range', () => {
    for (const [w, h, inset] of cases) {
      const l = stageLayout(w, h, inset);
      expect(Number.isInteger(l.hero.scale) && l.hero.scale >= 2 && l.hero.scale <= 6).toBe(true);
      expect(Number.isInteger(l.enemy.scale) && l.enemy.scale >= 1 && l.enemy.scale <= 7).toBe(true);
    }
  });

  it('survives a degenerate inset', () => {
    expect(stageLayout(100, 100, 500).stageH).toBe(1);
  });
});
