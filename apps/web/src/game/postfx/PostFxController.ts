// apps/web/src/game/postfx/PostFxController.ts  (M8 8o: orchestrates the shader stack; M9: screen effects + pixel vignette)
//
// The only Phaser-facing entry point `OfficeScene` talks to. Owns three pipelines attached to
// `cameras.main` for the whole scene lifetime (created once, never re-added — see the note on
// `setPostPipeline` having no dedupe guard, which is why every toggle below is a uniform flip
// rather than an add/remove), in chain order:
//   1. `GradingPipeline` — disabled by swapping in the identity preset (a true no-op grade).
//   2. `ScreenPipeline` — the monitor screen effect (CRT/LCD/VHS); disabled via `mode = 0` (a true
//      no-op pass, see its own header).
//   3. `VignettePipeline` — replaces the old built-in `camera.postFX.addVignette`; disabled via
//      `strength = 0` (also a true no-op pass).
// Plus a `LightLayer` (its own Container + bloom postFX), rebuilt only when the map/style changes.
//
// Any WebGL failure (canvas renderer, a pipeline that fails to compile, ...) is caught and turns
// this into a permanent no-op for the rest of the scene's life — the office still renders, just
// without shaders (requirement 8o.4). Logged once per page load, not once per scene rebuild.
import * as Phaser from 'phaser';
import type { OfficeStyle } from '@tagconn/shared';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import type { GeneratedMap } from '../procgen/types';
import { IDENTITY_GRADING } from './grading';
import { GradingPipeline } from './GradingPipeline';
import { extractLightSources } from './lights';
import { LightLayer } from './LightLayer';
import { createAutoQualityState, effectiveQuality, resolveAutoQuality, sampleAutoQuality, type AutoQualityState } from './quality';
import { ScreenPipeline } from './ScreenPipeline';
import type { ShaderQuality } from './types';
import { resolveShaderConfig, type ScreenOverride, type ShaderSettings } from './uniforms';
import { VignettePipeline } from './VignettePipeline';

/** Just above `OfficeScene`'s night-tint rectangle (depth 90_000) so torch/lamp glow reads through
 *  the dark-mode overlay instead of being dimmed by it — the whole point of a "cozy lit" mood. */
const LIGHT_LAYER_DEPTH = 95_000;

let loggedFailure = false;

export class PostFxController {
  private webgl = false;
  private gradingPipeline: GradingPipeline | null = null;
  private screenPipeline: ScreenPipeline | null = null;
  private vignettePipeline: VignettePipeline | null = null;
  private lightLayer: LightLayer | null = null;

  private autoQuality: AutoQualityState = createAutoQualityState();
  private configuredQuality: ShaderSettings['quality'] | null = null;
  private lastQuality: ShaderQuality = 'high';

  constructor(private scene: Phaser.Scene) {
    const renderer = scene.sys.game.renderer;
    if (renderer?.type !== Phaser.WEBGL) return; // canvas renderer: silently skip (8o.4)
    try {
      // Custom Post FX pipeline classes must be registered with the renderer's PipelineManager
      // before `camera.setPostPipeline(TheClass)` can find them — `addPostPipeline` is itself
      // idempotent (keyed by name), so re-running this on every scene create is harmless.
      const pipelines = (renderer as Phaser.Renderer.WebGL.WebGLRenderer).pipelines;
      pipelines.addPostPipeline('office-grading', GradingPipeline);
      pipelines.addPostPipeline('office-screen', ScreenPipeline);
      pipelines.addPostPipeline('office-vignette', VignettePipeline);

      const cam = scene.cameras.main;
      // Chain order: grading -> screen -> vignette.
      cam.setPostPipeline(GradingPipeline);
      this.gradingPipeline = firstPipeline<GradingPipeline>(cam.getPostPipeline(GradingPipeline));
      cam.setPostPipeline(ScreenPipeline);
      this.screenPipeline = firstPipeline<ScreenPipeline>(cam.getPostPipeline(ScreenPipeline));
      cam.setPostPipeline(VignettePipeline);
      this.vignettePipeline = firstPipeline<VignettePipeline>(cam.getPostPipeline(VignettePipeline));
      this.lightLayer = new LightLayer(scene, LIGHT_LAYER_DEPTH);
      this.webgl = !!this.gradingPipeline && !!this.screenPipeline && !!this.vignettePipeline;
    } catch (err) {
      this.disable(err);
    }
  }

  get available(): boolean {
    return this.webgl;
  }

  private disable(err: unknown): void {
    if (!loggedFailure) {
      loggedFailure = true;
      // eslint-disable-next-line no-console
      console.warn('[postfx] WebGL shaders disabled (falling back to plain rendering):', err);
    }
    this.webgl = false;
    try {
      if (this.gradingPipeline) this.scene.cameras.main.removePostPipeline(this.gradingPipeline);
      if (this.screenPipeline) this.scene.cameras.main.removePostPipeline(this.screenPipeline);
      if (this.vignettePipeline) this.scene.cameras.main.removePostPipeline(this.vignettePipeline);
    } catch {
      /* best effort */
    }
    this.gradingPipeline = null;
    this.screenPipeline = null;
    this.vignettePipeline = null;
    this.lightLayer?.destroy();
    this.lightLayer = null;
  }

