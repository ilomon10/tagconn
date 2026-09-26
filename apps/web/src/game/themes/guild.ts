import type { RoomType, Zone } from '@tagconn/shared';
import type * as Phaser from 'phaser';
import type { GeneratedMap } from '../procgen/types';
import { GUILD_GLOW, GUILD_TORCH, guildDecorFor, paintGuildDecorTextures } from './paint/decor';
import { paintGuildFloor } from './paint/floors';
import { paintGuildFurniture } from './paint/furniture';
import { paintGuildWallDecor } from './paint/wallDecor';
import { paintGuildBackWall, paintGuildDoor, paintGuildVoid, paintGuildWall } from './paint/walls';
import type { Costume, ThemeDefinition } from './types';
import { ambientMotes, channelAura, portalShimmer, potionBubbles, prefersReducedMotion, runeGlow, torchFlicker } from './fx';

// `Phaser.BlendModes.ADD` (only a type import of `phaser` is safe under vitest's node
// environment — see fx.ts).
const BLEND_ADD = 1;

/** The magic guild hall: a medieval-fantasy skin, drawn entirely in code. See
 *  docs/design/guild-hall.md section 3 for the recipes this ports. */

const ZONE_NAMES: Record<Zone, string> = {
  entrance: 'Guild Gate',
  'pm-office': "Guild Master's Hall",
  desks: "Artificers' Workshop",
  'meeting-room': 'War Council',
  whiteboard: 'Map Room',
  'qa-lab': 'Alchemy Lab',
  'review-booth': "Scribes' Alcove",
  'server-room': 'Arcane Vault',
  library: 'Grand Library',
  lounge: 'Tavern',
};

const ROOM_NAMES: Record<RoomType, string> = {
  ...ZONE_NAMES,
  stairs: 'Portal Stairs',
  hall: 'Great Hall',
};

const ROLE_TITLES: Record<string, string> = {
  pm: 'Guild Master',
  analyst: 'Oracle',
  architect: 'Archmage',
  developer: 'Artificer',
  'qa-engineer': 'Alchemist',
  'code-reviewer': 'Scribe',
  'security-engineer': 'Paladin',
  devops: 'Blacksmith',
  'devops-engineer': 'Blacksmith',
  'tech-writer': 'Bard',
};

const GOLD = 0xe8c070;
const SILVER = 0xc9d6e8;

const COSTUMES: Record<string, Costume> = {
  pm: { robe: 0x9c2a3a, cloak: 0x6b1b26, hat: 'crown', hatColor: GOLD, staff: 'staff', trim: GOLD },
  analyst: { robe: 0xa8d8ff, cloak: 0x7fb8ea, hat: 'circlet', hatColor: SILVER, staff: 'wand', trim: SILVER },
  architect: { robe: 0x4a2a6a, cloak: 0x36204f, hat: 'wizard', hatColor: 0x4a2a6a, staff: 'staff', trim: 0xc9a6ff },
  developer: { robe: 0x6b4a2c, hat: 'none', staff: 'hammer', trim: 0xb5895a, goggles: true },
  'qa-engineer': { robe: 0x3f6b4a, cloak: 0x2c5238, hat: 'hood', staff: 'none', trim: 0x7ef0a0, goggles: true },
  'code-reviewer': { robe: 0x5a4430, cloak: 0x46341f, hat: 'hood', staff: 'quill', trim: 0xd8c9a0 },
  'security-engineer': { robe: 0x8a94a6, cloak: 0x5a6272, hat: 'helm', hatColor: 0x8a94a6, staff: 'shield', trim: 0xe6ecf5 },
  devops: { robe: 0x2e2a26, hat: 'none', staff: 'hammer', trim: 0x8a94a6 },
  'devops-engineer': { robe: 0x2e2a26, hat: 'none', staff: 'hammer', trim: 0x8a94a6 },
  'tech-writer': { robe: 0x2f8a82, hat: 'bard-cap', hatColor: 0x2f8a82, staff: 'lute', trim: GOLD },
  // Unknown roles: a hood and a cloak tinted with `role.color` (no fixed `cloak` here).
  default: { hat: 'hood' },
};

const ACTIVITY_VERBS: ThemeDefinition['activityVerbs'] = {
  idle: 'Resting at the tavern',
  thinking: 'Pondering',
  typing: 'Inscribing runes',
  reading: 'Studying tomes',
  searching: 'Scrying',
  running: 'Channeling',
  testing: 'Brewing potions',
  browsing: 'Consulting the stars',
  meeting: 'Holding council',
  delegating: 'Issuing a quest',
  waiting: 'Awaiting the Master',
  blocked: 'Cursed! Needs aid',
  done: 'Quest complete',
};

const ACTIVITY_FX: ThemeDefinition['activityFx'] = {
  typing: 'sparkles',
  testing: 'bubbles',
  delegating: 'rune',
  running: 'channel',
  blocked: 'channel',
  done: 'sparkles',
};

