// apps/web/src/game/postfx/ScreenPipeline.ts  (M9: monitor screen effects — replaces ScanlinesPipeline)
//
// One PostFX pipeline for all three selectable "monitor" looks (`office.shaders.screen`): CRT, LCD
// and VHS, picked by a `mode` uniform (0 pass-through, 1 CRT, 2 LCD, 3 VHS — a float, not an int:
// Phaser's `set1i` is awkward to rely on across pipelines, and GLSL ES 1.0 branches on floats just
// as well). `mode < 0.5` (or `strength <= 0`) is an unconditional early-out that returns the source
// texel untouched — the exact-pass-through requirement — so hot-toggling is always a uniform flip,
// never an add/remove (same rule as every other pipeline here, see `PostFxController`'s header).
//
// None of the three modes resample neighbouring texels for the *base* image (CRT's barrel curve is
// the one exception, and it's applied uniformly with no differential blur — see its own comment),
// so pixel art never gets soft at mode 0 or at strength 0.
import * as Phaser from 'phaser';
import type { ScreenEffect } from '@tagconn/shared';

const FRAG_SHADER = `
#define SHADER_NAME SCREEN_FS
precision mediump float;
uniform sampler2D uMainSampler;
uniform vec2 resolution;
uniform float mode;          // 0 off, 1 CRT, 2 LCD, 3 VHS
uniform float strength;      // 0..1
uniform float time;
uniform float zoom;
uniform float reducedMotion; // 0/1: freezes flicker/wobble/drift, not the static grids/scanlines
uniform float lowQuality;    // 0/1: CRT drops the RGB mask, VHS drops the grain/noise line
varying vec2 outTexCoord;

vec2 barrel(vec2 uv, float amount) {
  vec2 c = uv * 2.0 - 1.0;
  vec2 offset = c.yx * c.yx * amount;
  c += c * offset;
  return c * 0.5 + 0.5;
}

// Rounded-rect mask in UV space: 1.0 inside, fading to 0.0 past 'radius' of an inset rectangle
// ('edge' from each side) — the CRT/LCD bezel.
float roundedMask(vec2 uv, float radius, float edge) {
  vec2 d = abs(uv - 0.5) - (0.5 - edge - radius);
  d = max(d, 0.0);
  float dist = length(d);
  return 1.0 - smoothstep(radius - 0.015, radius, dist);
}

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = outTexCoord;
  if (mode < 0.5 || strength <= 0.0) {
    gl_FragColor = texture2D(uMainSampler, uv);
    return;
  }

  float t = reducedMotion > 0.5 ? 0.0 : time;

  if (mode < 1.5) {
    // --- CRT: barrel curvature, aperture-grille RGB mask, scanlines, chroma offset, faint flicker,
    //     rounded bezel. ---
    vec2 curved = barrel(uv, 0.05 * strength);
    if (curved.x < 0.0 || curved.x > 1.0 || curved.y < 0.0 || curved.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    float chroma = 0.0018 * strength;
    float r = texture2D(uMainSampler, curved + vec2(chroma, 0.0)).r;
    float g = texture2D(uMainSampler, curved).g;
    float b = texture2D(uMainSampler, curved - vec2(chroma, 0.0)).b;
    float a = texture2D(uMainSampler, curved).a;
    vec3 c = vec3(r, g, b);

    float scan = sin((curved.y * resolution.y - t * 6.0) * 3.14159);
    c *= 1.0 - (0.14 * strength) * (0.5 + 0.5 * scan);

    if (lowQuality < 0.5) {
      float grille = mod(gl_FragCoord.x, 3.0);
      vec3 gmask = vec3(0.82);
      if (grille < 1.0) gmask.r = 1.0;
      else if (grille < 2.0) gmask.g = 1.0;
      else gmask.b = 1.0;
      c *= mix(vec3(1.0), gmask, 0.35 * strength);
    }

    float flicker = 1.0 - 0.02 * strength * (reducedMotion > 0.5 ? 0.0 : sin(t * 18.0));
    c *= flicker;

    c *= roundedMask(curved, 0.05, 0.012);
    gl_FragColor = vec4(c, a);
    return;
  }

  if (mode < 2.5) {
    // --- LCD: flat (no curvature), subpixel RGB grid, a thin pixel-gap grid scaled to the camera
    //     zoom (fades out before it can moiré at low zoom), rounded bezel. ---
    vec4 texel = texture2D(uMainSampler, uv);
    vec3 c = texel.rgb;
    vec2 px = uv * resolution;

    float cell = max(1.0, 3.0 * max(zoom, 0.1));
    float gapFade = smoothstep(3.0, 6.0, cell); // fully faded below ~3 screen px/cell

    float sub = mod(px.x, cell * 3.0) / (cell * 3.0);
    vec3 rgbMask = vec3(0.86);
    if (sub < 1.0 / 3.0) rgbMask.r = 1.0;
    else if (sub < 2.0 / 3.0) rgbMask.g = 1.0;
    else rgbMask.b = 1.0;
    c = mix(c, c * rgbMask, 0.4 * strength * gapFade);

    vec2 gap = mod(px, cell) / cell;
    float lineX = smoothstep(0.0, 0.15, gap.x) * smoothstep(1.0, 0.85, gap.x);
    float lineY = smoothstep(0.0, 0.15, gap.y) * smoothstep(1.0, 0.85, gap.y);
    float gridShade = mix(1.0, lineX * lineY, 0.28 * strength * gapFade);
    c *= gridShade;

    c *= roundedMask(uv, 0.04, 0.008);
    gl_FragColor = vec4(c, texel.a);
    return;
  }

  // --- VHS: banded horizontal tracking wobble, chroma bleed, a drifting noise line, grain, a slight
  //     desaturation. ---
  float band = floor(uv.y * 24.0);
  float wobble = reducedMotion > 0.5 ? 0.0 : (rand(vec2(band, floor(t * 6.0))) - 0.5) * 0.012 * strength;
  vec2 wobbleUv = vec2(uv.x + wobble, uv.y);

  float chroma = 0.004 * strength;
  float r = texture2D(uMainSampler, wobbleUv + vec2(chroma, 0.0)).r;
  float g = texture2D(uMainSampler, wobbleUv).g;
  float b = texture2D(uMainSampler, wobbleUv - vec2(chroma, 0.0)).b;
  float a = texture2D(uMainSampler, wobbleUv).a;
  vec3 c = vec3(r, g, b);

  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(luma), 0.2 * strength);

  if (lowQuality < 0.5) {
    float grain = (rand(uv * resolution + t * 60.0) - 0.5) * 0.10 * strength;
    c += grain;
    float noiseY = reducedMotion > 0.5 ? 0.5 : fract(t * 0.15);
    float noiseBand = smoothstep(0.02, 0.0, abs(uv.y - noiseY));
    c += noiseBand * 0.25 * strength;
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), a);
}
`;

const MODE_INDEX: Record<ScreenEffect, number> = { off: 0, crt: 1, lcd: 2, vhs: 3 };

export class ScreenPipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  /** Numeric mode uniform — see `MODE_INDEX`; `0` is the shader's own guaranteed pass-through. */
  mode = 0;
  strength = 0;
  zoom = 1;
  reducedMotion = false;
  lowQuality = false;
  private clock = 0;

  constructor(game: Phaser.Game) {
    super({ game, fragShader: FRAG_SHADER });
  }

  setEffect(effect: ScreenEffect): void {
    this.mode = MODE_INDEX[effect];
  }

  onPreRender(): void {
    this.clock += 0.016;
    this.set2f('resolution', this.renderer.width, this.renderer.height);
    this.set1f('mode', this.mode);
    this.set1f('strength', this.strength);
    this.set1f('time', this.clock);
    this.set1f('zoom', this.zoom);
    this.set1f('reducedMotion', this.reducedMotion ? 1 : 0);
    this.set1f('lowQuality', this.lowQuality ? 1 : 0);
  }
}
