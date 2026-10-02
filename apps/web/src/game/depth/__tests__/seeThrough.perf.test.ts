// M17 D3 perf budgets (docs/design/depth-25d.md section 8): wall-clock, so `pnpm test:perf` only.
import { describe, expect, it } from 'vitest';
import type { PlacedFurniture } from '../../procgen/types';
import { SeeThroughController, type AlphaHandle } from '../SeeThroughController';
import { buildSeeThroughIndex } from '../seeThrough';
import { SPRITE_MARGIN } from '../tables';
import type { FurnitureSprite } from '../types';

const T = 16;
const COLS = 128;
const ROWS = 96;

function median(fn: () => void, n = 9): number {
  fn();
  const s: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    s.push(performance.now() - t0);
  }
  s.sort((a, b) => a - b);
  return s[Math.floor(n / 2)]!;
}

const sprites: FurnitureSprite[] = [];
for (let i = 0; i < 1500; i++) {
  const x = (i * 7) % (COLS - 2);
  const y = 1 + ((i * 13) % (ROWS - 3));
  const item = { kind: 'bookcase', x, y, w: 1 + (i % 2), h: 1, variant: 0 } as unknown as PlacedFurniture;
  sprites.push({ item, frame: 'f', themeId: 't', x: x * T - SPRITE_MARGIN.side, y: y * T - SPRITE_MARGIN.top, baseY: (y + 1) * T, strip: null, height: 14 });
}

describe('perf budget: see-through', () => {
  it('buildSeeThroughIndex (1500 sprites) <= 2 ms', () => {
    const ms = median(() => buildSeeThroughIndex(sprites, COLS, ROWS, T));
    console.log(`[perf] buildSeeThroughIndex ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThanOrEqual(2);
  });

  it('controller update, 60 characters x 1500 sprites <= 0.2 ms', () => {
    const images: AlphaHandle[] = sprites.map(() => ({ setAlpha: () => undefined }));
    const chars = Array.from({ length: 60 }, (_, i) => ({ x: (i * 17) % (COLS * T), y: ((i * 29) % (ROWS * T)) + 10 }));
    const c = new SeeThroughController(null as never, {
      characters: () => chars,
      render: () => target,
      reducedMotion: () => false,
    });
    const target = { cols: COLS, rows: ROWS, tileSize: T, sprites, images };
    c.applySettings({ seeThrough: 0.45, seeThroughFadeMs: 160 });
    let t = 0;
    const ms = median(() => {
      for (let k = 0; k < 20; k++) c.update((t += 16), 16);
    }, 9) / 20;
    console.log(`[perf] SeeThroughController.update ${ms.toFixed(3)} ms`);
    expect(ms).toBeLessThanOrEqual(0.2);
  });
});
