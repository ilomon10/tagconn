// M16 L4: furniture drop shadows (docs/design/lighting.md section 3.3). One Graphics above the base texture (-10) and below every
// character (depth >= 0), redrawn from `furnitureShadows` on each bake. Shafts live in the lightmap, not here.
import type * as Phaser from 'phaser';
import type { ShadowQuad } from './types';

export const SHADOW_DEPTH = -5;

export class ShadowLayer {
  private readonly g: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.g = scene.add.graphics().setDepth(SHADOW_DEPTH);
  }

  draw(quads: readonly ShadowQuad[]): void {
    const g = this.g;
    g.clear();
    for (const q of quads) {
      g.fillStyle(0x000000, q.alpha);
      g.fillPoints(q.points, true);
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
