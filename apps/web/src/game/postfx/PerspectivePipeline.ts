// apps/web/src/game/postfx/PerspectivePipeline.ts  (M17 7.3: far rows compressed, distance haze, snapped to whole screen rows)
//
// Disabled by `k = 0` (exact pass-through), never by removing the pipeline. The GLSL mirrors `perspective.ts`. Phaser's post-FX quad
// has uv.y = 0 at the BOTTOM of the screen, so `t` (distance from the top) is `1 - uv.y`.
import * as Phaser from 'phaser';
import { perspectiveUniforms } from './perspective';

const FRAG_SHADER = `
#define SHADER_NAME PERSPECTIVE_FS
precision mediump float;
uniform sampler2D uMainSampler;
uniform float k;
uniform float hazeStrength;
uniform vec3 haze;
uniform float texel;
varying vec2 outTexCoord;

void main() {
  vec2 uv = outTexCoord;
  if (k <= 0.0) {
    gl_FragColor = texture2D(uMainSampler, uv);
    return;
  }
  float t = 1.0 - uv.y;
  float srcT = t + k * (t - t * t);
  if (texel > 0.0) srcT = (floor(srcT / texel) + 0.5) * texel;
  vec4 c = texture2D(uMainSampler, vec2(uv.x, 1.0 - clamp(srcT, 0.0, 1.0)));
  gl_FragColor = vec4(mix(c.rgb, haze, hazeStrength * (1.0 - t)), c.a);
}
`;

export class PerspectivePipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  perspective = 0;
  zoom = 1;
  bgColor = 0;

  constructor(game: Phaser.Game) {
    super({ game, fragShader: FRAG_SHADER });
  }

  onPreRender(): void {
    const u = perspectiveUniforms(this.perspective, this.zoom, this.renderer.height, this.bgColor);
    this.set1f('k', u.k);
    this.set1f('hazeStrength', u.hazeStrength);
    this.set3f('haze', u.haze[0], u.haze[1], u.haze[2]);
    this.set1f('texel', u.texel);
  }
}
