import type { RoomType, Zone } from '@tagconn/shared';
import { MULTIVERSE_LIMITS } from '@tagconn/shared';
import type * as Phaser from 'phaser';
import type { GeneratedMap } from '../procgen/types';
import { guildTheme } from './guild';
import { paintRiftDecorTextures, riftDecorFor, RIFT_AURORA, RIFT_GLOW, riftBanner } from './paint/riftDecor';
import { paintRiftFloor } from './paint/riftFloors';
import { paintRiftFurniture } from './paint/riftFurniture';
import { paintRiftBackWall, paintRiftDoor, paintRiftIslandEdge, paintRiftVoid, paintRiftWall, paintRiftWallDecor } from './paint/riftWalls';
import type { ThemeDefinition } from './types';
import { ambientMotes, ensureFxTextures, portalShimmer, prefersReducedMotion } from './fx';

// `Phaser.BlendModes.ADD` (only a type import of `phaser` is safe under vitest's node environment
// — see fx.ts).
const BLEND_ADD = 1;

/**
 * The Multiverse's own web-only "rift" style: a starfield/aurora/floating-island look for the
 * Nexus, the void, and the rift corridors that join every project's realm. Never a user-selectable
 * `OfficeStyle` (see `MULTIVERSE_THEME_ID`); role titles and costumes are the guild's, so heroes
 * keep their look when they walk out of their realm and into the Nexus. See
 * docs/design/living-office.md section 6.2.
 */

// Every zone/room name reads "Nexus …" per the design doc, even though in practice only `entrance`
// and `stairs` are ever painted by rift (every other room type belongs to a realm, which is always
// painted by that realm's own project theme — see `renderTheme.ts`'s per-region `themeAt`).
const ZONE_NAMES: Record<Zone, string> = {
  entrance: 'Nexus Plaza',
  'pm-office': 'Nexus Overlook',
  desks: 'Nexus Concourse',
  'meeting-room': 'Nexus Council',
  whiteboard: 'Nexus Archive',
  'qa-lab': 'Nexus Forge',
  'review-booth': 'Nexus Alcove',
  'server-room': 'Nexus Vault',
  library: 'Nexus Athenaeum',
  lounge: 'Nexus Respite',
};

const ROOM_NAMES: Record<RoomType, string> = {
  ...ZONE_NAMES,
  stairs: 'Rift Stairs',
  hall: 'Rift Span',
};

const CRYSTAL_BASE = 0x2a2350;
const CRYSTAL_ACCENT = 0x3a3370;
const BRIDGE_BASE = 0x1c1a2e;
const BRIDGE_ACCENT = 0x2c2a44;

const FLOOR_BASE: Record<RoomType | 'corridor', number> = {
  entrance: CRYSTAL_BASE,
  stairs: CRYSTAL_BASE,
  'pm-office': CRYSTAL_BASE,
  desks: CRYSTAL_BASE,
  'meeting-room': CRYSTAL_BASE,
  whiteboard: CRYSTAL_BASE,
  'qa-lab': CRYSTAL_BASE,
  'review-booth': CRYSTAL_BASE,
  'server-room': CRYSTAL_BASE,
  library: CRYSTAL_BASE,
  lounge: CRYSTAL_BASE,
  hall: BRIDGE_BASE,
  corridor: BRIDGE_BASE,
};
const FLOOR_ACCENT: Record<RoomType | 'corridor', number> = {
  entrance: CRYSTAL_ACCENT,
  stairs: CRYSTAL_ACCENT,
  'pm-office': CRYSTAL_ACCENT,
  desks: CRYSTAL_ACCENT,
  'meeting-room': CRYSTAL_ACCENT,
  whiteboard: CRYSTAL_ACCENT,
  'qa-lab': CRYSTAL_ACCENT,
  'review-booth': CRYSTAL_ACCENT,
  'server-room': CRYSTAL_ACCENT,
  library: CRYSTAL_ACCENT,
  lounge: CRYSTAL_ACCENT,
  hall: BRIDGE_ACCENT,
  corridor: BRIDGE_ACCENT,
};

/** 2 or 3 wide, low-alpha aurora ribbons drifting across the void (additive, alpha 0.08-0.18). */
function auroraRibbons(scene: Phaser.Scene, map: GeneratedMap, count: number): Phaser.GameObjects.GameObject[] {
  const created: Phaser.GameObjects.GameObject[] = [];
  const width = map.cols * map.tileSize;
  for (let i = 0; i < count; i++) {
    const y = ((i + 1) / (count + 1)) * map.rows * map.tileSize;
    // `RIFT_AURORA` is a 64x16 texture; scale it up to a wide, short strip spanning the void.
    const img = scene.add
      .image(width / 2, y, RIFT_AURORA)
      .setScale((width * 1.4) / 64, (map.tileSize * 3) / 16)
      .setAlpha(0.08 + i * 0.03)
      .setBlendMode(BLEND_ADD)
      .setDepth(-1);
    created.push(img);
    scene.tweens.add({
      targets: img,
      x: { from: width * 0.35, to: width * 0.65 },
      duration: 12000 + i * 2500,
      yoyo: true,
      repeat: -1,
    });
  }
  return created;
}

