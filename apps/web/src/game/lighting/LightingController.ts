// M16 L4: the one object `OfficeScene` owns for lighting (docs/design/lighting.md section 3.1). Resolves the sun from the host
// clock, schedules lightmap bakes per sun step (never more than once per MIN_BAKE_INTERVAL_MS), owns the lightmap / shadow layers
// or the flat overlay fallback, and feeds every character its cast shadow each frame without allocating.
import type * as Phaser from 'phaser';
import type { Settings } from '@tagconn/shared';
import { MULTIVERSE_THEME_ID, type OfficeStyle } from '@tagconn/shared';
import { ensureLightGlowTexture, LIGHT_GLOW_REFERENCE_RADIUS, LIGHT_GLOW_TEXTURE } from '../postfx/glowTexture';
import type { Point } from '../procgen/types';
import type { GeneratedMap } from '../procgen/types';
import type { ThemeDefinition } from '../themes/types';
import type { ThemeRegion } from '../themes/renderTheme';
import { cycleHour, effectiveSunStep, MIN_BAKE_INTERVAL_MS, resolveCycle, sunStep, type ClockSync, type LightingOverride, type ResolvedCycle } from './clock';
import { overlayPlan } from './fallback';
import { LightmapLayer, LIGHTMAP_DEPTH } from './LightmapLayer';
import { buildOccluders, type Occluders } from './occluders';
import { lightingColours } from './palette';
import { bakePolygons, lightmapSize, planLightmap, type PlanRegion } from './plan';
import { buildLightIndex, characterShadow, furnitureShadows, type LightIndex } from './shadows';
import { lightmapSources } from './sources';
import { ShadowLayer } from './ShadowLayer';
import { sunAt } from './sun';
import type { CastShadow, LightmapLight, LightingQuality, SunPhase, SunState } from './types';

type OfficeSettings = Settings['office'];
type LightingSettings = OfficeSettings['lighting'];

/** Anything with a cast-shadow image (Character); the controller never needs more. */
export interface ShadowCaster {
  x: number;
  y: number;
  setCastShadow(s: Readonly<CastShadow>): void;
}

export interface LightingHost {
  map(): GeneratedMap;
  theme(): ThemeDefinition;
  regions(): readonly ThemeRegion[];
  style(): OfficeStyle | typeof MULTIVERSE_THEME_ID;
  /** Cast + NPCs + the Receptionist (anything with a `setCastShadow`). */
  characters(): Iterable<ShadowCaster>;
  /** `postFx.resolvedQuality`. */
  quality(): LightingQuality;
  /** `postFx.available`. */
  webgl(): boolean;
  reducedMotion(): boolean;
  /** `Date.now()`; injectable for tests. */
  now(): number;
  /** Called when the sun phase changes (and once after the first bake); the PM feeds `sfxBus.setAmbient`. */
  onPhase(phase: SunPhase): void;
}

export type LightingRender = 'lightmap' | 'overlay';
export interface LightingMode {
  render: LightingRender;
  /** Lightmap resolution; `quarter` on low quality. */
  resolution: 'half' | 'quarter';
  bands: 'high' | 'low';
  shafts: boolean;
  /** Furniture shadow layer: none, ellipse-ish blobs, or cast parallelograms. */
  furniture: 'none' | 'blob' | 'cast';
  /** Character shadows: `cast` skews the new image; `blob` keeps the existing ellipse only. */
  character: 'blob' | 'cast';
  flicker: boolean;
}

/** The decision table of section 3.1 (pure). */
export function resolveLightingMode(webgl: boolean, quality: LightingQuality, s: LightingSettings, reducedMotion: boolean): LightingMode {
  if (!webgl || !s.lightmap) {
    return { render: 'overlay', resolution: 'quarter', bands: 'low', shafts: false, furniture: 'none', character: 'blob', flicker: false };
  }
  if (quality === 'low') {
    return { render: 'lightmap', resolution: 'quarter', bands: 'low', shafts: false, furniture: s.shadows === 'off' ? 'none' : 'blob', character: 'blob', flicker: false };
  }
  return {
    render: 'lightmap',
    resolution: s.resolution,
    bands: 'high',
    shafts: s.windowShafts,
    furniture: s.shadows === 'off' ? 'none' : s.shadows,
    character: s.shadows === 'cast' ? 'cast' : 'blob',
    flicker: !reducedMotion,
  };
}

