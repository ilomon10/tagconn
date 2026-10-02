// M16 L4 (test 11): the controller against a recording stub scene (no Phaser, no WebGL).
import { describe, expect, it, vi } from 'vitest';
import { SettingsSchema } from '@tagconn/shared';
import type { ClockSync } from '../clock';
import { MIN_BAKE_INTERVAL_MS } from '../clock';
import { LightingController, resolveLightingMode, type LightingHost, type ShadowCaster } from '../LightingController';
import type { CastShadow } from '../types';
import { mapFrom, walledRows, furn } from './lightingFixtures';

vi.mock('../../postfx/glowTexture', () => ({ ensureLightGlowTexture: () => undefined, LIGHT_GLOW_TEXTURE: 'glow', LIGHT_GLOW_REFERENCE_RADIUS: 32 }));

/** A chainable recording object: every method returns itself and logs its name. */
function node(log: Record<string, number>, kind: string): unknown {
  const target: Record<string, unknown> = { visible: true, texture: { setFilter: () => undefined } };
  const proxy: unknown = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        log[`${kind}.${prop}`] = (log[`${kind}.${prop}`] ?? 0) + 1;
        if (prop === 'setVisible') t['visible'] = args[0];
        return proxy;
      };
    },
  });
  return proxy;
}

function stubScene(maxTexture = 4096) {
  const log: Record<string, number> = {};
  const scene = {
    sys: { game: { renderer: { getMaxTextureSize: () => maxTexture } } },
    add: {
      renderTexture: () => (log['renderTexture'] = (log['renderTexture'] ?? 0) + 1, node(log, 'rt')),
      graphics: () => node(log, 'g'),
      rectangle: () => (log['rectangle'] = (log['rectangle'] ?? 0) + 1, node(log, 'rect')),
      container: () => node(log, 'box'),
      image: () => node(log, 'img'),
    },
    make: { graphics: () => node(log, 'g') },
  };
  return { scene: scene as never, log };
}

const settings = SettingsSchema.parse({});
const lighting = (over: Record<string, unknown> = {}) => ({ ...settings.office, lighting: { ...settings.office.lighting, cycle: 'host-clock' as const, ...over } });
const clock: ClockSync = { skewMs: 0, tzOffsetMin: 0, measuredAt: 0 };
const theme = { id: 'modern', lighting: { dayTint: 0xffffff, nightTint: 0x0b1030, nightAlpha: 0.4, glowAtNight: true } } as never;
const HOUR = 3_600_000;

function makeHost(over: Partial<LightingHost> & { t?: { now: number }; casters?: ShadowCaster[] } = {}) {
  const t = over.t ?? { now: 1_700_000_000_000 - (1_700_000_000_000 % 86_400_000) + 1 * HOUR }; // 01:00 UTC
  const map = mapFrom(walledRows(10, 8), { furniture: [furn('bookcase', 2, 2, 2, 1)], lights: [{ x: 5, y: 4, reachTiles: 5, roomId: 'r1' }] });
  const phases: string[] = [];
  const host: LightingHost = {
    map: () => map, theme: () => theme, regions: () => [], style: () => 'modern',
    characters: () => over.casters ?? [], quality: () => 'high', webgl: () => true, reducedMotion: () => false,
    now: () => t.now, onPhase: (p) => phases.push(p), ...over,
  };
  return { host, t, phases, map };
}

describe('resolveLightingMode (section 3.1 table)', () => {
  const s = settings.office.lighting;
  it('canvas or lightmap=false: overlay, no layers, blob characters', () => {
    for (const m of [resolveLightingMode(false, 'high', s, false), resolveLightingMode(true, 'high', { ...s, lightmap: false }, false)]) {
      expect(m).toMatchObject({ render: 'overlay', furniture: 'none', character: 'blob', shafts: false, flicker: false });
    }
  });
  it('WebGL low: quarter, 3 bands, no shafts, blob shadows', () => {
    expect(resolveLightingMode(true, 'low', s, false)).toMatchObject({ render: 'lightmap', resolution: 'quarter', bands: 'low', shafts: false, furniture: 'blob', character: 'blob', flicker: false });
  });
  it('WebGL high: per settings; reduced motion only drops flicker', () => {
    expect(resolveLightingMode(true, 'high', s, false)).toMatchObject({ render: 'lightmap', resolution: 'half', bands: 'high', shafts: true, furniture: 'cast', character: 'cast', flicker: true });
    expect(resolveLightingMode(true, 'high', { ...s, shadows: 'blob' }, true)).toMatchObject({ furniture: 'blob', character: 'blob', flicker: false });
    expect(resolveLightingMode(true, 'high', { ...s, shadows: 'off' }, false).furniture).toBe('none');
  });
});