function animate(scene: Phaser.Scene, map: GeneratedMap, opts: { ambient: boolean; motes?: boolean; budget?: number }): Phaser.GameObjects.GameObject[] {
  paintRiftDecorTextures(scene);
  ensureFxTextures(scene);
  const T = map.tileSize;
  const enabled = opts.ambient && !prefersReducedMotion();
  const created: Phaser.GameObjects.GameObject[] = [];
  // The scene's shared ambient budget, split evenly across regions with rift taking a third
  // (docs/design/living-office.md section 6.2). `motes` distinguishes the one global rift call
  // (`true`) from the per-realm calls the scene makes with `motes: false`.
  const budget = opts.budget ?? Math.floor(MULTIVERSE_LIMITS.maxAmbientObjects / 3);
  let spent = 0;
  const withinBudget = () => spent < budget;

  for (const slot of map.decor) {
    const cx = slot.x * T + T / 2;
    const cy = slot.y * T + T / 2;
    if (slot.kind === 'wall-light') {
      const lantern = scene.add.image(cx, cy, riftDecorFor(slot) ?? '').setDepth(slot.y * T + 1);
      created.push(lantern);
      if (enabled && withinBudget()) {
        const pool = scene.add.image(cx, cy, RIFT_GLOW).setAlpha(0.14).setBlendMode(BLEND_ADD).setDepth(slot.y * T);
        created.push(pool);
        scene.tweens.add({ targets: pool, alpha: { from: 0.08, to: 0.2 }, duration: 900 + Math.random() * 300, yoyo: true, repeat: -1 });
        spent++;
      }
    } else if (slot.kind === 'wall-hanging') {
      created.push(scene.add.image(cx, cy, riftBanner(slot.variant)).setDepth(slot.y * T));
    }
  }

  for (const s of map.stairs) {
    const color = s.dir === 'up' ? 0x4ff0d0 : 0xd94ff0;
    created.push(portalShimmer(scene, s.x * T + T / 2, s.y * T + T / 2, enabled, color, 1.1));
  }

  if (enabled && opts.motes !== false) {
    if (withinBudget()) {
      const auroraCount = Math.min(3, Math.max(0, 2 + (Math.random() < 0.5 ? 0 : 1)));
      created.push(...auroraRibbons(scene, map, auroraCount));
      spent += auroraCount;
    }
    // Star twinkle: up to 40 sampled void tiles get a small drifting/pulsing mote, capped by the
    // remaining budget too.
    const remaining = Math.max(0, budget - spent);
    const cap = Math.min(40, remaining);
    if (cap > 0) {
      const step = Math.max(4, Math.floor(Math.sqrt((map.cols * map.rows) / cap)));
      const positions: { x: number; y: number }[] = [];
      for (let y = step; y < map.rows && positions.length < cap; y += step) {
        for (let x = step; x < map.cols && positions.length < cap; x += step) {
          if (map.tiles[y]?.[x] === 'void') positions.push({ x: x * T, y: y * T });
        }
      }
      created.push(ambientMotes(scene, positions, true, 0xcac0ff));
      spent += positions.length;
    }
  }

  return created;
}

export const riftTheme: ThemeDefinition = {
  id: 'rift',
  palette: {
    bg: 0x0b0820,
    floorBase: FLOOR_BASE,
    floorAccent: FLOOR_ACCENT,
    wallTop: 0x161022,
    wallFace: 0x0e0a18,
    wallEdge: 0x1f5a5a,
    void: 0x0b0820,
    text: '#dcd4ff',
    labelBg: '#100c22cc',
    transition: 0x0b0820,
  },
  paintFloor: paintRiftFloor,
  paintWall: paintRiftWall,
  paintVoid: paintRiftVoid,
  paintDoor: paintRiftDoor,
  paintFurniture: paintRiftFurniture,
  paintIslandEdge: paintRiftIslandEdge,
  // M8 8p: the tall 3/4 back-wall face + baked wall decor (docs/design/back-wall.md) — optional
  // hooks, so the Nexus renders with the tall face too even though every realm room is normally
  // covered by its own project theme.
  backWall: { capPx: 3, bandPx: 6 },
  paintBackWall: paintRiftBackWall,
  paintWallDecor: paintRiftWallDecor,
  animate,
  decorFor: riftDecorFor,
  zoneNames: ZONE_NAMES,
  roomNames: ROOM_NAMES,
  // Heroes keep the guild's role flavour when they step from their realm into the Nexus (section 6.2).
  roleTitles: guildTheme.roleTitles,
  costumes: guildTheme.costumes,
  activityVerbs: guildTheme.activityVerbs,
  activityFx: guildTheme.activityFx,
  lighting: { dayTint: 0xd6d0ff, nightTint: 0x0b0820, nightAlpha: 0.55, glowAtNight: true },
  floorLabel: () => 'The Multiverse',
};
