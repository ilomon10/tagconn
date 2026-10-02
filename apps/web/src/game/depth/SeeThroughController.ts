// M17 D3: fades the tall furniture that hides a character (docs/design/depth-25d.md section 5). Per frame: collect each tracked
// character's occluders, hold them transparent for HOLD_MS after the last hit, fade the rest back. No allocation after warm-up.
import type * as Phaser from 'phaser';
import type { Settings } from '@tagconn/shared';
import type { Rect } from '../procgen/types';
import { buildSeeThroughIndex, headRectOf, occludersOf } from './seeThrough';
import type { FurnitureSprite, SeeThroughIndex } from './types';

/** How long a sprite stays faded after it last hid someone (hysteresis against flicker at the edge of a bookcase). */
export const HOLD_MS = 120;
/** Most occluders one character can have at once (a head spans at most 2 x 2 tiles; sprites overlap a few deep). */
const MAX_PER_CHARACTER = 32;

/** The part of an image the controller drives. `active === false` marks a destroyed image (skipped on restore). */
export interface AlphaHandle {
  setAlpha(a: number): unknown;
  active?: boolean;
}

/** What `renderFloor` hands over: `images[i]` is the image of `sprites[i]`. */
export interface SeeThroughTarget {
  cols: number;
  rows: number;
  tileSize: number;
  sprites: readonly FurnitureSprite[];
  images: readonly AlphaHandle[];
}

export interface SeeThroughHost {
  /** Cast + Receptionist; NPCs are excluded so a courier never fades a bookcase. */
  characters(): Iterable<{ x: number; y: number; gone?: boolean }>;
  render(): SeeThroughTarget | null;
  reducedMotion(): boolean;
}

type DepthSettings = Settings['office']['depth'];

export class SeeThroughController {
  private alphaTarget = 1;
  private fadeMs = 160;
  private target: SeeThroughTarget | null = null;
  private index: SeeThroughIndex | null = null;
  private lastSeen = new Float64Array(0);
  private alphas = new Float64Array(0);
  /** Sprites that are faded or fading (alpha !== 1) or were hit this frame; the only ones `update` walks. */
  private active = new Int32Array(0);
  private activeCount = 0;
  private isActive = new Uint8Array(0);
  private readonly head: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly hits = new Int32Array(MAX_PER_CHARACTER);

  // `scene` is kept for symmetry with the other controllers (and future tweens); the fade is driven by `update`.
  constructor(_scene: Phaser.Scene, private host: SeeThroughHost) {}

  /** `seeThrough = 1` disables the controller: every sprite goes back to alpha 1 and nothing is touched afterwards. */
  applySettings(depth: Pick<DepthSettings, 'seeThrough' | 'seeThroughFadeMs'>): void {
    this.alphaTarget = Number.isFinite(depth.seeThrough) ? Math.max(0, Math.min(1, depth.seeThrough)) : 1;
    this.fadeMs = Math.max(0, depth.seeThroughFadeMs);
    if (this.alphaTarget >= 1) this.restoreAll();
  }

  update(time: number, delta: number): void {
    if (this.alphaTarget >= 1) return;
    const t = this.host.render();
    if (t?.sprites !== this.target?.sprites || t?.images !== this.target?.images) this.retarget(t);
    else this.target = t;
    const index = this.index;
    if (!t || !index) return;

    const head = this.head;
    const hits = this.hits;
    for (const c of this.host.characters()) {
      if (c.gone) continue;
      const n = occludersOf(index, headRectOf(c.x, c.y, head), c.y, hits);
      for (let k = 0; k < n; k++) {
        const i = hits[k]!;
        this.lastSeen[i] = time;
        if (this.isActive[i] === 0) {
          this.isActive[i] = 1;
          this.active[this.activeCount++] = i;
        }
      }
    }

    const snap = this.fadeMs <= 0 || this.host.reducedMotion();
    const step = snap ? 1 : Math.max(0, delta) / this.fadeMs;
    for (let a = 0; a < this.activeCount; ) {
      const i = this.active[a]!;
      const goal = time - this.lastSeen[i]! < HOLD_MS ? this.alphaTarget : 1;
      const cur = this.alphas[i]!;
      let next = cur;
      if (cur !== goal) {
        const d = goal - cur;
        next = Math.abs(d) <= step ? goal : cur + Math.sign(d) * step;
        this.alphas[i] = next;
        t.images[i]?.setAlpha(next);
      }
      if (next === 1 && goal === 1) {
        this.isActive[i] = 0;
        this.active[a] = this.active[--this.activeCount]!;
      } else {
        a++;
      }
    }
  }

  destroy(): void {
    this.restoreAll();
    this.target = null;
    this.index = null;
  }

  /** The floor was rebuilt (or went away): drop the old state without touching images that may be destroyed. */
  private retarget(t: SeeThroughTarget | null): void {
    this.target = t;
    this.activeCount = 0;
    if (!t) {
      this.index = null;
      return;
    }
    const n = t.sprites.length;
    this.index = buildSeeThroughIndex(t.sprites, t.cols, t.rows, t.tileSize);
    this.lastSeen = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
    this.alphas = new Float64Array(n).fill(1);
    this.active = new Int32Array(n);
    this.isActive = new Uint8Array(n);
  }

  private restoreAll(): void {
    const t = this.target;
    if (t) {
      for (let a = 0; a < this.activeCount; a++) {
        const i = this.active[a]!;
        const img = t.images[i];
        if (img && img.active !== false) img.setAlpha(1);
        this.alphas[i] = 1;
        this.isActive[i] = 0;
      }
    }
    this.activeCount = 0;
  }
}