const DAY_MS = 86_400_000;
const FLICKER_CAP = 24;
const FLICKER_ALPHA = 0.08;
const FALLBACK_MAX_TEXTURE = 4096;
const OVERLAY_DEPTH = LIGHTMAP_DEPTH;
const NO_SHADOW: Readonly<CastShadow> = { dx: 0, dy: 0, len: 0, alpha: 0 };

interface Flicker {
  img: Phaser.GameObjects.Image;
  phase: number;
}

export class LightingController {
  private lighting: LightingSettings | null = null;
  private themeMode: OfficeSettings['theme'] = 'auto';
  private clock: ClockSync = { skewMs: 0, tzOffsetMin: -new Date().getTimezoneOffset(), measuredAt: 0 };
  private override: LightingOverride | null = null;
  private cycle: ResolvedCycle | null = null;
  private epochMs = 0;
  private settingsKey = '';

  private mode: LightingMode = resolveLightingMode(false, 'high', defaultLighting(), false);
  private occluders: Occluders | null = null;
  private sources: LightmapLight[] = [];
  private polygons = new Map<LightmapLight, Point[]>();
  private index: LightIndex | null = null;

  private lightmap: LightmapLayer | null = null;
  private shadows: ShadowLayer | null = null;
  private overlay: Phaser.GameObjects.Rectangle | null = null;
  private flickerBox: Phaser.GameObjects.Container | null = null;
  private flickers: Flicker[] = [];

  private _sun: SunState | null = null;
  private fallbackSun: { theme: ThemeDefinition; sun: SunState } | null = null;
  private lastQuality: LightingQuality | null = null;
  private lastWebgl = true;
  private lastStep = Number.NaN;
  private lastPhase: SunPhase | null = null;
  private lastBakeAt = Number.NEGATIVE_INFINITY;
  private dirty = false;
  private geometryDirty = true;

  private readonly feet: Point = { x: 0, y: 0 };
  private readonly out: CastShadow = { dx: 0, dy: 0, len: 0, alpha: 0 };
  /** Bakes performed (tests, dev diagnostics). */
  bakes = 0;

  constructor(private scene: Phaser.Scene, private host: LightingHost) {}

  /** The current sun (HUD label, tests). Noon until the first bake. */
  get sun(): SunState {
    if (this._sun) return this._sun;
    // Read often (NPC director) before the first bake: allocate once per theme, not per call.
    const theme = this.host.theme();
    if (this.fallbackSun?.theme !== theme) this.fallbackSun = { theme, sun: sunAt(12, defaultSunParams(), lightingColours(theme)) };
    return this.fallbackSun.sun;
  }

  /** buildWorld / applySkin: rebuild occluders, sources, polygons, the render target; re-bake. */
  setMap(): void {
    this.geometryDirty = true;
    // A theme/floor switch can keep the same sun phase: force the next bake to re-announce it so the host re-reads the theme (ambience).
    this.lastPhase = null;
    if (this.lighting) this.bake();
  }

  /** setOfficeState: re-bakes if anything that feeds the plan changed (throttled; see `update`). */
  applySettings(office: OfficeSettings, clock: ClockSync | undefined, override: LightingOverride | undefined): void {
    const key = JSON.stringify([office.lighting, office.theme, this.host.quality(), this.host.webgl(), this.host.reducedMotion(), clock ? [clock.skewMs, clock.tzOffsetMin, clock.tz ?? null] : null, override ?? null]);
    if (key === this.settingsKey) return;
    this.settingsKey = key;
    const prev = this.lighting;
    this.lighting = office.lighting;
    this.themeMode = office.theme;
    // `undefined` keeps the last known clock (a reconnect without one must not reset the sync).
    if (clock) this.clock = clock;
    this.override = override ?? null;
    const cycle = resolveCycle(office.theme, office.lighting, this.override);
    if (!this.cycle || this.cycle.cycle !== cycle.cycle || this.cycle.cycleMinutes !== cycle.cycleMinutes || this.cycle.fixedHour !== cycle.fixedHour) {
      this.epochMs = this.host.now();
    }
    this.cycle = cycle;
    if (!prev || prev.lightScale !== office.lighting.lightScale || prev.resolution !== office.lighting.resolution || prev.lightmap !== office.lighting.lightmap) {
      this.geometryDirty = true;
    }
    const next = resolveLightingMode(this.host.webgl(), this.host.quality(), office.lighting, this.host.reducedMotion());
    if (next.render !== this.mode.render || next.resolution !== this.mode.resolution || next.bands !== this.mode.bands) this.geometryDirty = true;
    this.mode = next;
    this.lastQuality = this.host.quality();
    this.lastWebgl = this.host.webgl();
    this.dirty = true;
    this.tryBake(this.host.now());
  }

