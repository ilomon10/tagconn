// M16 L4: the multiply lightmap (docs/design/lighting.md section 3.2). A half/quarter-resolution RenderTexture over the world at
// depth 90 000: filled with the sun's ambient colour, then every planned light is drawn as stepped concentric bands (each band
// the star-shaped visibility polygon clipped to its radius), then the window shafts. All geometry comes from `planLightmap`.
// No Phaser value imports (blend/filter constants are inlined) so the layer loads under the node test environment.
import type * as Phaser from 'phaser';
import { VOID_AMBIENT, scaleColour } from './plan';
import type { LightmapPlan } from './types';
import { clipToRadius } from './visibility';

/** Above the base texture, banners (50 000) and the old night rectangle's slot; below the bloom `LightLayer` (95 000). */
export const LIGHTMAP_DEPTH = 90_000;
/** Phaser BlendModes: NORMAL 0, ADD 1, MULTIPLY 2. TextureFilter: LINEAR 0, NEAREST 1. */
const NORMAL = 0;
const ADD = 1;
const MULTIPLY = 2;
/** Lights drawn per `rt.draw` batch (keeps the Graphics command list short). */
const LIGHTS_PER_BATCH = 32;

export class LightmapLayer {
  readonly rt: Phaser.GameObjects.RenderTexture;
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly scale: 2 | 4;

  /** `size` from `lightmapSize`; `smooth` = LINEAR filtering (the blur on high), else NEAREST (low). */
  constructor(private scene: Phaser.Scene, size: { width: number; height: number; scale: 2 | 4 }, smooth: boolean) {
    this.scale = size.scale;
    this.rt = scene.add.renderTexture(0, 0, size.width, size.height).setOrigin(0, 0).setScale(size.scale).setDepth(LIGHTMAP_DEPTH);
    this.rt.setBlendMode(MULTIPLY);
    this.rt.texture?.setFilter?.(smooth ? 0 : 1);
    this.g = scene.make.graphics({}, false);
  }

  /** Redraws the whole lightmap from `plan`. Returns the number of polygons filled (dev log / tests). */
  bake(plan: LightmapPlan): number {
    const { rt, g } = this;
    const k = 1 / this.scale;
    rt.clear();
    rt.fill(plan.fill.color);

    let fills = 0;
    // The rift void between realms stays dark: the fill colour scaled down.
    if (plan.darkRegions.length > 0) {
      const dark = scaleColour(plan.fill.color, VOID_AMBIENT);
      for (const r of plan.darkRegions) rt.fill(dark, 1, r.x * k, r.y * k, r.w * k, r.h * k);
    }

    g.setBlendMode(ADD);
    g.clear();
    let inBatch = 0;
    for (const pl of plan.lights) {
      const o = pl.light;
      for (const band of pl.bands) {
        const pts = clipToRadius(o, pl.polygon, band.r);
        for (const p of pts) {
          p.x *= k;
          p.y *= k;
        }
        g.fillStyle(o.color, band.alpha);
        g.fillPoints(pts, true);
        fills++;
      }
      if (++inBatch >= LIGHTS_PER_BATCH) {
        rt.draw(g);
        g.clear();
        inBatch = 0;
      }
    }
    if (inBatch > 0) {
      rt.draw(g);
      g.clear();
    }

    if (plan.shafts.length > 0) {
      g.setBlendMode(NORMAL);
      for (const s of plan.shafts) {
        g.fillStyle(s.color, s.alpha);
        g.fillPoints(s.points.map((p) => ({ x: p.x * k, y: p.y * k })), true);
        fills++;
      }
      rt.draw(g);
      g.clear();
    }

    // Multiplying by white (full day, nothing lit on top) costs a draw for nothing.
    rt.setVisible(!(plan.shafts.length === 0 && plan.darkRegions.length === 0 && plan.fill.color === 0xffffff));
    return fills;
  }

  destroy(): void {
    this.g.destroy();
    this.rt.destroy();
  }
}
