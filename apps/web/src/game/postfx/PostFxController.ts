// apps/web/src/game/postfx/PostFxController.ts  (M8 8o: orchestrates the shader stack)
//
// The only Phaser-facing entry point `OfficeScene` talks to. Owns three things attached to
// `cameras.main` for the whole scene lifetime (created once, never re-added — see the note on
// `setPostPipeline` having no dedupe guard, which is why every toggle below is a uniform flip
// rather than an add/remove):
//   1. `GradingPipeline` — disabled by swapping in the identity preset (a true no-op grade).
//   2. `ScanlinesPipeline` — disabled via `strength = 0` (a true no-op pass).
//   3. the built-in `VignetteFXPipeline` (`camera.postFX.addVignette`) — disabled via `strength = 0`.
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
import { ScanlinesPipeline } from './ScanlinesPipeline';
import type { ShaderQuality } from './types';
import { resolveShaderConfig, type ShaderSettings } from './uniforms';

/** Just above `OfficeScene`'s night-tint rectangle (depth 90_000) so torch/lamp glow reads through
 *  the dark-mode overlay instead of being dimmed by it — the whole point of a "cozy lit" mood. */
const LIGHT_LAYER_DEPTH = 95_000;

let loggedFailure = false;

export class PostFxController {
  private webgl = false;
  private gradingPipeline: GradingPipeline | null = null;
  private scanlinesPipeline: ScanlinesPipeline | null = null;
  private vignette: Phaser.FX.Vignette | null = null;
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
      pipelines.addPostPipeline('office-scanlines', ScanlinesPipeline);

      const cam = scene.cameras.main;
      cam.setPostPipeline(GradingPipeline);
      this.gradingPipeline = firstPipeline<GradingPipeline>(cam.getPostPipeline(GradingPipeline));
      cam.setPostPipeline(ScanlinesPipeline);
      this.scanlinesPipeline = firstPipeline<ScanlinesPipeline>(cam.getPostPipeline(ScanlinesPipeline));
      this.vignette = cam.postFX.addVignette(0.5, 0.5, 0.65, 0);
      this.lightLayer = new LightLayer(scene, LIGHT_LAYER_DEPTH);
      this.webgl = !!this.gradingPipeline && !!this.scanlinesPipeline;
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
      if (this.scanlinesPipeline) this.scene.cameras.main.removePostPipeline(this.scanlinesPipeline);
      if (this.vignette) this.scene.cameras.main.postFX.remove(this.vignette);
    } catch {
      /* best effort */
    }
    this.gradingPipeline = null;
    this.scanlinesPipeline = null;
    this.vignette = null;
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

  /** Hot-applies `office.shaders` + the active style — safe to call every `setOfficeState` pass; no
   *  pipeline is ever added/removed here, only its uniforms/strength are updated (see the header note
   *  on why: `setPostPipeline` has no dedupe guard, so toggling by add/remove would leak duplicates). */
  applySettings(shaders: ShaderSettings, style: OfficeStyle | typeof MULTIVERSE_THEME_ID): void {
    if (!this.webgl) return;
    const quality = this.resolveQuality(shaders.quality);
    const cfg = resolveShaderConfig(shaders, style, quality);
    try {
      this.gradingPipeline?.setPreset(cfg.grading ?? IDENTITY_GRADING);
      if (this.scanlinesPipeline) this.scanlinesPipeline.strength = cfg.scanlines ? 1 : 0;
      if (this.vignette) this.vignette.strength = cfg.vignetteStrength;
      this.lightLayer?.setBloom(cfg.bloomStrength, cfg.quality);
    } catch (err) {
      this.disable(err);
    }
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
      if (this.scanlinesPipeline) this.scene.cameras.main.removePostPipeline(this.scanlinesPipeline);
      if (this.vignette) this.scene.cameras.main.postFX.remove(this.vignette);
    } catch {
      /* scene may already be tearing down its renderer */
    }
    this.lightLayer?.destroy();
    this.lightLayer = null;
    this.gradingPipeline = null;
    this.scanlinesPipeline = null;
    this.vignette = null;
    this.webgl = false;
  }
}

function firstPipeline<T extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline>(
  result: Phaser.Renderer.WebGL.Pipelines.PostFXPipeline | Phaser.Renderer.WebGL.Pipelines.PostFXPipeline[] | null | undefined,
): T | null {
  if (!result) return null;
  return (Array.isArray(result) ? (result[0] ?? null) : result) as T | null;
}
