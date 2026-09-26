// apps/web/src/game/postfx/GradingPipeline.ts  (M8 8o.1a: per-style color grading)
//
// A small, LUT-less lift/gamma/gain + saturation + warmth grade, run once per pixel over whatever
// the main camera already rendered (pixel art and all — this only recolors existing texels, it
// never resamples neighbours, so it never blurs anything, per requirement 8o.2). Attached directly
// to `cameras.main` via `camera.setPostPipeline(GradingPipeline)` (not through the per-Sprite FX
// component), so `onPreRender` reads uniforms straight off `this` rather than an FX controller —
// see `PostFXPipeline#getController`, which returns the pipeline itself when called this way.
import * as Phaser from 'phaser';
import type { GradingPreset } from './types';

const FRAG_SHADER = `
#define SHADER_NAME GRADING_FS
precision mediump float;
uniform sampler2D uMainSampler;
uniform vec3 lift;
uniform vec3 gamma;
uniform vec3 gain;
uniform float saturation;
uniform float warmth;
varying vec2 outTexCoord;

void main() {
  vec4 texel = texture2D(uMainSampler, outTexCoord);
  vec3 c = texel.rgb;
  c = c + lift * (1.0 - c);
  c = pow(max(c, 0.0001), 1.0 / gamma);
  c = c * gain;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(luma), c, saturation);
  c.r += warmth * 0.09;
  c.b -= warmth * 0.09;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);
}
`;

export class GradingPipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  lift: [number, number, number] = [0, 0, 0];
  gamma: [number, number, number] = [1, 1, 1];
  gain: [number, number, number] = [1, 1, 1];
  saturation = 1;
  warmth = 0;

  constructor(game: Phaser.Game) {
    super({ game, fragShader: FRAG_SHADER });
  }

  /** Copies a `GradingPreset`'s values in one shot — called whenever the style (or `office.style`)
   *  changes so grading updates instantly with no scene rebuild (requirement 8o.3). */
  setPreset(preset: GradingPreset): void {
    this.lift = [...preset.lift];
    this.gamma = [...preset.gamma];
    this.gain = [...preset.gain];
    this.saturation = preset.saturation;
    this.warmth = preset.warmth;
  }

  onPreRender(): void {
    this.set3fv('lift', this.lift);
    this.set3fv('gamma', this.gamma);
    this.set3fv('gain', this.gain);
    this.set1f('saturation', this.saturation);
    this.set1f('warmth', this.warmth);
  }
}
