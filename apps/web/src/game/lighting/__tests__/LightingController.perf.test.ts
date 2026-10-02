// M16 L4: the per-frame cost of the controller against a no-op stub scene (wall-clock; `pnpm test:perf` only).
import { describe, expect, it, vi } from 'vitest';
import { SettingsSchema } from '@tagconn/shared';
import { LightingController, type LightingHost, type ShadowCaster } from '../LightingController';
import { furn, mapFrom, walledRows } from './lightingFixtures';

vi.mock('../../postfx/glowTexture', () => ({ ensureLightGlowTexture: () => undefined, LIGHT_GLOW_TEXTURE: 'glow', LIGHT_GLOW_REFERENCE_RADIUS: 32 }));

const noop = new Proxy({}, { get: () => () => noop }) as never;
const scene = { sys: { game: { renderer: { getMaxTextureSize: () => 4096 } } }, add: { renderTexture: () => noop, graphics: () => noop, rectangle: () => noop, container: () => noop, image: () => noop }, make: { graphics: () => noop } } as never;

describe('LightingController.update', () => {
  it('60 characters, steady state, stays under 1 ms per frame (median)', () => {
    const map = mapFrom(walledRows(30, 20), { furniture: [furn('bookcase', 3, 3, 2, 1)], lights: [{ x: 10, y: 8, reachTiles: 6, roomId: 'r1' }] });
    const casters: ShadowCaster[] = Array.from({ length: 60 }, (_, i) => ({ x: 40 + i * 6, y: 90 + (i % 7) * 12, setCastShadow: () => undefined }));
    const host: LightingHost = {
      map: () => map, theme: () => ({ id: 'modern', lighting: { dayTint: 0xffffff, nightTint: 0x0b1030, nightAlpha: 0.4, glowAtNight: true } }) as never,
      regions: () => [], style: () => 'modern', characters: () => casters, quality: () => 'high', webgl: () => true, reducedMotion: () => false,
      now: () => 1_700_000_000_000, onPhase: () => undefined,
    };
    const c = new LightingController(scene, host);
    const o = SettingsSchema.parse({}).office;
    c.applySettings(o, { skewMs: 0, tzOffsetMin: 0, measuredAt: 0 }, undefined);
    for (let i = 0; i < 50; i++) c.update(i * 16, 16);
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const a = performance.now();
      c.update(i * 16, 16);
      samples.push(performance.now() - a);
    }
    samples.sort((x, y) => x - y);
    expect(samples[100]!).toBeLessThan(1);
  });
});