function animate(scene: Phaser.Scene, map: GeneratedMap, opts: { ambient: boolean }): Phaser.GameObjects.GameObject[] {
  paintGuildDecorTextures(scene);
  const T = map.tileSize;
  const enabled = opts.ambient && !prefersReducedMotion();
  const created: Phaser.GameObjects.GameObject[] = [];

  // Torches and banners: the bracket/cloth are static art; the flame flicker and light pool only
  // exist when ambient effects are on.
  for (const slot of map.decor) {
    const cx = slot.x * T + T / 2;
    const cy = slot.y * T + T / 2;
    if (slot.kind === 'wall-light') {
      const bracket = scene.add.image(cx, cy, GUILD_TORCH).setDepth(slot.y * T + 1);
      created.push(bracket);
      if (enabled) {
        const pool = scene.add.image(cx, cy, GUILD_GLOW).setAlpha(0.15).setBlendMode(BLEND_ADD).setDepth(slot.y * T);
        const flame = scene.add.image(cx, cy - 5, 'icon-sparkle').setTint(0xff8a3a).setScale(0.6).setDepth(slot.y * T + 2);
        created.push(pool, flame);
        torchFlicker(scene, flame, true);
      }
    } else if (slot.kind === 'wall-hanging') {
      const key = guildDecorFor(slot);
      if (key) created.push(scene.add.image(cx, cy, key).setDepth(slot.y * T));
    }
  }

  for (const f of map.furniture) {
    const cx = (f.x + f.w / 2) * T;
    const cy = (f.y + f.h / 2) * T;
    if (f.kind === 'sigil') {
      created.push(runeGlow(scene, cx, cy, enabled, 0x6ff5ff, Math.min(f.w, f.h) * 0.55));
    } else if (f.kind === 'centerpiece' && f.roomType === 'qa-lab') {
      created.push(potionBubbles(scene, cx, cy - T / 2, enabled, 0x7ef0a0));
    } else if (f.kind === 'pedestal' && f.roomType === 'server-room') {
      created.push(channelAura(scene, cx, cy - T / 4, enabled, 0x9fd8ff, 0.35));
    } else if (f.kind === 'fireplace' && enabled) {
      // M8 8p: the flicker itself is a separate sprite over the static hearth art (`furniture.ts`),
      // matching the sigil/pedestal pattern — disabled entirely when ambient effects are off.
      const flame = scene.add.image(cx, cy - T / 2 - 2, 'icon-sparkle').setTint(0xff8a3a).setScale(0.7).setDepth(f.y * T + f.h * T + 2);
      created.push(flame);
      torchFlicker(scene, flame, true);
    }
  }

  for (const s of map.stairs) {
    const color = s.dir === 'up' ? 0x4ff0d0 : 0xb07aff;
    created.push(portalShimmer(scene, s.x * T + T / 2, s.y * T + T / 2, enabled, color, 1.1));
  }

  // Ambient dust/magic motes: about 1 per 60 tiles, capped at 150.
  if (enabled) {
    const cap = 150;
    const step = 8; // ~1 sample per 64 tiles
    const positions: { x: number; y: number }[] = [];
    for (let y = step; y < map.rows && positions.length < cap; y += step) {
      for (let x = step; x < map.cols && positions.length < cap; x += step) {
        if (map.tiles[y]?.[x] === 'floor') positions.push({ x: x * T, y: y * T });
      }
    }
    created.push(ambientMotes(scene, positions, true, 0xcac0ff));
  }

  return created;
}

export const guildTheme: ThemeDefinition = {
  id: 'guild',
  palette: {
    bg: 0x120f1c,
    floorBase: {
      hall: 0x4a4458,
      corridor: 0x3e394c,
      entrance: 0x4a4458,
      'pm-office': 0x4a4458,
      whiteboard: 0x4a4458,
      'review-booth': 0x4a4458,
      stairs: 0x4a4458,
      desks: 0x6b4f3a,
      library: 0x4a3324,
      lounge: 0x4a3324,
      'server-room': 0x1c2230,
      'qa-lab': 0x4a5a4a,
      'meeting-room': 0x6d6478,
    },
    floorAccent: {
      hall: 0x3a3446,
      corridor: 0x3a3446,
      entrance: 0x3a3446,
      'pm-office': 0x3a3446,
      whiteboard: 0x3a3446,
      'review-booth': 0x3a3446,
      stairs: 0x3a3446,
      desks: 0x5d4432,
      library: 0x3a2818,
      lounge: 0x3a2818,
      'server-room': 0x2c7a7a,
      'qa-lab': 0x3d4b3d,
      'meeting-room': 0x5a5268,
    },
    wallTop: 0x5a5068,
    wallFace: 0x2e283c,
    wallEdge: 0x746a88,
    void: 0x0e0b14,
    text: '#e8d9b0',
    labelBg: '#1c1430cc',
    transition: 0x0e0b14,
  },
  paintFloor: paintGuildFloor,
  paintWall: paintGuildWall,
  paintVoid: paintGuildVoid,
  paintDoor: paintGuildDoor,
  paintFurniture: paintGuildFurniture,
  // M8 8p: the tall 3/4 back-wall face + baked wall decor (docs/design/back-wall.md).
  backWall: { capPx: 2, bandPx: 10 },
  paintBackWall: paintGuildBackWall,
  paintWallDecor: paintGuildWallDecor,
  animate,
  decorFor: guildDecorFor,
  zoneNames: ZONE_NAMES,
  roomNames: ROOM_NAMES,
  roleTitles: ROLE_TITLES,
  costumes: COSTUMES,
  activityVerbs: ACTIVITY_VERBS,
  activityFx: ACTIVITY_FX,
  lighting: { dayTint: 0xfff1d6, nightTint: 0x1b1030, nightAlpha: 0.5, glowAtNight: true },
  floorLabel: (index, projectName) => `Floor ${index + 1} · ${projectName}`,
};