  /** Feed one frame's `delta` (ms) from `OfficeScene#update`; a no-op once `'auto'` has resolved or
   *  the configured tier isn't `'auto'` at all (requirement 8o.3). */
  sampleFrame(deltaMs: number): void {
    if (!this.webgl || this.configuredQuality !== 'auto') return;
    if (resolveAutoQuality(this.autoQuality) !== null) return;
    this.autoQuality = sampleAutoQuality(this.autoQuality, deltaMs);
  }

  private resolveQuality(configured: ShaderSettings['quality']): ShaderQuality {
    if (configured !== this.configuredQuality) {
      this.configuredQuality = configured;
      this.autoQuality = createAutoQualityState(); // restart the ~2s window on any mode change
    }
    const measured = resolveAutoQuality(this.autoQuality);
    this.lastQuality = effectiveQuality(configured, measured);
    return this.lastQuality;
  }

  /**
   * Hot-applies `office.shaders` + the active style + the current per-browser screen-effect
   * override (if any) — safe to call every `setOfficeState` pass; no pipeline is ever added/removed
   * here, only its uniforms/strength are updated (see the header note on why: `setPostPipeline` has
   * no dedupe guard, so toggling by add/remove would leak duplicates). `reducedMotion` freezes the
   * screen effect's time-based motion (CRT flicker, VHS wobble/drift) — pass `prefersReducedMotion()`.
   */
  applySettings(shaders: ShaderSettings, style: OfficeStyle | typeof MULTIVERSE_THEME_ID, reducedMotion: boolean, screenOverride?: ScreenOverride): void {
    if (!this.webgl) return;
    const quality = this.resolveQuality(shaders.quality);
    const cfg = resolveShaderConfig(shaders, style, quality, screenOverride);
    try {
      this.gradingPipeline?.setPreset(cfg.grading ?? IDENTITY_GRADING);
      if (this.screenPipeline) {
        this.screenPipeline.setEffect(cfg.screen.mode);
        this.screenPipeline.strength = cfg.screen.strength;
        this.screenPipeline.reducedMotion = reducedMotion;
        this.screenPipeline.lowQuality = cfg.quality === 'low';
      }
      if (this.vignettePipeline) {
        this.vignettePipeline.setStyle(cfg.vignette.style);
        this.vignettePipeline.strength = cfg.vignette.strength;
        this.vignettePipeline.steps = cfg.vignette.steps;
        this.vignettePipeline.pixelSize = cfg.vignette.pixel;
        this.vignettePipeline.size = cfg.vignette.size;
      }
      this.lightLayer?.setBloom(cfg.bloomStrength, cfg.quality);
    } catch (err) {
      this.disable(err);
    }
  }

  /** Keeps the pixel vignette's block grid and the LCD subpixel grid aligned with the art's own
   *  pixels as the camera zooms — a cheap uniform set, call from every zoom-changing spot (the wheel
   *  handler, `zoomBy`, `resetView`, `fitCamera`), not just `setOfficeState`. */
  setZoom(zoom: number): void {
    if (!this.webgl) return;
    if (this.screenPipeline) this.screenPipeline.zoom = zoom;
    if (this.vignettePipeline) this.vignettePipeline.zoom = zoom;
  }

  /** Rebuilds the light layer's glow sprites for the current map — call from `buildWorld`/`applySkin`
   *  (a geometry or style change), not per frame. `shaders`/`style` are the same values passed to
   *  `applySettings`, so the light cap always matches the resolved quality tier. */
  setMap(map: GeneratedMap, shaders: ShaderSettings, style: OfficeStyle | typeof MULTIVERSE_THEME_ID, reducedMotion: boolean): void {
    if (!this.webgl || !this.lightLayer) return;
    const cfg = resolveShaderConfig(shaders, style, this.lastQuality);
    try {
      const lights = cfg.lightGlow ? extractLightSources(map, style, cfg.maxLights) : [];
      this.lightLayer.setLights(lights, reducedMotion);
      this.lightLayer.setBloom(cfg.bloomStrength, cfg.quality);
    } catch (err) {
      this.disable(err);
    }
  }

  destroy(): void {
    try {
      if (this.gradingPipeline) this.scene.cameras.main.removePostPipeline(this.gradingPipeline);
      if (this.screenPipeline) this.scene.cameras.main.removePostPipeline(this.screenPipeline);
      if (this.vignettePipeline) this.scene.cameras.main.removePostPipeline(this.vignettePipeline);
    } catch {
      /* scene may already be tearing down its renderer */
    }
    this.lightLayer?.destroy();
    this.lightLayer = null;
    this.gradingPipeline = null;
    this.screenPipeline = null;
    this.vignettePipeline = null;
    this.webgl = false;
  }
}

function firstPipeline<T extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline>(
  result: Phaser.Renderer.WebGL.Pipelines.PostFXPipeline | Phaser.Renderer.WebGL.Pipelines.PostFXPipeline[] | null | undefined,
): T | null {
  if (!result) return null;
  return (Array.isArray(result) ? (result[0] ?? null) : result) as T | null;
}
