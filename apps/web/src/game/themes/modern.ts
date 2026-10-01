import type { RoomType, Zone } from '@tagconn/shared';
import type * as Phaser from 'phaser';
import { paintModernDecorTextures, modernDecorFor } from './paint/decor';
import { paintModernFloor } from './paint/floors';
import { paintModernFurniture } from './paint/furniture';
import { paintModernWallDecor } from './paint/wallDecor';
import { paintModernBackWall, paintModernDoor, paintModernVoid, paintModernWall } from './paint/walls';
import type { Costume, DramaContent, ThemeDefinition } from './types';
import { SHIPPED_ROLE_TITLES } from './shippedTitles';
import { MODERN_LIFE } from './content/modernLife';
import { MODERN_NPCS } from './content/modernNpcs';

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
const ROLE_TITLES: Record<string, string> = { ...SHIPPED_ROLE_TITLES, receptionist: 'Receptionist' };

// No costume art: an empty costume is a no-op (no hat, cloak, or prop overlay).
const NO_COSTUME: Costume = {};
// The Receptionist NPC (`npc:receptionist`) gets a fixed smart-casual outfit; every agent role stays plain.
const COSTUMES: Record<string, Costume> = { default: NO_COSTUME, receptionist: { robe: 0x3f6a8f } };

/** M12 G1: office drama (docs/design/game-office.md 2.8). Short, pronoun-free lines (<= 48 chars). */
const MODERN_DRAMA: DramaContent = {
  antics: [
    { id: 'water-cooler-gossip', props: ['water-cooler'], cast: 2, lines: [
      ['Did the refactor news reach the cooler?', 'Which refactor? There are three.'],
      ['Standup ran forty minutes today.', 'Was that a sit-down?'],
    ] },
    { id: 'coffee-run', props: ['coffee-machine'], cast: 1, emote: 'mug', lines: [
      ['Coffee number four.'],
      ['This machine has better uptime than prod.'],
    ] },
    { id: 'coffee-chat', props: ['coffee-machine'], cast: 2, emote: 'mug', lines: [
      ['Decaf?', 'Deploys do not run on decaf.'],
      ['Fresh pot, fresh bugs.', 'Cheers to that.'],
    ] },
    { id: 'ping-pong', props: ['table'], cast: 2, emote: 'ball', lines: [
      ['Best of three?', 'Loser fixes the flaky test.'],
      ['Spin serve!', 'Not in the spec.'],
    ] },
    { id: 'stretching', props: [], cast: 1, emote: 'spark', lines: [
      ['Stretch break. Spine is deprecated.'],
      ['Ten squats, then one more ticket.'],
    ] },
    { id: 'phone-scrolling', props: ['sofa', 'armchair'], cast: 1, emote: 'phone', lines: [
      ['Just checking the build... and memes.'],
      ['Someone starred the repo!'],
    ] },
    { id: 'who-broke-the-build', props: ['board'], cast: 2, emote: 'laugh', lines: [
      ['Who broke the build?', 'Not here. git blame says... oh.'],
      ['CI is red again.', 'Ever tried going green?'],
    ] },
    { id: 'desk-plant-chat', props: ['plant'], cast: 1, lines: [
      ['Fern is the only one who listens.'],
      ['Photosynthesis looks so relaxing.'],
    ] },
    { id: 'fridge-mystery', props: ['fridge'], cast: 2, lines: [
      ['Whose yogurt is this?', 'The label says "do not deploy".'],
      ['Lunch vanished again.', 'The fridge keeps no secrets.'],
    ] },
    { id: 'donut-alert', props: ['counter'], cast: 2, emote: 'mug', lines: [
      ['Donuts in the kitchen!', 'Birthday, or a release?'],
    ] },
    { id: 'tabs-vs-spaces', props: [], cast: 2, emote: 'laugh', lines: [
      ['Tabs.', 'Spaces. Fight on.'],
      ['Dark mode or light mode?', 'Trick question.'],
    ] },
    { id: 'weekend-plans', props: ['sofa'], cast: 2, lines: [
      ['Plans for the weekend?', 'Finally reading the docs.'],
      ['Weekend? Sounds like a feature freeze.', 'Merge nothing, rest everything.'],
    ] },
    { id: 'whiteboard-doodle', props: ['board'], cast: 1, emote: 'spark', lines: [
      ['Architecture diagram: now with extra boxes.'],
      ['Arrows everywhere. Clarity nowhere.'],
    ] },
    { id: 'standing-desk-wobble', props: [], cast: 1, lines: [
      ['Standing desk is up. Motivation is not.'],
      ['Sit, stand, repeat. Same bugs either way.'],
    ] },
  ],
  strain: {
    tired: ['*yawn*', 'Is Friday here yet?', 'One more ticket...'],
    dizzy: ['Still compiling...', 'Taking forever...', 'The room is spinning.'],
    sweating: ['Waiting on a verdict...', 'A decision is needed here!', 'Blocked. Sweating bullets.'],
    'on-a-roll': ['On a roll!', 'Ship!', 'In the zone.'],
  },
};

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
  // M8 8p: the tall 3/4 back-wall face + baked wall decor (docs/design/back-wall.md).
  backWall: { capPx: 3, bandPx: 8 },
  paintBackWall: paintModernBackWall,
  paintWallDecor: paintModernWallDecor,
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
  drama: MODERN_DRAMA,
  life: MODERN_LIFE,
  npcs: MODERN_NPCS,
  lighting: { dayTint: 0xffffff, nightTint: 0x0b1030, nightAlpha: 0.42, glowAtNight: false },
  floorLabel: (index, projectName) => `Floor ${index + 1} — ${projectName}`,
};

/** Idempotent (guarded by `textures.exists`); call once during scene `create()` before rendering. */
export { paintModernDecorTextures };
