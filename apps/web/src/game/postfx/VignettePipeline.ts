// apps/web/src/game/postfx/VignettePipeline.ts  (M9: pixel-style vignette — replaces cam.postFX.addVignette)
//
// Both vignette looks (`office.shaders.vignetteStyle`) live in one pipeline, picked by a `mode`
// uniform (0 smooth, 1 pixel) so toggling is a uniform flip like everything else here. The GLSL below
// is a line-for-line port of the pure functions in `vignette.ts` — keep them in sync.
import * as Phaser from 'phaser';

const FRAG_SHADER = `
#define SHADER_NAME VIGNETTE_FS
precision mediump float;
uniform sampler2D uMainSampler;
uniform vec2 resolution;
uniform float mode;      // 0 smooth, 1 pixel
uniform float strength;  // darkness at the very edge; 0 = off (exact pass-through)
uniform float steps;     // pixel style band count
uniform float pixelSize; // pixel style block size, art px
uniform float zoom;
uniform float size;      // frame width, fraction of the shorter screen side
varying vec2 outTexCoord;

// 0 inside the clean middle, 1 at the screen edge (distance to an inner rect inset by 'band').
float vignetteT(vec2 px, float band) {
  vec2 halfRes = resolution * 0.5;
  vec2 q = max(abs(px - halfRes) - (halfRes - vec2(band)), 0.0);
  return min(1.0, length(q) / band);
}

void main() {
  vec2 uv = outTexCoord;
  vec4 texel = texture2D(uMainSampler, uv);
  if (strength <= 0.0) {
    gl_FragColor = texel;
    return;
  }
  float band = max(1.0, min(resolution.x, resolution.y) * size);
  vec2 px = uv * resolution;
  float shade;
  if (mode < 0.5) {
    float t = vignetteT(px, band);
    float s = t * t * (3.0 - 2.0 * t);
    shade = s * s * strength;
  } else {
    // Pixel: evaluate at the block centre (block = pixelSize art px * zoom, aligned with the art's
    // pixels at any zoom), then hard bands, no dithering: 25/50/75/100% for 4 steps.
    float block = max(1.0, pixelSize * max(zoom, 0.01));
    vec2 blockCenter = (floor(px / block) + 0.5) * block;
    float t = vignetteT(blockCenter, band);
    shade = (max(0.0, ceil(t * steps - 0.000001)) / steps) * strength;
  }
  gl_FragColor = vec4(texel.rgb * (1.0 - shade), texel.a);
}
`;

export class VignettePipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  /** 0 = smooth, 1 = pixel — see `setStyle`. */
  mode = 0;
  strength = 0;
  steps = 4;
  pixelSize = 4;
  zoom = 1;
  size = 0.12;

  constructor(game: Phaser.Game) {
    super({ game, fragShader: FRAG_SHADER });
  }

  setStyle(style: 'smooth' | 'pixel'): void {
    this.mode = style === 'pixel' ? 1 : 0;
  }

  onPreRender(): void {
    this.set2f('resolution', this.renderer.width, this.renderer.height);
    this.set1f('mode', this.mode);
    this.set1f('strength', this.strength);
    this.set1f('steps', this.steps);
    this.set1f('pixelSize', this.pixelSize);
    this.set1f('zoom', this.zoom);
    this.set1f('size', this.size);
  }
}
