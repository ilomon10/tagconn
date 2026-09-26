// apps/web/src/game/postfx/ScanlinesPipeline.ts  (M8 8o.1d: optional CRT look, modern style only)
//
// CRT scanlines plus a very mild barrel curvature and channel offset. The curvature/offset amounts
// are kept tiny (a few tenths of a texel) — enough to read as "CRT" without visibly duplicating or
// smearing pixel art edges; scanlines themselves darken existing rows rather than resampling, so
// they never blur anything either (requirement 8o.2).
import * as Phaser from 'phaser';

const FRAG_SHADER = `
#define SHADER_NAME SCANLINES_FS
precision mediump float;
uniform sampler2D uMainSampler;
uniform vec2 resolution;
uniform float strength;
uniform float time;
varying vec2 outTexCoord;

vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 offset = uv.yx * uv.yx * 0.02 * strength;
  uv = uv + uv * offset;
  return uv * 0.5 + 0.5;
}

void main() {
  vec2 uv = curve(outTexCoord);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float caber = 0.0015 * strength;
  float r = texture2D(uMainSampler, uv + vec2(caber, 0.0)).r;
  float g = texture2D(uMainSampler, uv).g;
  float b = texture2D(uMainSampler, uv - vec2(caber, 0.0)).b;
  float a = texture2D(uMainSampler, uv).a;
  vec3 c = vec3(r, g, b);
  float line = sin((uv.y * resolution.y - time * 6.0) * 3.14159);
  c *= 1.0 - (0.12 * strength) * (0.5 + 0.5 * line);
  gl_FragColor = vec4(c, a);
}
`;

export class ScanlinesPipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  /** 0 disables the effect outright (kept distinct from removing the pipeline so hot-toggling the
   *  setting doesn't need to add/remove pipelines every frame — the controller still removes it
   *  entirely when `office.shaders.scanlines` is off, this is just belt-and-braces). */
  strength = 1;
  private clock = 0;

  constructor(game: Phaser.Game) {
    super({ game, fragShader: FRAG_SHADER });
  }

  onPreRender(): void {
    this.clock += 0.016;
    this.set2f('resolution', this.renderer.width, this.renderer.height);
    this.set1f('strength', this.strength);
    this.set1f('time', this.clock);
  }
}
