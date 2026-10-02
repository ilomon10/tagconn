import { describe, expect, it } from 'vitest';
import { buildOccluders } from '../occluders';
import { BANDS_HIGH, BANDS_LOW, VOID_AMBIENT, bakePolygons, bandsFor, lightmapSize, planLightmap, scaleColour, shaftFor, voidRects, type PlanInput } from '../plan';
import { lightingColours } from '../palette';
import { LIGHTMAP_MAX_LIGHTS, lightmapSources } from '../sources';
import { containsPoint } from '../visibility';
import { EVENING, MORNING, NIGHT, NOON, T, furn, light, mapFrom, theme, walledRows } from './lightingFixtures';

const colours = lightingColours(theme);

function setup(over: Partial<PlanInput> = {}, lightScale = 1) {
  const map = mapFrom(walledRows(10, 6), {
    lights: [{ x: 5, y: 3, roomId: 'r1', reachTiles: 4 }],
    furniture: [furn('lamp', 2, 2), furn('console', 7, 3, 2, 1)],
    northWall: [{ kind: 'window', x: 3, y: 0, span: 2, roomId: 'r1', variant: 0 }],
  });
  const sources = lightmapSources(map, 'modern', () => theme, lightScale);
  const polygons = bakePolygons(sources, buildOccluders(map), map);
  const input: PlanInput = { map, sun: NIGHT, sources, polygons, quality: 'high', settings: { windowShafts: true }, colours, regions: [], ...over };
  return { map, sources, polygons, input };
}

describe('planLightmap', () => {
  it('bands per quality, outer to inner, summing to the strength', () => {
    expect(bandsFor(80, 0.8, 'high')).toHaveLength(BANDS_HIGH);
    expect(bandsFor(80, 0.8, 'low')).toHaveLength(BANDS_LOW);
    const b = bandsFor(80, 0.8, 'high');
    expect(b[0]!.r).toBe(80);
    expect(b.map((x) => x.r)).toEqual([...b.map((x) => x.r)].sort((p, q) => q - p));
    expect(b.reduce((s, x) => s + x.alpha, 0)).toBeCloseTo(0.8, 6);
    const { input } = setup();
    const planned = planLightmap(input).lights;
    expect(planned.length).toBeGreaterThan(0);
    for (const p of planned) expect(p.bands).toHaveLength(BANDS_HIGH);
    for (const p of planLightmap({ ...input, quality: 'low' }).lights) expect(p.bands).toHaveLength(BANDS_LOW);
  });

  it('fill is the sun tint scaled to the ambient', () => {
    const { input } = setup();
    expect(planLightmap(input).fill.color).toBe(scaleColour(NIGHT.tint, NIGHT.ambient));
    expect(planLightmap({ ...input, sun: NOON }).fill.color).toBe(0xffffff);
  });

  it('intensities: electric lights 1 at night and about 0.15 at noon; windows follow the sun', () => {
    const { input } = setup();
    const night = planLightmap(input).lights;
    expect(night.filter((p) => p.light.kind !== 'window').every((p) => p.intensity === 1)).toBe(true);
    const noon = planLightmap({ ...input, sun: NOON }).lights;
    expect(noon.find((p) => p.light.kind === 'point')!.intensity).toBeCloseTo(0.15, 6);
    expect(noon.find((p) => p.light.kind === 'window')!.intensity).toBe(1);
    expect(night.find((p) => p.light.kind === 'window')!.intensity).toBeCloseTo(0.25, 6);
  });

  it('lightScale scales reach and the planned bands', () => {
    const a = planLightmap(setup({}, 1).input).lights[0]!;
    const b = planLightmap(setup({}, 0.5).input).lights[0]!;
    expect(b.light.reach).toBeCloseTo(a.light.reach / 2, 6);
    expect(b.bands[0]!.r).toBeCloseTo(a.bands[0]!.r / 2, 6);
  });

  it('truncation keeps room lights (they are first) and plan never plans more than the cap', () => {
    const many = Array.from({ length: 500 }, (_, i) => light({ x: (1 + (i % 10)) * T, y: (1 + (i % 6)) * T, kind: i < 3 ? 'ambient-fill' : 'tiny' }));
    const { input, map } = setup();
    const polygons = bakePolygons(many, buildOccluders(map), map, 'low');
    expect(polygons.size).toBe(LIGHTMAP_MAX_LIGHTS.low);
    expect(polygons.has(many[0]!)).toBe(true);
    expect(polygons.has(many[499]!)).toBe(false);
    const plan = planLightmap({ ...input, sources: many, polygons, quality: 'low' });
    expect(plan.lights.length).toBeLessThanOrEqual(LIGHTMAP_MAX_LIGHTS.low);
    expect(plan.lights.slice(0, 3).map((p) => p.light.kind)).toEqual(['ambient-fill', 'ambient-fill', 'ambient-fill']);
  });

  it('bakePolygons clamps reach to 8 tiles and keeps polygons inside the walls', () => {
    const { map } = setup();
    const huge = light({ x: 5.5 * T, y: 3.5 * T, reach: 50 * T });
    const poly = bakePolygons([huge], buildOccluders(map), map).get(huge)!;
    for (const p of poly) expect(Math.hypot(p.x - huge.x, p.y - huge.y)).toBeLessThanOrEqual(8 * T + 1e-6);
    const dead = light({ reach: NaN });
    expect(bakePolygons([dead], buildOccluders(map), map).get(dead)).toEqual([]);
    expect(planLightmap({ ...setup().input, sources: [dead], polygons: bakePolygons([dead], buildOccluders(map), map) }).lights).toEqual([]);
  });

  it('a polygon never spans a wall: the lit region stays in the room', () => {
    const { input } = setup();
    for (const p of planLightmap(input).lights) {
      if (p.light.roomId !== 'r1') continue;
      expect(containsPoint(p.polygon, { x: p.light.x, y: p.light.y + 1 })).toBe(true);
    }
  });
});