describe('LightingController', () => {
  it('bakes on applySettings, not again for equal inputs, and exactly once per sun step', () => {
    const { scene, log } = stubScene();
    const { host, t, phases } = makeHost();
    const c = new LightingController(scene, host);
    c.setMap();
    expect(c.bakes).toBe(0); // settings not known yet
    c.applySettings(lighting(), clock, undefined);
    expect(c.bakes).toBe(1);
    expect(log['renderTexture']).toBe(1);
    expect(log['rt.fill']).toBeGreaterThan(0);
    expect(log['rt.draw']).toBeGreaterThan(0);
    expect(log['g.fillPoints']).toBeGreaterThan(0);
    expect(phases).toEqual(['night']);

    c.applySettings(lighting(), clock, undefined);
    c.update(0, 16);
    expect(c.bakes).toBe(1);

    t.now += 5 * 60_000; // same 15-minute step
    c.update(0, 16);
    expect(c.bakes).toBe(1);
    t.now += 15 * 60_000; // next step
    c.update(0, 16);
    expect(c.bakes).toBe(2);
    c.update(0, 16);
    expect(c.bakes).toBe(2);
  });

  it('never re-bakes more than once per MIN_BAKE_INTERVAL_MS (settings storm), then catches up', () => {
    const { scene } = stubScene();
    const { host, t } = makeHost();
    const c = new LightingController(scene, host);
    c.applySettings(lighting(), clock, undefined);
    for (let h = 2; h < 12; h++) {
      t.now += 10;
      c.applySettings(lighting(), clock, { hour: h });
    }
    expect(c.bakes).toBe(1);
    t.now += MIN_BAKE_INTERVAL_MS;
    c.update(0, 16);
    expect(c.bakes).toBe(2);
    expect(c.sun.hour).toBe(11);
  });

  it('canvas renderer, lightmap=false and an oversize texture all use the overlay (no render texture)', () => {
    for (const [w, lm, max] of [[false, true, 4096], [true, false, 4096], [true, true, 8]] as const) {
      const { scene, log } = stubScene(max);
      const { host } = makeHost({ webgl: () => w });
      const c = new LightingController(scene, host);
      c.applySettings(lighting({ lightmap: lm }), clock, undefined);
      expect(log['renderTexture'] ?? 0).toBe(0);
      expect(log['rectangle']).toBe(1);
    }
  });

  it('calls setCastShadow on every character each frame with one shared out object', () => {
    const { scene } = stubScene();
    const seen = new Set<CastShadow>();
    const calls = { n: 0 };
    const casters: ShadowCaster[] = Array.from({ length: 60 }, (_, i) => ({ x: 40 + i, y: 70, setCastShadow: (s) => (calls.n++, seen.add(s as CastShadow)) }));
    const { host } = makeHost({ casters });
    const c = new LightingController(scene, host);
    c.applySettings(lighting(), clock, undefined);
    c.update(0, 16);
    c.update(16, 16);
    expect(calls.n).toBe(120);
    expect(seen.size).toBe(1);
  });

  it('blob mode and the overlay hide cast shadows (alpha 0)', () => {
    const { scene } = stubScene();
    const got: CastShadow[] = [];
    const caster: ShadowCaster = { x: 50, y: 60, setCastShadow: (s) => got.push({ ...s }) };
    const { host } = makeHost({ casters: [caster] });
    const c = new LightingController(scene, host);
    c.applySettings(lighting({ shadows: 'blob' }), clock, undefined);
    c.update(0, 16);
    expect(got[0]).toEqual({ dx: 0, dy: 0, len: 0, alpha: 0 });
  });

  it('feeds the host clock zone into the sun (Jakarta noon is day, same instant in UTC is night)', () => {
    const { scene } = stubScene();
    const t = { now: 1_700_000_000_000 - (1_700_000_000_000 % 86_400_000) + 5 * HOUR }; // 05:00 UTC
    const a = new LightingController(scene, makeHost({ t }).host);
    a.applySettings(lighting(), { ...clock, tzOffsetMin: 420 }, undefined); // 12:00 Jakarta
    const b = new LightingController(scene, makeHost({ t }).host);
    b.applySettings(lighting(), clock, undefined);
    expect(a.sun.phase).toBe('day');
    expect(b.sun.phase).toBe('night');
  });

  it('re-announces the phase after setMap (theme switch at an unchanged phase)', () => {
    const { scene } = stubScene();
    const { host, phases } = makeHost();
    const c = new LightingController(scene, host);
    c.applySettings(lighting(), clock, undefined);
    c.setMap();
    expect(phases).toEqual(['night', 'night']);
  });

  it('leaves the GPU-size overlay fallback once the map fits again', () => {
    const { scene, log } = stubScene(8);
    const max = { v: 8 };
    (scene as { sys: { game: { renderer: { getMaxTextureSize: () => number } } } }).sys.game.renderer.getMaxTextureSize = () => max.v;
    const { host } = makeHost();
    const c = new LightingController(scene, host);
    c.applySettings(lighting(), clock, undefined);
    expect(log['renderTexture'] ?? 0).toBe(0);
    max.v = 4096; // stands in for a smaller map
    c.setMap();
    expect(log['renderTexture']).toBe(1);
  });

  it('re-bakes when the runtime quality changes without a settings change', () => {
    const { scene } = stubScene();
    const q = { v: 'high' as 'high' | 'low' };
    const { host, t } = makeHost({ quality: () => q.v });
    const c = new LightingController(scene, host);
    c.applySettings(lighting(), clock, undefined);
    expect(c.bakes).toBe(1);
    q.v = 'low';
    t.now += MIN_BAKE_INTERVAL_MS;
    c.update(0, 16);
    expect(c.bakes).toBe(2);
    c.update(0, 16);
    expect(c.bakes).toBe(2);
  });

  it('a reconnect that only changes measuredAt does not re-bake; the pre-bake sun is cached', () => {
    const { scene } = stubScene();
    const { host } = makeHost();
    const c = new LightingController(scene, host);
    expect(c.sun).toBe(c.sun);
    c.applySettings(lighting(), clock, undefined);
    c.applySettings(lighting(), { ...clock, measuredAt: 99 }, undefined);
    expect(c.bakes).toBe(1);
  });

  it('destroy tears the layers down and is safe twice', () => {
    const { scene } = stubScene();
    const { host } = makeHost();
    const c = new LightingController(scene, host);
    c.applySettings(lighting(), clock, undefined);
    c.destroy();
    expect(() => c.destroy()).not.toThrow();
  });
  it('applyDepth: wallShadows adds day wall quads, a change re-bakes (throttled), night has none', () => {
    const quads = (wall: boolean, hour: number) => {
      const { scene, log } = stubScene();
      const t = { now: 1_700_000_000_000 - (1_700_000_000_000 % 86_400_000) + hour * HOUR };
      const c = new LightingController(scene, makeHost({ t }).host);
      c.setMap();
      c.applyDepth({ wallShadows: wall });
      c.applySettings(lighting(), clock, undefined);
      return { n: log['g.fillPoints'] ?? 0, c, t, log };
    };
    expect(quads(true, 12).n).toBeGreaterThan(quads(false, 12).n);
    expect(quads(true, 1).n).toBe(quads(false, 1).n);

    const { c, t, log } = quads(true, 12);
    const before = c.bakes;
    c.applyDepth({ wallShadows: true });
    expect(c.bakes).toBe(before); // unchanged value: no bake
    t.now += MIN_BAKE_INTERVAL_MS + 1;
    const fills = log['g.fillPoints']!;
    c.applyDepth({ wallShadows: false });
    expect(c.bakes).toBe(before + 1);
    expect(log['g.fillPoints']! - fills).toBeLessThan(fills);
    expect(c.heights?.cols).toBe(12);
  });

});
