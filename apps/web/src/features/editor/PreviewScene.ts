import * as Phaser from 'phaser';
import { generateMap } from '../../game/procgen';
import type { GeneratedMap } from '../../game/procgen';
import { getTheme, prefersReducedMotion, renderGeneratedMap, type ThemeDefinition } from '../../game/themes';
import type { OfficeLayoutInput, OfficeStyle } from '@tagconn/shared';
import { draftAsLayout } from '../../stores/editorStore';

/**
 * The Hall Planner's live preview pane (guild-hall.md section 5): `generateMap(draft)` through the
 * selected theme, with a few wandering demo characters so the style (costumes, fx, lighting) reads
 * before it's assigned to a real floor. Not the game's `OfficeScene` — no agents, no pathfinding,
 * just "does this look right".
 */

const WANDERER_COLORS = [0xf5c07a, 0x8ecae6, 0xb07aff];

interface Wanderer {
  sprite: Phaser.GameObjects.Arc;
  tile: { x: number; y: number };
  timer: Phaser.Time.TimerEvent;
}

export class PreviewScene extends Phaser.Scene {
  private map: GeneratedMap;
  private theme: ThemeDefinition;
  private ambient: boolean;
  private fxObjects: Phaser.GameObjects.GameObject[] = [];
  private wanderers: Wanderer[] = [];
  private isPanning = false;
  private lastPointer = { x: 0, y: 0 };

  constructor(map: GeneratedMap, theme: ThemeDefinition, ambient: boolean) {
    super('hall-planner-preview');
    this.map = map;
    this.theme = theme;
    this.ambient = ambient;
  }

  /** Recomputes and repaints for a new draft/style, without recreating the Phaser.Game. */
  rebuild(map: GeneratedMap, theme: ThemeDefinition, ambient: boolean) {
    this.map = map;
    this.theme = theme;
    this.ambient = ambient;
    this.children.removeAll(true);
    this.fxObjects.forEach((o) => o.destroy());
    this.fxObjects = [];
    this.wanderers.forEach((w) => w.timer.remove());
    this.wanderers = [];
    this.build();
  }

  create() {
    this.cameras.main.setBackgroundColor(this.theme.palette.bg);
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.isPanning = true;
      this.lastPointer = { x: p.x, y: p.y };
    });
    this.input.on('pointerup', () => {
      this.isPanning = false;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.isPanning || !p.isDown) return;
      const cam = this.cameras.main;
      cam.scrollX -= (p.x - this.lastPointer.x) / cam.zoom;
      cam.scrollY -= (p.y - this.lastPointer.y) / cam.zoom;
      this.lastPointer = { x: p.x, y: p.y };
    });
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      const cam = this.cameras.main;
      cam.zoom = Phaser.Math.Clamp(cam.zoom * Math.exp(-dy * 0.001), 0.5, 3);
    });
    this.build();
  }

  private build() {
    const key = renderGeneratedMap(this, this.map, this.theme);
    this.add.image(0, 0, key).setOrigin(0, 0);
    this.fxObjects = this.theme.animate(this, this.map, { ambient: this.ambient });

    const worldW = this.map.cols * this.map.tileSize;
    const worldH = this.map.rows * this.map.tileSize;
    this.cameras.main.setBounds(-worldW, -worldH, worldW * 3, worldH * 3); // generous: panning shouldn't hard-clip a small preview
    this.fitCamera(worldW, worldH);
    this.spawnWanderers(3);
  }

  private fitCamera(worldW: number, worldH: number) {
    const cam = this.cameras.main;
    const zoom = Math.min(cam.width / worldW, cam.height / worldH, 2) || 1;
    cam.setZoom(Math.max(0.2, zoom * 0.92));
    cam.centerOn(worldW / 2, worldH / 2);
  }

  /** Cardinal-adjacent random walk so wanderers never cut through a wall (guild-hall.md "3 wandering demo characters"). */
  private spawnWanderers(n: number) {
    const T = this.map.tileSize;
    const start = this.map.spawn;
    for (let i = 0; i < n; i++) {
      const tile = { ...start };
      const sprite = this.add.circle(tile.x * T + T / 2, tile.y * T + T / 2, T * 0.28, WANDERER_COLORS[i % WANDERER_COLORS.length]);
      sprite.setStrokeStyle(1, 0x000000, 0.35);
      const wanderer: Wanderer = { sprite, tile, timer: this.scheduleNextHop(sprite, tile) };
      this.wanderers.push(wanderer);
    }
  }

  private neighbors(x: number, y: number): { x: number; y: number }[] {
    const cand = [
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 },
    ];
    return cand.filter((c) => c.y >= 0 && c.y < this.map.rows && c.x >= 0 && c.x < this.map.cols && this.map.walkable[c.y]?.[c.x] === 0);
  }

  private scheduleNextHop(sprite: Phaser.GameObjects.Arc, tile: { x: number; y: number }): Phaser.Time.TimerEvent {
    return this.time.addEvent({
      delay: 700 + Math.random() * 1400,
      callback: () => {
        const options = this.neighbors(tile.x, tile.y);
        const next = options.length ? options[Math.floor(Math.random() * options.length)]! : tile;
        tile.x = next.x;
        tile.y = next.y;
        const T = this.map.tileSize;
        this.tweens.add({ targets: sprite, x: next.x * T + T / 2, y: next.y * T + T / 2, duration: this.ambient ? 450 : 0, ease: 'Sine.easeInOut' });
        const w = this.wanderers.find((w2) => w2.sprite === sprite);
        if (w) w.timer = this.scheduleNextHop(sprite, tile);
      },
    });
  }
}

/** Builds the first frame's map + scene inputs for a draft, given the preview's chosen style. */
export function buildPreview(draft: OfficeLayoutInput, style: OfficeStyle): { map: GeneratedMap; theme: ThemeDefinition } {
  const map = generateMap({ ...draftAsLayout(draft), style });
  return { map, theme: getTheme(style) };
}

/** A small wrapper Phaser.Game so the host component doesn't need to know Phaser's config shape. */
export class PreviewGame {
  private game: Phaser.Game;
  private scene: PreviewScene;

  constructor(parent: HTMLElement, draft: OfficeLayoutInput, style: OfficeStyle) {
    const { map, theme } = buildPreview(draft, style);
    const ambient = !prefersReducedMotion();
    this.scene = new PreviewScene(map, theme, ambient);
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      pixelArt: true,
      backgroundColor: '#15121e',
      scale: { mode: Phaser.Scale.RESIZE, width: parent.clientWidth || 400, height: parent.clientHeight || 300 },
      scene: this.scene,
      banner: false,
      audio: { noAudio: true },
      input: { mouse: { preventDefaultWheel: true } },
    });
  }

  update(draft: OfficeLayoutInput, style: OfficeStyle) {
    const { map, theme } = buildPreview(draft, style);
    this.scene.rebuild(map, theme, !prefersReducedMotion());
  }

  destroy() {
    this.game.destroy(true);
  }
}