  /** Every frame: sun step check (re-bake on change), character cast shadows, flicker. */
  update(time: number, _delta: number): void {
    const lighting = this.lighting;
    const cycle = this.cycle;
    if (!lighting || !cycle) return;
    const now = this.host.now();
    // A runtime auto quality downgrade / context loss changes the mode without a settings change.
    const q = this.host.quality();
    const gl = this.host.webgl();
    if (q !== this.lastQuality || gl !== this.lastWebgl) {
      this.lastQuality = q;
      this.lastWebgl = gl;
      this.mode = resolveLightingMode(gl, q, lighting, this.host.reducedMotion());
      this.geometryDirty = true;
      this.dirty = true;
    }
    const hour = cycleHour(cycle, this.clock, now, this.epochMs);
    const step = sunStep(hour, effectiveSunStep(lighting));
    if (step !== this.lastStep) this.dirty = true;
    if (this.dirty) this.tryBake(now);

    const sun = this._sun;
    const index = this.index;
    if (!sun || !index) return;
    const mode = this.mode.character;
    const out = this.out;
    for (const c of this.host.characters()) {
      if (mode === 'cast') {
        this.feet.x = c.x;
        this.feet.y = c.y;
        c.setCastShadow(characterShadow(this.feet, sun, index, 'cast', out));
      } else {
        c.setCastShadow(NO_SHADOW);
      }
    }

    if (this.flickers.length > 0) {
      const t = time / 1000;
      const k = (this._sun?.daylight ?? 0) > 0.9 ? 0 : 1;
      for (const f of this.flickers) f.img.setAlpha(k * FLICKER_ALPHA * (0.5 + 0.5 * Math.sin(t * 9 + f.phase) * Math.sin(t * 5.3 + f.phase * 2)));
    }
  }

  destroy(): void {
    this.destroyLayers();
    this.overlay?.destroy();
    this.overlay = null;
  }

  // ------------------------------------------------------------ baking

  private tryBake(now: number): void {
    if (now - this.lastBakeAt < MIN_BAKE_INTERVAL_MS) return;
    this.bake(now);
  }

  private bake(nowArg?: number): void {
    const lighting = this.lighting;
    const cycle = this.cycle;
    if (!lighting || !cycle) return;
    const now = nowArg ?? this.host.now();
    const map = this.host.map();
    const theme = this.host.theme();
    const colours = lightingColours(theme);
    const quality = this.host.quality();

    const hour = cycleHour(cycle, this.clock, now, this.epochMs);
    const dayIndex = Math.floor((now + this.clock.skewMs + this.clock.tzOffsetMin * 60_000) / DAY_MS);
    const sun = sunAt(hour, lighting, colours, dayIndex);
    this._sun = sun;
    this.lastStep = sunStep(hour, effectiveSunStep(lighting));
    this.lastBakeAt = now;
    this.dirty = false;
    this.bakes++;

    if (this.geometryDirty) this.rebuildGeometry(map, lighting, quality);

    if (this.mode.render === 'overlay' || !this.lightmap) {
      this.showOverlay(map, sun, theme);
    } else {
      this.overlay?.setVisible(false);
      const regions = this.regions();
      const plan = planLightmap({
        map, sun, sources: this.sources, polygons: this.polygons, quality: this.mode.bands === 'high' ? 'high' : 'low',
        settings: { windowShafts: this.mode.shafts }, colours, regions,
      });
      this.lightmap.bake(plan);
      if (this.shadows) {
        this.shadows.draw(this.mode.furniture === 'none' ? [] : furnitureShadows(map, sun, this.sources, this.mode.furniture, colours.shadowAlpha));
      }
      this.syncFlickers(plan.lights.filter((p) => p.light.flicker).map((p) => p.light));
    }

    if (sun.phase !== this.lastPhase) {
      this.lastPhase = sun.phase;
      this.host.onPhase(sun.phase);
    }
  }

  private regions(): PlanRegion[] {
    const T = this.host.map().tileSize;
    return this.host.regions().map((r) => ({ rect: { x: r.rect.x * T, y: r.rect.y * T, w: r.rect.w * T, h: r.rect.h * T }, theme: r.theme }));
  }

