import * as Phaser from 'phaser';
import { generateMap } from '../../game/procgen';
import type { GeneratedMap } from '../../game/procgen';
import { getTheme, paintCostumeTextures, prefersReducedMotion, type ThemeDefinition } from '../../game/themes';
import type { OfficeLayoutInput, OfficeStyle } from '@tagconn/shared';
import { draftAsLayout } from '../../stores/editorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { generateTextures } from '../../game/textures';
import { Character } from '../../game/actors/Character';
import { PathFinder } from '../../game/pathfinding';
import { CLASS_K, navPointOfTile } from '../../game/nav';
import { resolveCostume } from '../../game/lookResolver';
import { renderFloor, type FloorRender } from '../../game/depth/renderFloor';
import type { Point } from '../../game/procgen/types';
import { pickWanderTile } from './wander';

/**
 * The Hall Planner's live preview pane (guild-hall.md section 5): `generateMap(draft)` through the
 * selected theme, with a few wandering demo characters so the style (costumes, fx, lighting) reads
 * before it's assigned to a real floor. Not the game's `OfficeScene` — no agents; the wanderers are real
 * `Character`s walking real navigator paths, and the floor renders through `renderFloor` (y-sorted sprites).
 */

const WANDERER_COLORS = [0xf5c07a, 0x8ecae6, 0xb07aff];
const WANDER_SPEED = 90;

interface Wanderer {
  character: Character;
  /** Scene time (ms) at which it picks its next destination. */
  nextAt: number;
}

export class PreviewScene extends Phaser.Scene {
  private map: GeneratedMap;
  private theme: ThemeDefinition;
  private ambient: boolean;
  /** M15: `office.dualGrid` — the preview paints with the same edge pass as the live office. */
  private dualGrid: boolean;
  /** M17: `office.depth.sprites` / `maxSprites` — the preview renders furniture the way the live office does. */
  private depth: { sprites: boolean; maxSprites: number };
  private floor: FloorRender | null = null;
  private finder: PathFinder | null = null;
  private fxObjects: Phaser.GameObjects.GameObject[] = [];
  private wanderers: Wanderer[] = [];
  private isPanning = false;
  private lastPointer = { x: 0, y: 0 };

  constructor(map: GeneratedMap, theme: ThemeDefinition, ambient: boolean, dualGrid = true, depth = { sprites: true, maxSprites: 1500 }) {
    super('hall-planner-preview');
    this.map = map;
    this.theme = theme;
    this.ambient = ambient;
    this.dualGrid = dualGrid;
    this.depth = depth;
  }

  /** Recomputes and repaints for a new draft/style, without recreating the Phaser.Game. */
  rebuild(map: GeneratedMap, theme: ThemeDefinition, ambient: boolean, dualGrid = this.dualGrid, depth = this.depth) {
    this.map = map;
    this.theme = theme;
    this.ambient = ambient;
    this.dualGrid = dualGrid;
    this.depth = depth;
    this.wanderers.forEach((w) => w.character.destroyAll());
    this.wanderers = [];
    this.floor?.destroy();
    this.floor = null;
    this.children.removeAll(true);
    this.fxObjects.forEach((o) => o.destroy());
    this.fxObjects = [];
    this.build();
  }

  create() {
    // Theme fx (torch flames, ambient dots) use the shared 'icon-sparkle' texture, which only OfficeScene generated.
    generateTextures(this);
    paintCostumeTextures(this);
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
    this.floor = renderFloor(this, this.map, this.theme, [], { dualGrid: this.dualGrid, ...this.depth });
    this.finder = new PathFinder(this.map.nav);
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

  /** Real characters on the spawn tile; `update` sends each on a navigator path to a random walkable tile. */
  private spawnWanderers(n: number) {
    const costume = resolveCostume(this.theme, 'developer');
    for (let i = 0; i < n; i++) {
      const character = new Character(this, `npc:preview-${i}`, 0, 0);
      character.setCostume(costume, WANDERER_COLORS[i % WANDERER_COLORS.length]!);
      character.teleport(this.map.spawn);
      this.wanderers.push({ character, nextAt: 400 * i });
    }
  }

  update(time: number, delta: number) {
    for (const w of this.wanderers) {
      const c = w.character;
      if (!c.walking && time >= w.nextAt) {
        const to = pickWanderTile(this.map, this.map.spawn);
        const path = to && this.finder?.navigator().findPath(c.navPoint, navPointOfTile(to, CLASS_K[c.navClass]), c.navClass);
        if (path) c.walkNav(path, false);
        w.nextAt = time + 700 + Math.random() * 1400;
      }
      c.update(time, delta, this.ambient ? WANDER_SPEED : 0);
    }
  }
}

/** Builds the first frame's map + scene inputs for a draft, given the preview's chosen style. */
export function buildPreview(draft: OfficeLayoutInput, style: OfficeStyle): { map: GeneratedMap; theme: ThemeDefinition } {
  const map = generateMap({ ...draftAsLayout(draft), style });
  return { map, theme: getTheme(style) };
}

/** The server's `office.dualGrid` (default on): the Hall Planner has no per-draft toggle, it previews the setting. */
function currentDualGrid(): boolean {
  return useSettingsStore.getState().settings.office.dualGrid ?? true;
}

/** M17 `office.depth.sprites` / `maxSprites`: the preview shows what the live floor will. */
function currentDepth(): { sprites: boolean; maxSprites: number } {
  const d = useSettingsStore.getState().settings.office.depth;
  return { sprites: d?.sprites ?? true, maxSprites: d?.maxSprites ?? 1500 };
}

/** A small wrapper Phaser.Game so the host component doesn't need to know Phaser's config shape. */
export class PreviewGame {
  private game: Phaser.Game;
  private scene: PreviewScene;

  constructor(parent: HTMLElement, draft: OfficeLayoutInput, style: OfficeStyle) {
    const { map, theme } = buildPreview(draft, style);
    const ambient = !prefersReducedMotion();
    this.scene = new PreviewScene(map, theme, ambient, currentDualGrid(), currentDepth());
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
    this.scene.rebuild(map, theme, !prefersReducedMotion(), currentDualGrid(), currentDepth());
  }

  destroy() {
    this.game.destroy(true);
  }
}
