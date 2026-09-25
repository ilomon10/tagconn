import type { RoomType, Zone } from '@tagconn/shared';
import type * as Phaser from 'phaser';
import { paintModernDecorTextures, modernDecorFor } from './paint/decor';
import { paintModernFloor } from './paint/floors';
import { paintModernFurniture } from './paint/furniture';
import { paintModernDoor, paintModernVoid, paintModernWall } from './paint/walls';
import type { Costume, ThemeDefinition } from './types';

/** A straight port of the pre-M7 office: `renderMap.ts` colours and furniture art, `ZONE_LABELS`
 *  for names, and identity titles (no guild flavour, no verbs, no fx). */

const ZONE_NAMES: Record<Zone, string> = {
  entrance: 'Entrance',
  'pm-office': 'PM Office',
  desks: 'Dev Desks',
  'meeting-room': 'Meeting Room',
  whiteboard: 'Whiteboard',
  'qa-lab': 'QA Lab',
  'review-booth': 'Review Booth',
  'server-room': 'Server Room',
  library: 'Library',
  lounge: 'Lounge',
};

const ROOM_NAMES: Record<RoomType, string> = {
  ...ZONE_NAMES,
  stairs: 'Stairs',
  hall: 'Hall',
};

// Identical to `defaultRoles.ts`'s `title` field — an identity mapping, not an override.
const ROLE_TITLES: Record<string, string> = {
  pm: 'Project Manager',
  analyst: 'Business Analyst',
  architect: 'Architect',
  developer: 'Developer',
  'qa-engineer': 'QA Engineer',
  'code-reviewer': 'Code Reviewer',
  'security-engineer': 'Security Engineer',
  'devops-engineer': 'DevOps Engineer',
  devops: 'DevOps Engineer',
  'tech-writer': 'Tech Writer',
};

// No costume art: an empty costume is a no-op (no hat, cloak, or prop overlay).
const NO_COSTUME: Costume = {};
const COSTUMES: Record<string, Costume> = { default: NO_COSTUME };

export const modernTheme: ThemeDefinition = {
  id: 'modern',
  palette: {
    bg: 0x15121e,
    floorBase: {
      hall: 0x6b4f3a,
      corridor: 0x6b4f3a,
      'pm-office': 0x7a4a3e,
      desks: 0x4a5870,
      'meeting-room': 0x56664a,
      whiteboard: 0x5a5472,
      library: 0x5e4533,
      'qa-lab': 0x8fa3aa,
      'review-booth': 0x645682,
      'server-room': 0x3a4252,
      lounge: 0x7d6848,
      entrance: 0x7a766d,
      stairs: 0x5d5872,
    },
    floorAccent: {
      hall: 0x5d4432,
      corridor: 0x5d4432,
      'pm-office': 0x6c4036,
      desks: 0x435066,
      'meeting-room': 0x4d5c42,
      whiteboard: 0x514b68,
      library: 0x533c2c,
      'qa-lab': 0x82979e,
      'review-booth': 0x5a4d76,
      'server-room': 0x333a48,
      lounge: 0x735f40,
      entrance: 0x6d6960,
      stairs: 0x514c66,
    },
    wallTop: 0x4c4468,
    wallFace: 0x2d2742,
    wallEdge: 0x625a85,
    void: 0x0d0d12,
    text: '#f3e9d2',
    labelBg: '#15121ecc',
    transition: 0x15121e,
  },
  paintFloor: paintModernFloor,
  paintWall: paintModernWall,
  paintVoid: paintModernVoid,
  paintDoor: paintModernDoor,
  paintFurniture: paintModernFurniture,
  // Static art only (a framed poster on `wall-hanging` slots) — nothing animated, so
  // `ambientEffects` never creates a tween here either way.
  animate: (scene, map) => {
    paintModernDecorTextures(scene);
    const T = map.tileSize;
    const created: Phaser.GameObjects.GameObject[] = [];
    for (const slot of map.decor) {
      const key = modernDecorFor(slot);
      if (!key) continue;
      created.push(scene.add.image(slot.x * T + T / 2, slot.y * T + T / 2, key).setDepth(slot.y * T));
    }
    return created;
  },
  decorFor: modernDecorFor,
  zoneNames: ZONE_NAMES,
  roomNames: ROOM_NAMES,
  roleTitles: ROLE_TITLES,
  costumes: COSTUMES,
  activityVerbs: {},
  activityFx: {},
  lighting: { dayTint: 0xffffff, nightTint: 0x0b1030, nightAlpha: 0.42, glowAtNight: false },
  floorLabel: (index, projectName) => `Floor ${index + 1} — ${projectName}`,
};

/** Idempotent (guarded by `textures.exists`); call once during scene `create()` before rendering. */
export { paintModernDecorTextures };