  private rebuildGeometry(map: GeneratedMap, lighting: LightingSettings, quality: LightingQuality): void {
    this.geometryDirty = false;
    // Recompute from settings: the GPU-size fallback below overwrites the mode and a smaller map must be able to leave it.
    this.mode = resolveLightingMode(this.host.webgl(), quality, lighting, this.host.reducedMotion());
    this.destroyLayers();
    const T = map.tileSize;
    const regions = this.regions();
    const themeAt = (x: number, y: number): ThemeDefinition => {
      for (const r of regions) if (x >= r.rect.x && y >= r.rect.y && x < r.rect.x + r.rect.w && y < r.rect.y + r.rect.h) return r.theme as ThemeDefinition;
      return this.host.theme();
    };
    const lq = this.mode.bands === 'high' ? 'high' : 'low';
    this.sources = lightmapSources(map, this.host.style(), themeAt, lighting.lightScale, lq);
    this.index = buildLightIndex(this.sources, map.cols, map.rows, T);

    if (this.mode.render === 'lightmap') {
      const size = lightmapSize({ w: map.cols * T, h: map.rows * T }, this.mode.resolution, this.maxTextureSize());
      if (size.fallback) {
        // Security #5: even quarter resolution exceeds the GPU's texture limit: degrade to the flat overlay.
        this.mode = { ...this.mode, render: 'overlay', furniture: 'none', character: 'blob', flicker: false, shafts: false };
      } else {
        this.occluders = buildOccluders(map);
        this.polygons = bakePolygons(this.sources, this.occluders, map, lq);
        this.lightmap = new LightmapLayer(this.scene, size, quality === 'high' && this.mode.resolution === 'half');
        if (this.mode.furniture !== 'none') this.shadows = new ShadowLayer(this.scene);
      }
    }
  }

  private maxTextureSize(): number {
    const r = this.scene.sys?.game?.renderer as { getMaxTextureSize?: () => number } | undefined;
    const n = typeof r?.getMaxTextureSize === 'function' ? r.getMaxTextureSize() : FALLBACK_MAX_TEXTURE;
    return Number.isFinite(n) && n > 0 ? n : FALLBACK_MAX_TEXTURE;
  }

  private showOverlay(map: GeneratedMap, sun: SunState, theme: ThemeDefinition): void {
    const T = map.tileSize;
    const w = map.cols * T;
    const h = map.rows * T;
    const plan = overlayPlan(sun, theme);
    if (!this.overlay) this.overlay = this.scene.add.rectangle(0, 0, w, h, plan.color, plan.alpha).setOrigin(0).setDepth(OVERLAY_DEPTH);
    this.overlay.setSize(w, h).setFillStyle(plan.color, plan.alpha).setVisible(true);
  }

  /** Small additive glows over flickering lights (torches, fireplace); alpha moves per frame, no re-bake. */
  private syncFlickers(lights: readonly LightmapLight[]): void {
    for (const f of this.flickers) f.img.destroy();
    this.flickers = [];
    if (!this.mode.flicker || lights.length === 0) return;
    ensureLightGlowTexture(this.scene);
    if (!this.flickerBox) this.flickerBox = this.scene.add.container(0, 0).setDepth(LIGHTMAP_DEPTH + 1);
    for (const l of lights.slice(0, FLICKER_CAP)) {
      const img = this.scene.add.image(l.x, l.y, LIGHT_GLOW_TEXTURE).setBlendMode(1).setTint(l.color).setAlpha(0);
      img.setScale((l.reach * 0.45) / LIGHT_GLOW_REFERENCE_RADIUS);
      this.flickerBox.add(img);
      this.flickers.push({ img, phase: (l.x * 0.013 + l.y * 0.007) % (Math.PI * 2) });
    }
  }

  private destroyLayers(): void {
    for (const f of this.flickers) f.img.destroy();
    this.flickers = [];
    this.flickerBox?.destroy();
    this.flickerBox = null;
    this.lightmap?.destroy();
    this.lightmap = null;
    this.shadows?.destroy();
    this.shadows = null;
  }
}

function defaultLighting(): LightingSettings {
  return { cycle: 'host-clock', fixedHour: 14, cycleMinutes: 24, dawnHour: 6.5, duskHour: 18.5, twilightHours: 1.5, nightAmbient: 0.35, lightScale: 1, shadows: 'cast', lightmap: true, resolution: 'half', sunStepMinutes: 15, windowShafts: true };
}

function defaultSunParams() {
  const d = defaultLighting();
  return { dawnHour: d.dawnHour, duskHour: d.duskHour, twilightHours: d.twilightHours, nightAmbient: d.nightAmbient };
}
