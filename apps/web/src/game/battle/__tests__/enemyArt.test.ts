import { BATTLE_NPC_KINDS } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { makeFakeScene } from '../../themes/__tests__/testUtils';
import { withOutline } from '../../textures';
import { BATTLE_STYLES, ENEMY_KINDS, ENEMY_MAX_H, ENEMY_MAX_W, enemyBitmaps, enemySize, enemyTextureKey, paintEnemyCanvas, paintEnemyTexture } from '../enemyArt';

const cells = ENEMY_KINDS.flatMap((k) => BATTLE_STYLES.map((s) => [k, s] as const));

describe('enemy art', () => {
  it('covers exactly the battle npc kinds', () => {
    expect([...ENEMY_KINDS].sort()).toEqual([...BATTLE_NPC_KINDS].sort());
  });

  it.each(cells)('%s/%s: two frames of equal size, palette-only, within bounds', (kind, style) => {
    const frames = enemyBitmaps(kind, style);
    expect(frames).toHaveLength(2);
    for (const f of frames) {
      const rows = withOutline(f);
      expect(rows.length).toBeLessThanOrEqual(ENEMY_MAX_H);
      expect(Math.max(...rows.map((r) => r.length))).toBeLessThanOrEqual(ENEMY_MAX_W);
      for (const r of f.rows) for (const ch of r) if (ch !== ' ') expect(f.palette[ch], `${kind}/${style} '${ch}'`).toBeDefined();
      expect(f.rows[f.rows.length - 1]!.trim().length).toBeGreaterThan(0);
    }
    expect(frames[0].rows.length).toBe(frames[1].rows.length);
    expect(Math.max(...frames[0].rows.map((r) => r.length))).toBe(Math.max(...frames[1].rows.map((r) => r.length)));
    expect(frames[0].rows.join('\n')).not.toEqual(frames[1].rows.join('\n'));
  });

  it('styles look different for every kind', () => {
    for (const k of ENEMY_KINDS) {
      const sig = BATTLE_STYLES.map((s) => JSON.stringify(enemyBitmaps(k, s)[0]));
      expect(new Set(sig).size, k).toBe(3);
    }
  });

  it.each(cells)('%s/%s: paintEnemyTexture paints both frames, idempotently', (kind, style) => {
    const { scene } = makeFakeScene();
    paintEnemyTexture(scene, kind, style);
    expect(() => paintEnemyTexture(scene, kind, style)).not.toThrow();
    for (const f of [0, 1] as const) expect(scene.textures.exists(enemyTextureKey(kind, style, f))).toBe(true);
  });

  it.each(cells)('%s/%s: paintEnemyCanvas draws non-empty pixels inside the returned size', (kind, style) => {
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const ctx = { fillStyle: '', fillRect: (x: number, y: number, w: number, h: number) => void rects.push({ x, y, w, h }) };
    const size = paintEnemyCanvas(ctx, kind, style, 3);
    expect(rects.length).toBeGreaterThan(20);
    expect(size).toEqual({ w: enemySize(kind, style).w * 3, h: enemySize(kind, style).h * 3 });
    for (const r of rects) {
      expect(r.x + r.w).toBeLessThanOrEqual(size.w);
      expect(r.y + r.h).toBeLessThanOrEqual(size.h);
    }
  });
});