describe('shafts', () => {
  const { map } = setup();
  const room = map.rooms[0]!;
  const slot = map.northWall[0]!;

  it('windows get shafts only when windowShafts is on', () => {
    const { input } = setup({ sun: NOON });
    expect(planLightmap(input).shafts).toHaveLength(1);
    expect(planLightmap({ ...input, settings: { windowShafts: false } }).shafts).toHaveLength(0);
  });

  it('quads stay inside the room interior; moon shaft at night; colours by sun/moon', () => {
    for (const sun of [NOON, MORNING, EVENING, NIGHT]) {
      const q = shaftFor(slot, room, sun, colours, T)!;
      expect(q).not.toBeNull();
      for (const p of q.points) {
        expect(p.x).toBeGreaterThanOrEqual(room.interior.x * T);
        expect(p.x).toBeLessThanOrEqual((room.interior.x + room.interior.w) * T);
        expect(p.y).toBeGreaterThanOrEqual(room.interior.y * T);
        expect(p.y).toBeLessThanOrEqual((room.interior.y + room.interior.h) * T);
      }
    }
    expect(shaftFor(slot, room, NIGHT, colours, T)!.color).toBe(colours.moonColor);
    expect(shaftFor(slot, room, NIGHT, colours, T)!.alpha).toBeCloseTo(0.07, 6);
    expect(shaftFor(slot, room, NOON, colours, T)!.color).toBe(colours.sunColor);
    expect(shaftFor(slot, room, NOON, colours, T)!.alpha).toBeCloseTo(0.16, 6);
  });

  it('the lean flips sign across noon', () => {
    const lean = (sun: typeof NOON) => {
      const q = shaftFor(slot, room, sun, colours, T)!;
      return q.points[2].x - q.points[1].x;
    };
    expect(lean(MORNING)).toBeGreaterThan(0); // skew < 0: leans east (+x)
    expect(lean(EVENING)).toBeLessThan(0);
    expect(lean(NOON)).toBe(0);
  });

  it('no shaft for non-windows or when there is no light', () => {
    expect(shaftFor({ ...slot, kind: 'clock' }, room, NOON, colours, T)).toBeNull();
    expect(shaftFor(slot, room, { ...NIGHT, moon: 0 }, colours, T)).toBeNull();
  });
});

describe('darkRegions (Multiverse)', () => {
  it('is empty on a single floor; the void between realms otherwise', () => {
    const { input, map } = setup();
    expect(planLightmap(input).darkRegions).toEqual([]);
    const W = map.cols * T;
    const H = map.rows * T;
    const realm = { x: 0, y: 0, w: W / 2, h: H };
    const plan = planLightmap({ ...input, regions: [{ rect: realm, theme }] });
    expect(plan.darkRegions).toEqual([{ x: W / 2, y: 0, w: W / 2, h: H }]);
  });

  it('voidRects tiles the complement exactly (area check) for a 2 x 2 realm grid', () => {
    const world = { x: 0, y: 0, w: 100, h: 100 };
    const regions = [{ x: 5, y: 5, w: 40, h: 40 }, { x: 55, y: 5, w: 40, h: 40 }, { x: 5, y: 55, w: 40, h: 40 }];
    const dark = voidRects(world, regions);
    const area = dark.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBe(100 * 100 - 3 * 40 * 40);
    expect(scaleColour(0x808080, VOID_AMBIENT)).toBe(0x202020);
  });

  it('shaft colours follow the realm theme', () => {
    const { input, map } = setup({ sun: NOON });
    const rift = { id: 'rift' as const, lighting: theme.lighting };
    const rect = { x: 0, y: 0, w: map.cols * T, h: map.rows * T };
    const [q] = planLightmap({ ...input, regions: [{ rect, theme: rift }] }).shafts;
    expect(q!.color).toBe(lightingColours(rift).sunColor);
  });
});

describe('lightmapSize', () => {
  it('half and quarter resolution', () => {
    expect(lightmapSize({ w: 2048, h: 1536 }, 'half', 4096)).toEqual({ width: 1024, height: 768, scale: 2, fallback: false });
    expect(lightmapSize({ w: 2048, h: 1536 }, 'quarter', 4096)).toEqual({ width: 512, height: 384, scale: 4, fallback: false });
  });
  it('steps half to quarter past the max texture size, then signals fallback with capped dims', () => {
    const q = lightmapSize({ w: 8192, h: 4096 }, 'half', 2048);
    expect(q).toMatchObject({ scale: 4, width: 2048, fallback: false });
    const f = lightmapSize({ w: 20000, h: 4096 }, 'half', 2048);
    expect(f.fallback).toBe(true);
    expect(f.width).toBeLessThanOrEqual(2048);
    expect(f.height).toBeLessThanOrEqual(2048);
  });
  it('degenerate inputs signal fallback', () => {
    for (const [w, h, m] of [[0, 10, 4096], [NaN, 10, 4096], [100, 100, 0], [100, 100, NaN]] as const) expect(lightmapSize({ w, h }, 'half', m).fallback).toBe(true);
  });
});
