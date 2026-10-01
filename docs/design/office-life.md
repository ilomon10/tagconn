# The office comes alive (M13 → v0.7.0)

Status: approved for implementation · Plan: `~/.claude-sessions/profiles/edgar/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md` section "M13"
Scope: 13.1 RPG name plates, 13.2 life director (meetings + idle life), 13.3 NPCs and encounters, 13.4 game-style
alerts, 13.5 WebAudio sound. Web only, plus settings in `packages/shared`. No server code changes.

Read first: `docs/design/game-office.md` (drama: the closest precedent, section 2 and the PM wiring in section 6),
`docs/design/guild-hall.md` (themes, procgen), `docs/design/back-wall.md` (appliances, overdraw).

---

## 0. Goals, non-goals, invariants

**Goals**
- The name tag moves above the head as a multi-line RPG plate (name / themed title / task on focus), drawn in a
  code-generated pixel font.
- Idle characters live: kickoff meetings when a session delegates, periodic stand-ups, and a weighted schedule of idle
  activities (coffee chat, arcade, ping-pong, nap, ...).
- NPCs: routine staff (janitor, courier, plant waterer) and random encounters (guest, police, CIA agent, sales dog,
  monster, office cat; themed per style) with optional brief cosmetic chaos (flee, gather, chase).
- JRPG-style, rate-limited alerts for "asks for you", "stumbled" (tool failure) and "quest complete".
- Code-synthesised sound effects and ambient beds, with a per-browser mute and volume.

**Non-goals (M13)**
- Battles, progression, encounter prompts: those are M14. M13 only leaves the hooks (section 3.5.6).
- Host-time sun cycle and lighting: M15. M13 reads the hour through `host.hour()` so M15 can swap the clock.
- New server endpoints or persisted state. NPCs on the Multiverse floor (off in M13, see 3.5.5).

**Invariants (every task must keep these)**
1. **Cosmetic only.** Life, NPC and reaction scripts never call `SeatAllocator.assign/release`; they read
   `seats.get(key)` only to walk a character home (`goHome`, same as `DramaDirector.goHome`). Real agent state
   always wins: a character that becomes `waiting`/`blocked`, gets a `currentTool` (real tool), starts leaving or is
   destroyed drops out of its script at once.
   One deliberate exception to "no real work": a kickoff meeting pulls active (working) subagents to the meeting room
   for the short kickoff, because the user asked that everyone invited goes to the meeting room. This is cosmetic
   only (it walks the character, nothing else), never takes a waiting/blocked character, and never goes through
   `SeatAllocator`; a character that turns waiting/blocked mid-kickoff leaves at once (break-off).
2. **Never cover a waiting bubble.** Waiting/blocked characters never take part in a script. Script spots and NPC
   targets keep `WAITING_CLEARANCE_TILES = 2` (Chebyshev) from every waiting character. All script lines go through
   `Character.sayDrama` (ranked last by `layoutLabels`, skipped while the character's own waiting bubble is up).
   Plates are label-layout obstacles (section 3.1.4), so a bubble is never placed under a plate.
3. **One script per character.** The shared `CosmeticClaims` registry (section 3.4) is the only way drama, life and
   reactions take a character. A character is in at most one script.
4. **ADR #22.** All art (glyphs, icons, props, creatures, costumes, furniture) and all audio are generated in code.
   No asset files.
5. **D2.** Geometry never depends on style. New furniture kinds, activity `requires`, NPC kinds and script targets
   are style-agnostic; only labels, lines, skins and art are per style.
6. **Gates.** `office.ambientEffects` off or `prefers-reduced-motion` stops walking scripts (table in 3.6);
   `shaders.quality` resolved `low` caps NPCs at 1 and disables chaos; the canvas renderer works with everything
   (no shaders are used; plates fall back to system text on canvas).
7. **Configurable.** Every user-facing threshold is a setting (section 1). Internal timeouts are named constants in
   the module's `types.ts`, as drama's `GATHER_TIMEOUT_MS` is.
8. **Hot files.** No task edits `OfficeScene.ts`, `OfficeView.tsx`, `OfficeGame.ts` or `MenuSheet.tsx`. Every feature
   ships a self-contained module with a narrow host interface; the PM wires them (section 4).

---

## 1. Shared contract (`packages/shared/src/settings.ts`, task W0a)

Follows the existing convention: leaf `.default()`, section objects `.prefault({})`. No `.default()` on an object
that is also used as an input type, no renames, `office.sound` stays the master switch (default `false`).

Contract check for failure alerts: `OfficeEvent` (`packages/shared/src/domain.ts:127`) already has `hookEvent:
string` and `toolName?: string`, and `events.service.ts:63-64` fills them from `hook_event_name` / `tool_name`.
**No `OfficeEvent` change is needed.** Failures are `hookEvent === 'PostToolUseFailure'`.

Add near the top of `settings.ts` (after `SCREEN_EFFECTS`):

```ts
/** M13: semantic NPC kinds. Style-agnostic; each style skins them (docs/design/office-life.md 3.5). */
export const NPC_KINDS = ['janitor', 'courier', 'plant-waterer', 'guest', 'police', 'cia-agent', 'sales-dog', 'monster', 'office-cat'] as const;
export type NpcKind = (typeof NPC_KINDS)[number];
/** M13: when the name plate shows its task line. `focus` = selected or hovered. */
export const LABEL_TASK_MODES = ['focus', 'always', 'never'] as const;
export type LabelTaskMode = (typeof LABEL_TASK_MODES)[number];
```

Append inside `office: z.object({...})`, after `multiverseMaxCharacters`:

```ts
      /** M13: RPG name plates above the head. */
      labels: z
        .object({
          /** Third plate line with the task: on hover/selection, always, or never. */
          showTask: z.enum(LABEL_TASK_MODES).default('focus'),
          /** Lines the task wraps to before it is cut with "…". */
          taskLines: z.number().int().min(1).max(4).default(2),
          /** Plate width in name characters; longer names are cut, the task wraps at this width. */
          maxWidthChars: z.number().int().min(8).max(60).default(24),
          /** Second line with the themed title. */
          showTitle: z.boolean().default(true),
          /** Code-drawn pixel font (WebGL only; canvas and missing glyphs fall back to system text). */
          pixelFont: z.boolean().default(true),
        })
        .prefault({}),
      /** M13: meetings and idle activities. Presentation only. */
      life: z
        .object({
          enabled: z.boolean().default(true),
          /** A kickoff starts when 2+ subagents of a delegating session spawn within this window. */
          kickoffWindowSec: z.number().min(5).max(300).default(30),
          /** How long everyone sits at the table. */
          meetingSec: z.number().min(5).max(600).default(20),
          /** Minimum seconds between stand-ups on a floor. */
          standupEverySec: z.number().min(60).max(86_400).default(1800),
          /** Idle characters on the floor needed for a stand-up. */
          standupMinCast: z.number().int().min(2).max(12).default(3),
          /** Average seconds between idle activities on a floor. */
          idleActivityEverySec: z.number().min(10).max(3600).default(60),
          /** Meetings plus activities running at once on a floor. */
          maxConcurrent: z.number().int().min(1).max(8).default(2),
          /** Host plus invitees in one meeting. */
          maxMeetingSize: z.number().int().min(2).max(12).default(6),
        })
        .prefault({}),
      /** M13: routine NPCs and random encounters. Presentation only. */
      npcs: z
        .object({
          enabled: z.boolean().default(true),
          /** Janitor mops in the evening and empties bins after bursts of activity. */
          janitor: z.boolean().default(true),
          /** Random visitors (guest, police, CIA agent, sales dog, monster, office cat). Courier/plant waterer stay. */
          encounters: z.boolean().default(true),
          /** Average seconds between NPC visits on a floor. */
          encounterEverySec: z.number().min(30).max(86_400).default(240),
          /** NPCs on a floor at once (1 on low graphics quality). */
          maxConcurrent: z.number().int().min(1).max(6).default(2),
          /** Idle characters may briefly flee, gather or chase. Never waiting ones. */
          allowChaos: z.boolean().default(true),
          /** Idle characters that react to one NPC. */
          maxReactors: z.number().int().min(1).max(8).default(4),
          /** NPC kinds that never appear. */
          disabledKinds: z.array(z.enum(NPC_KINDS)).max(NPC_KINDS.length).default([]),
        })
        .prefault({}),
      /** M13: JRPG-style alert boxes (the tab-hidden case stays with browser notifications). */
      alerts: z
        .object({
          enabled: z.boolean().default(true),
          onAsk: z.boolean().default(true),
          onDone: z.boolean().default(true),
          onFailure: z.boolean().default(true),
          /** Token-bucket refill rate. */
          perMinute: z.number().int().min(1).max(60).default(4),
          /** Token-bucket size (alerts that may show back to back). */
          burst: z.number().int().min(1).max(10).default(3),
          /** Seconds before the same character can raise another alert of the same or lower priority. */
          agentCooldownSec: z.number().min(0).max(3600).default(60),
          /** Seconds an alert stays; 0 = until dismissed. */
          autoDismissSec: z.number().min(0).max(120).default(8),
          /** Alert boxes on screen at once. */
          maxVisible: z.number().int().min(1).max(5).default(2),
        })
        .prefault({}),
      /** M13: sound mix. `office.sound` stays the master switch (each browser may override it from the menu). */
      audio: z
        .object({
          volume: z.number().min(0).max(1).default(0.6),
          sfx: z.boolean().default(true),
          ambient: z.boolean().default(true),
          alerts: z.boolean().default(true),
          footsteps: z.boolean().default(true),
        })
        .prefault({}),
```

- `RESTART_REQUIRED_SETTINGS`: unchanged (none of these need a restart).
- `GUI_IMMUTABLE_SETTINGS`, `WHOLESALE_REPLACE_SETTINGS`: unchanged (`disabledKinds` is an array, already replaced wholesale).
- `config/office.yaml`: add a commented example block for the five sections.

`apps/web/src/features/settings/meta.ts` (W0a):
- `ENUM_OPTIONS['office.labels.showTask'] = ['focus', 'always', 'never']`.
- `KEY_HINTS` for `office.sound` ("Master switch for sound, the default for every browser; each browser can mute or
  unmute from the menu.") and for every leaf of `office.labels.*`, `office.life.*`, `office.npcs.*`, `office.alerts.*`,
  `office.audio.*` (text = the schema comments above; `disabledKinds`: "One kind per line: janitor, courier,
  plant-waterer, guest, police, cia-agent, sales-dog, monster, office-cat.").
- `NUMBER_STEP['office.audio.volume'] = 0.05`.
- `meta.test.ts`: extend `nestedLeafPaths` with the five new sections; extend the numeric-bounds test to every
  numeric field of `office.life`, `office.npcs`, `office.alerts`, `office.audio`, `office.labels`.

---

## 2. Web contract files (task W0b; furniture kinds in W0c)

Written verbatim before Wave 1 so every task compiles against them. Stubs (marked STUB) export the final signatures
with trivial bodies; the named Wave-1 task owns the body afterwards (the M12 W2-0 precedent).

### 2.1 `game/themes/types.ts` additions

```ts
import type { NpcKind } from '@tagconn/shared';
import type { SfxId } from '../sfxBus';

/** M12 G1 icon shown over a character during an idle antic. M13 adds life/NPC emotes. */
export type DramaEmote =
  | 'mug' | 'note' | 'dice' | 'ball' | 'phone' | 'laugh' | 'spark' | 'zz'
  | 'megaphone' | 'alarm' | 'heart' | 'gamepad' | 'paddle' | 'chess' | 'can' | 'pencil' | 'broom' | 'parcel';

// Costume: extend the unions (HAT_BITMAPS/STAFF_BITMAPS are Partial, so nothing else breaks).
//   hat?:   ... | 'cap' | 'police-cap' | 'fedora' | 'hardhat'
//   staff?: ... | 'mop' | 'parcel' | 'watering-can' | 'clipboard'
//   shades?: boolean   // dark glasses (CIA agent, inquisitor); drawn by Character from SHADES_TEXTURE

/** M13: a cosmetic body pose (Character.setPose). Overrides the activity animation while standing still. */
export type LifePose = 'chat' | 'sip' | 'play' | 'cheer' | 'stretch' | 'phone' | 'water' | 'nap' | 'doodle' | 'sweep' | 'carry' | 'sit';

export interface LifeActivity {
  /** kebab-case, unique within one theme's list. */
  id: string;
  /** Any-of furniture kinds to gather at (nearest item on the floor/realm). `[]` = in place (allowed under reduced motion). */
  requires: readonly FurnitureKind[];
  /** [min, max] cast size. */
  cast: readonly [1 | 2 | 3 | 4, 1 | 2 | 3 | 4];
  /** Relative pick weight (> 0). */
  weight: number;
  /** Seeded within [min, max] seconds. */
  durationSec: readonly [number, number];
  pose: LifePose;
  emote?: DramaEmote;
  /** Said by seeded cast members, one every LIFE_TIMING.lineEvery. Each line <= 48 chars. */
  lines: readonly string[];
}

/** Line pools for one meeting type. Each line <= 48 chars. */
export interface MeetingLines {
  invite: readonly string[]; // host, at the start ("Kickoff in the war room!")
  fetch: readonly string[]; // host, to the straggler
  dawdle: readonly string[]; // straggler's reply
  talk: readonly string[]; // during the meeting, any participant
  close: readonly string[]; // host, at the end
}

export interface LifeContent {
  activities: readonly LifeActivity[];
  kickoff: MeetingLines;
  standup: MeetingLines;
}

/** Non-human NPC bodies (Character.setCreature). Texture keys: `creature-<id>-0|1` (npc/types.ts). */
export type CreatureId = 'dog' | 'cat' | 'monster' | 'wolf' | 'familiar' | 'slime' | 'hover-hound' | 'astro-cat' | 'void-blob';

export interface NpcSkin {
  /** Plate line 1, e.g. "Sales Dog" / "Town Guard". */
  name: string;
  /** Plate line 2, e.g. "Visitor". */
  title?: string;
  /** Plate name colour and body tint. */
  color: number;
  /** Human NPCs: costume overlays (hat, staff prop, shades, robe tint). */
  costume?: Costume;
  /** Non-human NPCs: replaces the whole body. */
  creature?: CreatureId;
  /** Said during the NPC's bit. Each line <= 48 chars. */
  lines: readonly string[];
  /** Bit sound (bark, meow, whistle...). */
  sound?: SfxId;
  /** Which `npc-jingle-N` plays on entry. */
  jingle: 0 | 1 | 2 | 3;
}

export interface NpcContent {
  skins: Record<NpcKind, NpcSkin>;
}

// ThemeDefinition gains (both optional; a theme without them has no life/NPCs):
//   /** M13: idle activities + meeting lines. */
//   life?: LifeContent;
//   /** M13: NPC skins per semantic kind. */
//   npcs?: NpcContent;
```

`game/drama.ts` (W0b): add the 10 new `EMOTE_ICON` entries pointing at EXISTING icons as placeholders so
`textures.test.ts` stays green: megaphone→`icon-arrow`, alarm→`icon-bang`, heart→`icon-sparkle`,
gamepad→`icon-dice`, paddle→`icon-ball`, chess→`icon-dice`, can→`icon-mug`, pencil→`icon-note`,
broom→`icon-sparkle`, parcel→`icon-check`. W1-12 switches them to `icon-<emote>`.

### 2.2 `game/sfxBus.ts` (full, tiny, with `sfxBus.test.ts`)

```ts
import type { Point } from './procgen/types';

export const SFX_IDS = [
  'alert-ask', 'alert-done', 'alert-fail',
  'footstep', 'typing',
  'door-bell', 'meeting-gong', 'npc-jingle-0', 'npc-jingle-1', 'npc-jingle-2', 'npc-jingle-3',
  'bark', 'meow', 'slime', 'whistle', 'roar', 'mop',
  'ui-click', 'ui-open', 'ui-close',
] as const;
export type SfxId = (typeof SFX_IDS)[number];
/** Which `office.audio` toggle gates an id (`ui` follows `sfx`). */
export type SfxCategory = 'alerts' | 'sfx' | 'footsteps' | 'ui';
export const SFX_CATEGORY: Record<SfxId, SfxCategory> = { /* alert-* -> alerts; footstep, typing -> footsteps; ui-* -> ui; rest -> sfx */ };

export interface SfxEvent {
  id: SfxId;
  /** World px; omitted = non-spatial (UI, alerts). */
  at?: Point;
  /** 0..1 extra gain. */
  gain?: number;
}
/** World-space camera centre and half view size (OfficeScene sets it every proximity tick). */
export interface SfxListenerPose { x: number; y: number; halfW: number; halfH: number }
export interface AmbientContext { style: 'modern' | 'guild' | 'rift'; night: boolean }

export interface SfxBus {
  emit(e: SfxEvent): void;
  on(cb: (e: SfxEvent) => void): () => void;
  setListener(p: SfxListenerPose | null): void;
  listener(): SfxListenerPose | null;
  /** Replays the last context to late subscribers. */
  setAmbient(a: AmbientContext): void;
  ambient(): AmbientContext | null;
  onAmbient(cb: (a: AmbientContext) => void): () => void;
  /** Tests. */
  clear(): void;
}
/** Module singleton, the same pattern as `officeNavBus`. A throwing listener never breaks the emitter. */
export const sfxBus: SfxBus;
```

### 2.3 `game/cosmetic/types.ts`

```ts
import type { ActorKey } from '../cast';
import type { Point } from '../procgen/types';

/** Higher preempts lower; equal never preempts. */
export const CLAIM_PRIORITY = { drama: 1, activity: 1, reaction: 2, meeting: 3 } as const;
export type ClaimKind = keyof typeof CLAIM_PRIORITY;
/** Script spots and NPC targets keep this Chebyshev distance from waiting/blocked characters. */
export const WAITING_CLEARANCE_TILES = 2;

export interface CosmeticClaimsApi {
  /** Free: claims. Held by a lower priority: calls that holder's onRevoke(key) synchronously, then claims.
   *  Held by the same or a higher priority: false. */
  tryClaim(key: ActorKey, kind: ClaimKind, onRevoke: (key: ActorKey) => void): boolean;
  /** No-op unless `kind` holds `key`. */
  release(key: ActorKey, kind: ClaimKind): void;
  holder(key: ActorKey): ClaimKind | undefined;
  isFree(key: ActorKey): boolean;
  /** False when any kind already reserved the tile. */
  reserveTile(p: Point, kind: ClaimKind): boolean;
  releaseTile(p: Point, kind: ClaimKind): void;
  isTileReserved(p: Point): boolean;
  /** Claimed characters (of one kind, or all). */
  count(kind?: ClaimKind): number;
  /** buildWorld / floor change: drop everything, no callbacks. */
  clear(): void;
}
```

### 2.4 `game/actors/poses.ts` (contract data; W1-2 adds the animation table to the same file)

```ts
import type { LifePose } from '../themes/types';
/** Hand prop per pose (texture keys; the new ones are painted by W1-12 in textures.ts). */
export const POSE_PROP: Record<LifePose, string | null> = {
  chat: null, sip: 'prop-cup', play: 'prop-controller', cheer: null, stretch: null, phone: 'prop-phone',
  water: 'prop-can', nap: null, doodle: 'prop-marker', sweep: 'prop-mop', carry: 'prop-parcel', sit: null,
};
```

### 2.5 `game/life/types.ts`

```ts
import type { Agent, Settings } from '@tagconn/shared';
import type { ActorKey } from '../cast';
import type { Character } from '../actors/Character';
import type { CosmeticClaimsApi } from '../cosmetic/types';
import type { PathFinder } from '../pathfinding';
import type { GeneratedMap, PlacedFurniture, Point } from '../procgen/types';
import type { SeatAllocator } from '../seats';
import type { SfxEvent } from '../sfxBus';
import type { LifeActivity, MeetingLines, ThemeDefinition } from '../themes/types';

export type LifeSettings = Settings['office']['life'];

export interface LifeHost {
  map(): GeneratedMap;
  finder(): PathFinder;
  seats(): SeatAllocator;
  /** Cast characters only (never the Receptionist or NPCs). */
  actors(): ReadonlyMap<ActorKey, Character>;
  agents(): readonly Agent[];
  themeFor(c: Character): ThemeDefinition;
  office(): Settings['office'] | undefined;
  floorKey(): string;
  reducedMotion(): boolean;
  lowQuality(): boolean;
  claims(): CosmeticClaimsApi;
  keyForAgent(agentId: string): ActorKey | undefined;
  /** Multiverse: the room ids of `c`'s realm; null on a normal floor. */
  realmRooms(c: Character): ReadonlySet<string> | null;
}

export type LifeScriptKind = 'kickoff' | 'standup' | 'activity';
/** host = meeting host (may be `delegating`); invitee = kickoff subagent (active, any activity); idle = everyone else. */
export type LifeRole = 'host' | 'invitee' | 'idle';

export interface LifeScript {
  readonly id: string;
  readonly kind: LifeScriptKind;
  /** Current participants (shrinks on revoke/break-off). */
  readonly keys: readonly ActorKey[];
  /** Advance on the director's 500 ms tick; 'done' once every claim is released. */
  step(now: number): 'running' | 'done';
  /** `key`'s claim was taken by a higher priority: forget it without moving it (clear emote/pose/bubble only). */
  revoke(key: ActorKey, now: number): void;
  /** Flags turned off: everyone not walking elsewhere goes home; claims are released by the following steps. */
  cancel(now: number): void;
  /** reset(): drop at once, no walking (the scene is about to teleport/destroy); releases every claim. */
  abort(): void;
}

export interface LifeCtx {
  host: LifeHost;
  /** Live, not gone. */
  char(key: ActorKey): Character | undefined;
  /** Live eligibility for a role (section 3.2.2). */
  eligible(key: ActorKey, role: LifeRole): boolean;
  goHome(c: Character): void;
  /** `sayDrama` when `office.showBubbles`. */
  say(c: Character, line: string, sec: number): void;
  sfx(e: SfxEvent): void;
  rng(seed: string): () => number;
  /** Free for a spot: walkable, no seat occupant, not reserved, nobody standing, clear of waiting characters. */
  isFree(p: Point): boolean;
  /** Tiles that are `sit` seats (sit pose on arrival). */
  isSitTile(p: Point): boolean;
}

export interface Venue {
  roomId: string;
  /** null = lounge fallback with no table (gather around the room centre). */
  table: PlacedFurniture | null;
  /** Ring spots; [0] is the host's. Reserved by the meeting. */
  spots: Point[];
}
export interface MeetingPlan {
  id: string;
  kind: 'kickoff' | 'standup';
  hostKey: ActorKey;
  inviteeKeys: ActorKey[];
  /** One seeded invitee who dawdles (null with < 2 invitees). */
  stragglerKey: ActorKey | null;
  venue: Venue;
  lines: MeetingLines;
  meetingMs: number;
  seed: string;
}
export interface ActivityPlan {
  id: string;
  activity: LifeActivity;
  keys: ActorKey[];
  prop: PlacedFurniture | null;
  spots: Point[];
  durationMs: number;
  seed: string;
}
export type StartMeeting = (ctx: LifeCtx, plan: MeetingPlan, now: number) => LifeScript | null;
export type StartActivity = (ctx: LifeCtx, plan: ActivityPlan, now: number) => LifeScript | null;

/** Internal timeouts (ms), not user thresholds. */
export const LIFE_TIMING = {
  step: 500, inviteEmote: 2000, convene: 12_000, fetch: 10_000, lineEvery: 3500, lineSec: 3, replyDelay: 1800, return: 20_000,
} as const;
```

### 2.6 `game/npc/types.ts`

```ts
import type { Agent, NpcKind, RoomType, Settings } from '@tagconn/shared';
import type { ActorKey } from '../cast';
import type { Character } from '../actors/Character';
import type { CosmeticClaimsApi } from '../cosmetic/types';
import type { PathFinder } from '../pathfinding';
import type { FurnitureKind, GeneratedMap, Point } from '../procgen/types';
import type { SeatAllocator } from '../seats';
import type { SfxEvent, SfxId } from '../sfxBus';
import type { CreatureId, LifePose, ThemeDefinition } from '../themes/types';

export type { NpcKind };
export type NpcSettings = Settings['office']['npcs'];
export const creatureTextureKey = (id: CreatureId, frame: 0 | 1): string => `creature-${id}-${frame}`;
export const SHADES_TEXTURE = 'npc-shades';

/** 24 weights, index = host hour 0..23. */
export type HourCurve = readonly number[];
export type ReactionKind = 'flee' | 'gather' | 'chase';
export type NpcTarget =
  | { furniture: readonly FurnitureKind[] }
  | { rooms: readonly RoomType[] }
  | 'corridor' | 'entrance' | 'crowd';
export type NpcStep =
  | { do: 'enter' }
  | { do: 'goto'; target: NpcTarget }
  | { do: 'wander'; rooms: number }
  | { do: 'sweep'; tiles: number }
  | { do: 'bit'; pose: LifePose; sec: readonly [number, number]; line?: boolean; react?: ReactionKind; sfx?: SfxId }
  | { do: 'exit' };
export interface EncounterDef {
  kind: NpcKind;
  /** Routine kinds still come with `npcs.encounters` off. The janitor is scheduled by `janitorDue`, not by weight. */
  routine: boolean;
  weight: number;
  hours: HourCurve;
  steps: readonly NpcStep[];
}

/** M14 hook: OfficeGame forwards these as the 'encounter' event. */
export interface EncounterEvent {
  id: string;
  kind: NpcKind;
  style: ThemeDefinition['id'];
  name: string;
  phase: 'appeared' | 'bit' | 'left';
  at: number;
}

export interface NpcHost {
  map(): GeneratedMap;
  finder(): PathFinder;
  seats(): SeatAllocator;
  /** Cast characters (reactors), never NPCs or the Receptionist. */
  actors(): ReadonlyMap<ActorKey, Character>;
  agents(): readonly Agent[];
  theme(): ThemeDefinition;
  office(): Settings['office'] | undefined;
  floorKey(): string;
  reducedMotion(): boolean;
  lowQuality(): boolean;
  isMultiverse(): boolean;
  /** Host clock hour 0..23 (M15 replaces the source). */
  hour(): number;
  claims(): CosmeticClaimsApi;
  /** Creates a Character at `at` (tile) with hover handlers and the current hit scale. */
  spawnNpc(key: ActorKey, at: Point): Character;
  emit(e: EncounterEvent): void;
}

export interface NpcActor {
  id: string;
  key: ActorKey; // `npc:<kind>:<seq>`
  kind: NpcKind;
  def: EncounterDef;
  char: Character;
  stepIndex: number;
  stepAt: number;
  /** M14: paused by hold(); the runner idles without advancing. */
  held: boolean;
  /** Runner scratch state for the current step. */
  scratch: Record<string, unknown>;
}

export interface NpcScriptCtx {
  host: NpcHost;
  rng(seed: string): () => number;
  say(c: Character, line: string, sec: number): void;
  sfx(e: SfxEvent): void;
  /** Tiles of waiting/blocked cast characters this tick. */
  waitingTiles(): readonly Point[];
  /** Starts a reaction when chaos is allowed (no-op otherwise). */
  react(npc: NpcActor, kind: ReactionKind, now: number): void;
  emit(npc: NpcActor, phase: EncounterEvent['phase'], now: number): void;
}
export interface NpcScriptRunner {
  /** 'done' once the NPC is gone (faded out after exit). */
  step(npc: NpcActor, now: number): 'running' | 'done';
}
export type CreateScriptRunner = (ctx: NpcScriptCtx) => NpcScriptRunner;

export interface ReactionController {
  /** Returns how many characters react. */
  start(npc: NpcActor, kind: ReactionKind, now: number): number;
  step(now: number): void;
  /** Everyone goes home (sendHome) or is dropped in place; claims released. */
  cancelAll(sendHome: boolean): void;
  activeKeys(): ReadonlySet<ActorKey>;
}
export type CreateReactions = (host: NpcHost, rng: (seed: string) => () => number) => ReactionController;

export const NPC_TIMING = {
  step: 500, stepTimeout: 25_000, scriptMax: 120_000, reactMin: 3000, reactSpan: 5000, chaseRepath: 1000,
  janitorCooldown: 600_000, sweepPause: 600,
} as const;
```

### 2.7 `lib/audio/types.ts`

```ts
import type { SfxId } from '../../game/sfxBus';
export type AmbientKind = 'office-day' | 'office-night' | 'tavern-day' | 'tavern-night' | 'rift';
export type Wave = 'square' | 'saw' | 'triangle' | 'sine' | 'noise';
/** sfxr-style parameters; times in seconds, frequencies in Hz. */
export interface SfxParams {
  wave: Wave;
  attack: number; sustain: number; decay: number; punch?: number; // punch 0..1 sustain boost
  freq: number; slide?: number; // Hz per second
  vibratoHz?: number; vibratoDepth?: number; // depth 0..1 of freq
  duty?: number; // square 0..1
  lowpass?: number; highpass?: number; // one-pole cutoffs
  gain: number; // 0..1
  seed?: number; // noise determinism
  /** Melodic sequence (fanfare, gong, jingles): each note re-uses the envelope. */
  notes?: readonly { freq: number; at: number; len: number }[];
}
export interface AudioMix { master: number; sfx: boolean; ambient: boolean; alerts: boolean; footsteps: boolean }
export interface AudioPrefs { muted: boolean | null; volume: number | null }
export interface AudioEngine {
  readonly unlocked: boolean;
  setMix(m: AudioMix): void;
  play(id: SfxId, opts?: { gain?: number; pan?: number }): void;
  setAmbient(kind: AmbientKind | null): void;
  destroy(): void;
}
```

STUB files (W0b; bodies by the named W1 task). Stub bodies must keep the app working while the real body is missing:
- `lib/audio/sfxr.ts` (W1-5): `export function renderSfx(p: SfxParams, sampleRate: number): Float32Array` → `new Float32Array(0)`.
- `lib/audio/presets.ts` (W1-5): `export const SFX_PRESETS: Record<SfxId, SfxParams>` → every id mapped to one blank preset.
- `lib/audio/ambient.ts` (W1-5): `export function ambientFor(style: AmbientContext['style'], night: boolean): AmbientKind` → `'office-day'`;
  `export function createAmbient(ctx: BaseAudioContext, kind: AmbientKind, out: AudioNode): { stop(): void }` → no-op.
- `lib/audio/mix.ts` (W1-6): `export function resolveMix(office: Pick<Settings['office'], 'sound' | 'audio'>, prefs: AudioPrefs, hidden: boolean): AudioMix` → master 0.
- `lib/audio/engine.ts` (W1-6): `export function getAudioEngine(): AudioEngine` → inert object;
  `export function createAudioEngine(deps: { createContext: () => AudioContext | null; target: EventTarget }): AudioEngine` → inert object.
- `actors/namePlate.ts` (W1-1): signatures in 3.1.3; `layoutPlate` stub returns one `name` line measured with
  `pixelMeasure` (no title/task), `plateGlyphScale` → `1`, `taskVisible` → `false`, `plateOptions` maps the settings.
- `text/pixelFont.ts` (W1-1): signatures in 3.1.2; `ensurePixelFonts` and `hasGlyphs` → `false` (Character uses the
  `Text` fallback until W1-1 lands).
- `features/office/alerts/alertQueue.ts`, `typewriter.ts` (W1-3): signatures in 3.3.2; the queue stub never shows
  anything (`tickAlerts` returns `shown: []`), `typewriterText` returns the full text.

### 2.8 `features/office/alerts/types.ts`

```ts
import type { Settings } from '@tagconn/shared';
export type AlertKind = 'ask' | 'failure' | 'done';
export const ALERT_PRIORITY: Record<AlertKind, number> = { ask: 3, failure: 2, done: 1 };
export type AlertSettings = Settings['office']['alerts'];
export interface AlertInput {
  kind: AlertKind;
  agentId: string;
  at: number;
  /** Dedupe discriminator: the status for ask/done, the tool name for failure. */
  key: string;
  toolName?: string;
}
export interface AlertItem {
  id: string;
  kind: AlertKind;
  /** > 1 = coalesced ("3 heroes need you"). */
  agentIds: readonly string[];
  toolName?: string;
  createdAt: number;
  shownAt: number | null;
}
export interface AlertQueueState {
  tokens: number;
  refilledAt: number;
  /** agentId -> { at, priority } of the last alert shown for it. */
  lastShown: Readonly<Record<string, { at: number; priority: number }>>;
  /** agentId -> last key offered (drops exact repeats, e.g. a re-sent waiting status). */
  lastKey: Readonly<Record<string, string>>;
  pending: readonly AlertItem[];
  visible: readonly AlertItem[];
  seq: number;
}
/** Internal windows (ms). */
export const ALERT_LIMITS = { coalesceMs: 1500, pendingMax: 12, pendingTtlMs: 30_000, replayGraceMs: 15_000 } as const;
```

### 2.9 Furniture kinds (task W0c)

`procgen/types.ts` `FurnitureKind` gains `'arcade' | 'ping-pong' | 'foosball' | 'board-game-table'`.
`water-cooler` and `sofa` already exist (no change).

| kind | footprint (w x h) | blocking (`KIND_BLOCKING`) | play spots | modern | guild | rift |
|---|---|---|---|---|---|---|
| `arcade` | 1x1 | true | 1 south, 1 beside | arcade cabinet | dartboard on a post | holo-arcade pillar |
| `ping-pong` | 2x1 | true | west + east ends | ping-pong table + net | arm-wrestling trestle | zero-g paddle field |
| `foosball` | 2x1 | true | north + south sides | foosball table | dice table with cups | hover-puck table |
| `board-game-table` | 2x1 | true | ring (up to 4) | board game (checkers) | cards and dice table | holo-chess table |
| `water-cooler` (exists) | 1x1 | true | 2 in front | | | |
| `sofa` (exists) | 1..4 x 1 | false | its own free tiles (nap) | | | |

W0c also: `KIND_BLOCKING` entries in `procgen/pins.ts` (so the new kinds are pinnable); placeholder painters
(aliases of an existing painter of the same map, e.g. `MODERN.equipment` / `GUILD.table`) in the exhaustive `MODERN`
and `GUILD` maps (`themes/paint/furniture.ts`) and `RIFT` (`themes/paint/riftFurniture.ts`, alias
`paintCrystalAppliance`); the four kinds added to the `FURNITURE_KIND_SET` records of `painters.test.ts` and
`riftPainters.test.ts`. W1-8/W1-9 replace the aliases.

---

## 3. Module designs

### 3.1 Name plates (13.1)

#### 3.1.1 Units and font
- Plate layout works in **plate pixels (pp)**: one pixel of the pixel font. Big glyphs (name) are 5x7 with advance 6;
  small glyphs (title, task) are 3x5 uppercase with advance 4 (lowercase is drawn uppercase). Line heights 8 / 6 / 6,
  padding 2, line gap 1.
- `maxW = office.labels.maxWidthChars * 6` pp (default 144 pp = 24 name chars, 36 small chars).
- World scale per pp is `plateGlyphScale(zoom)`: `max(1, round(zoom * 0.5)) / zoom`. Each font pixel is therefore an
  integer number (>= 1) of screen pixels at every zoom: crisp, and never smaller than readable. This replaces
  `counterScale` for the plate (the bubble keeps `setLabelScale`).

#### 3.1.2 `game/text/glyphs.ts` + `game/text/pixelFont.ts` (W1-1)

```ts
// glyphs.ts (pure data)
export const BIG_CHARS: string;   // ' '..'~' plus '·' and '…', the RetroFont char order
export const SMALL_CHARS: string; // ' '..'_' (uppercase set) plus '·' and '…'
export const GLYPHS_5X7: Readonly<Record<string, readonly string[]>>; // 7 rows of 5 ('#' = ink)
export const GLYPHS_3X5: Readonly<Record<string, readonly string[]>>; // 5 rows of 3
// pixelFont.ts (Phaser)
export const PIXEL_FONT_KEYS = { big: 'px-font-5x7', small: 'px-font-3x5' } as const;
/** Paints both atlases (white ink, 1 px cell gap) with Graphics.generateTexture, like textures.ts, and registers
 *  them with Phaser.GameObjects.RetroFont.Parse. Idempotent. False when the cache already failed. */
export function ensurePixelFonts(scene: Phaser.Scene): boolean;
/** Every char of `text` (after uppercasing for `small`) has a glyph. */
export function hasGlyphs(text: string, size: 'big' | 'small'): boolean;
```

#### 3.1.3 `game/actors/namePlate.ts` (pure, W1-1)

```ts
export type PlateStyle = 'name' | 'title' | 'task';
export interface PlateMetrics { advance: Record<PlateStyle, number>; lineH: Record<PlateStyle, number>; pad: number; gap: number }
export const PIXEL_METRICS: PlateMetrics; // advance {name 6, title 4, task 4}, lineH {8, 6, 6}, pad 2, gap 1
export type MeasureFn = (text: string, style: PlateStyle) => number;
export interface PlateLine { text: string; style: PlateStyle; w: number }
export interface PlateLayout { lines: PlateLine[]; w: number; h: number } // w/h include padding, in pp
/** Line 1 name (ellipsized to maxW), line 2 title (optional, ellipsized), then the task word-wrapped to
 *  `maxLines` lines (last one ellipsized; one over-long word is hard-cut). Empty title/task or maxLines 0 = omitted. */
export function layoutPlate(name: string, title: string | undefined, task: string | undefined, maxW: number, maxLines: number, measure?: MeasureFn, metrics?: PlateMetrics): PlateLayout;
export function wrapWords(text: string, maxW: number, maxLines: number, measure: (t: string) => number): string[];
export function ellipsize(text: string, maxW: number, measure: (t: string) => number): string;
export function pixelMeasure(metrics?: PlateMetrics): MeasureFn;
export function plateGlyphScale(zoom: number): number;
export interface PlateOptions { showTask: LabelTaskMode; taskLines: number; maxWidthChars: number; showTitle: boolean; pixelFont: boolean }
export function plateOptions(labels: Settings['office']['labels']): PlateOptions;
/** showTask 'always' | ('focus' and (selected or hovered)). */
export function taskVisible(mode: LabelTaskMode, selected: boolean, hovered: boolean): boolean;
```

#### 3.1.4 Character changes (W1-2)
- `CharacterLook` gains `name?: string`. With a name: line 1 = name, line 2 = `title`. Without: line 1 = `title`
  (anonymous agent, Receptionist), no line 2. `description` is the task line.
- New methods: `setPlateOptions(o: PlateOptions)` (idempotent, re-layouts on change), `setPlateZoom(zoom: number)`
  (applies `plateGlyphScale`). Re-layout happens only on look/options/selection/hover change, never per frame.
- The plate is an overlay container at a fixed local y: plate bottom at `PLATE_BOTTOM_Y = -30` (above the status/emote
  icon slot at -19..-26, so the plate never bounces when an icon blinks). Backing: rounded rect `#15121e` alpha 0.8.
  Name in `lighten(roleColor, 0.55)`, title `#b8b0c8`, task `#e8e2f0` at 0.9 alpha. Resting/focus alpha as today.
- Rendering: one `BitmapText` per line when `pixelFont && renderer === WEBGL && ensurePixelFonts && hasGlyphs(line)`;
  else one `Text` per line (`resolution: 4`, sizes 5px / 4px) measured through a `Text`-backed `MeasureFn`. The tint of
  `BitmapText` is WebGL-only, hence the canvas fallback.
- `tagRect` returns the plate's world rect (scaled), `labelAnchor` returns `{ x, y: y + PLATE_BOTTOM_Y - plate.h * scale }`
  while the plate is shown (else today's head anchor), and the bubble's base Y in `animate()` uses the same point, so
  `layoutLabels` places the bubble above the plate. The scene keeps pushing every plate into `obstacles`.
- The beacon chevron tip moves above the plate (and above an overlapping bubble, as today). The GM chip sits at the
  right end of the name line. `tagText` stays `"Name · Title"` (edge arrow, announcements).
- The task line shows per `taskVisible(showTask, selected, hovered)`.
- Cosmetic hooks for Wave 2 (also W1-2):

```ts
/** Overrides the activity animation while standing still and not waiting/blocked; null restores. Prop from POSE_PROP. */
setPose(pose: LifePose | null): void;
/** Non-human body: hides legs/upper/cloak/hat/props, shows `creature-<id>-<0|1>` (frame 1 alternates while walking). */
setCreature(id: CreatureId | null): void;
/** Face toward a world x while standing (null = default); survives animate()'s scaleX reset. */
face(worldX: number | null): void;
get currentActivity(): Activity;
get currentStatus(): AgentStatus;
```
  `setCostume` additionally shows `SHADES_TEXTURE` when `costume.shades`. `poses.ts` gains
  `POSE_ANIM: Record<LifePose, { handL: [number, number]; handR: [number, number]; bob: number; sway?: number; lie?: boolean }>`
  (pure, tested); `nap` lies the upper body sideways (rotation 90 deg), `sit` uses the sitting legs.

### 3.2 Life director (13.2)

#### 3.2.1 Files
- `game/life/rules.ts`, `game/life/spots.ts` (pure, W1-14)
- `game/life/meeting.ts` → `export const startMeeting: StartMeeting` (W2-1)
- `game/life/activity.ts` → `export const startActivity: StartActivity` (W2-2)
- `game/life/lifeDirector.ts` (W2-3): `new LifeDirector(host: LifeHost, f: { startMeeting: StartMeeting; startActivity: StartActivity })`
  with `reset(): void`, `afterCast(nowMs: number): void`, `update(time: number, delta: number): void`, `destroy(): void`,
  `scripts(): readonly LifeScript[]` (tests/debug). Factories are injected so the director never imports the scripts
  (file-disjoint in Wave 2, and tests use fakes).

#### 3.2.2 Eligibility (`ctx.eligible`, director)
Common: character live, not `leaving`/`gone`, claim free or held by this script, no `walking` when a script picks it.
- `idle`: lifecycle `resting`, or `quest` with agent `status === 'active' && activity === 'idle'` (drama's `stillOk`).
- `invitee` (kickoff only): `quest`, `status === 'active'` (any activity or tool: freshly spawned subagents are already mid-tool).
- `host`: `quest`, `status === 'active'`, `activity in {idle, thinking, delegating}` (the delegating PM hosts).
- Never: `status in {waiting, blocked}`, `done` agents still on quest, NPCs, the Receptionist.
- Multiverse: all participants share `realmIndex`; venues/props are taken from `host.realmRooms(hostChar)`.

#### 3.2.3 Pure rules (`rules.ts`, `spots.ts`)

```ts
export interface Kickoff { sessionId: string; hostAgentId: string; inviteeAgentIds: string[]; at: number }
export class KickoffTracker {
  /** A main agent turning `delegating` opens a window [at - 2 s, at + windowSec]; subagents of that session whose
   *  startedAt falls inside are counted; at >= 2 the kickoff is returned ONCE and the window closes. Windows expire. */
  observe(agents: readonly Agent[], nowMs: number, windowSec: number): Kickoff[];
  clear(): void;
}
export function standupDue(lastAtMs: number, nowMs: number, everySec: number, idleCount: number, minCast: number): boolean;
/** meeting-room with the largest table → largest table/reading-table/board-game-table anywhere → lounge (table or null).
 *  `allowed` limits rooms (Multiverse realm). Ties by distance to `near`, then room id. */
export function pickVenue(map: Pick<GeneratedMap, 'rooms' | 'furniture'>, allowed: ReadonlySet<string> | null, near: Point): { roomId: string; table: PlacedFurniture | null } | null;
export function pickStraggler(inviteeKeys: readonly string[], seed: string): string | null; // null when < 2
/** Weighted seeded pick among activities whose requires is [] or intersects `available`, with cast[0] <= freeCast. */
export function pickActivity(list: readonly LifeActivity[], available: ReadonlySet<FurnitureKind>, freeCast: number, seed: string): LifeActivity | null;
/** Nearest item (Manhattan from `from` to the footprint centre) of `kinds` in `allowed` rooms, skipping `taken` ("x,y"). */
export function pickProp(furniture: readonly PlacedFurniture[], kinds: readonly FurnitureKind[], from: Point, allowed: ReadonlySet<string> | null, taken: ReadonlySet<string>): PlacedFurniture | null;
export function nextLifeDelayMs(floorKey: string, bucket: number, everySec: number): number; // everySec*1000*(0.5..1.5)
export const EMPTY_LIFE: LifeContent;
export function lifeFor(theme: Pick<ThemeDefinition, 'life'>): LifeContent;
// spots.ts
/** Up to `count` free tiles 4-adjacent to the footprint in the same room, ordered around it clockwise from the
 *  north-west corner; deterministic. */
export function ringSpots(map: Pick<GeneratedMap, 'walkable' | 'roomAt'>, prop: Pick<PlacedFurniture, 'x' | 'y' | 'w' | 'h' | 'roomId'>, count: number, isFree: (p: Point) => boolean): Point[];
/** Blocking prop → ringSpots; non-blocking (sofa, rug) → its own free footprint tiles first, then the ring. */
export function propSpots(map: Pick<GeneratedMap, 'walkable' | 'roomAt'>, prop: PlacedFurniture, count: number, isFree: (p: Point) => boolean): Point[];
/** A free tile within `radius` (Manhattan) of `from` in the same room (straggler dawdle). */
export function nearbySpot(map: Pick<GeneratedMap, 'walkable' | 'roomAt'>, from: Point, radius: number, rand: () => number, isFree: (p: Point) => boolean): Point | null;
export function sitTiles(map: Pick<GeneratedMap, 'rooms'>): ReadonlySet<string>;
export function nearWaiting(p: Point, waiting: readonly Point[], r?: number): boolean; // default WAITING_CLEARANCE_TILES
```
Seeding reuses `dramaRng`/`dramaHash` from `game/drama.ts`.

#### 3.2.4 Director loop (W2-3)
- `afterCast(now)`: index agents; `kickoffs = tracker.observe(agents, now, life.kickoffWindowSec)`; for each kickoff
  map ids with `host.keyForAgent`, keep eligible host + `invitee` keys, cap to `maxMeetingSize - 1` invitees; with
  >= 2 invitees, capacity left and a venue, build a `MeetingPlan` (claims `meeting`, preempting drama/activities/
  reactions). Then `checkScripts`.
- `update` (500 ms throttle): step scripts (drop `done`); then schedule:
  - **Stand-up**: when no meeting runs on the floor (per realm on the Multiverse) and `standupDue(lastStandupAt, now,
    standupEverySec, idleCount, standupMinCast)` (`lastStandupAt` starts at reset time, so no stand-up fires on load).
    Host = the GM actor (`gm:` key) when idle-eligible, else the smallest key; invitees = the other idle-eligible
    characters, nearest first, up to `maxMeetingSize - 1`.
  - **Activity**: every `nextLifeDelayMs(floorKey, bucket, idleActivityEverySec)`; candidate = a seeded idle-eligible,
    unclaimed, non-walking character; partners = nearest eligible in the same room up to `cast[1]`;
    `pickActivity` over the kinds present in the allowed rooms; `pickProp`; `propSpots`; claims `activity`.
  - Capacity: `scripts.length < (lowQuality ? 1 : life.maxConcurrent)`; at most one meeting per floor/realm.
- `reset()`: `abort()` every script, clear the tracker, `lastStandupAt = now`. `destroy()` = reset + drop indexes.
- Flags off mid-script → `cancel(now)`.

#### 3.2.5 Meeting script (W2-1)
1. **invite**: each participant `setDramaEmote('megaphone')` for `LIFE_TIMING.inviteEmote`; host says `lines.invite`;
   `sfx({ id: 'meeting-gong', at: venue centre })`.
2. **convene**: host walks to `spots[0]`, non-stragglers to their spots (`walk(path, isSitTile(spot))`), the straggler
   walks to `nearbySpot(...)` and idles (`setPose('phone')`).
3. **fetch** (when all non-stragglers arrived or `convene` timed out, and a straggler exists): host walks next to the
   straggler, says `lines.fetch`; after `replyDelay` the straggler says `lines.dawdle`; both walk to their spots.
   `fetch` timeout: the straggler is released (goes home) and the meeting goes on.
4. **meeting**: everyone arrived: emotes off, `setPose('sit' | 'chat')`, `face(table centre)`; one `lines.talk` every
   `lineEvery` from a seeded participant, for `meetingMs`.
5. **disperse**: host says `lines.close`; everyone `goHome`; claims released on arrival or after `return`.
- Break-off (checked every step): a participant no longer eligible for its role → released at once (left alone if
  walking, else `goHome`); host lost, or fewer than 2 participants left → disperse. `revoke` → drop the key.
- Reserved spot tiles are released when the meeting phase starts (like drama) and in `abort`.
- Reduced motion or ambient off: meetings are not started; a running one `cancel`s.

#### 3.2.6 Activity script (W2-2)
- **gather**: walk the cast to `spots` (in place when `requires` is `[]`), `gather` timeout = `LIFE_TIMING.convene`.
- **play**: `setPose(activity.pose)`, `setDramaEmote(activity.emote)`, `face(prop centre)`; a seeded line every
  `lineEvery`; for `durationMs`.
- **return**: clear pose/emote, `goHome`, release on arrival or `return` timeout.
- Under reduced motion only in-place activities run (static pose, no walking). Break-off and revoke as for meetings.

#### 3.2.7 Content (W1-16..18)
Per style, at least 11 activities covering both cast sizes, plus `kickoff`/`standup` `MeetingLines` with at least 3
lines per pool. Suggested set (D2: same kinds, themed lines):

| modern | guild | rift | requires | cast | pose |
|---|---|---|---|---|---|
| coffee chat | ale at the bar | nutrient bar | coffee-machine, counter | 2-3 | sip |
| water cooler gossip | well gossip | coolant gossip | water-cooler | 2-3 | chat |
| arcade | darts | holo-arcade | arcade | 1-2 | play |
| ping-pong | arm-wrestling | zero-g paddle | ping-pong | 2 | play |
| foosball | dice | hover-puck | foosball | 2-4 | play |
| board game | cards | holo-chess | board-game-table | 2-4 | play |
| stretch | stretch | gravity stretch | [] | 1 | stretch |
| phone call | sending-stone call | comm call | [] | 1 | phone |
| water a plant | tend herbs | tend void-moss | plant | 1 | water |
| sofa nap | hearth nap | stasis nap | sofa | 1 | nap |
| whiteboard doodle | rune doodle | star-chart doodle | board | 1 | doodle |

### 3.3 Alerts (13.4)

#### 3.3.1 Files
- W1-3 (pure): `features/office/alerts/alertQueue.ts`, `typewriter.ts`.
- W1-4 (UI): `alertSources.ts`, `alertCopy.ts`, `useAlertFeed.ts`, `AlertBox.tsx`, `AlertHost.tsx`.

#### 3.3.2 `alertQueue.ts` (pure token bucket + coalescing)

```ts
export function initialAlertQueue(cfg: AlertSettings, nowMs: number): AlertQueueState; // tokens = burst
/** Drops when: disabled or kind off; same agent offered the same key last (exact repeat); within agentCooldownSec of
 *  an alert shown for that agent with priority >= this kind's. Merges into a pending item of the same kind created
 *  within coalesceMs (agent ids deduped); else appends (pending capped at pendingMax, lowest priority/oldest dropped).
 *  `lastKey` is updated even when dropped. */
export function offerAlert(s: AlertQueueState, input: AlertInput, cfg: AlertSettings, nowMs: number): AlertQueueState;
/** Refill (perMinute/60_000 per ms, capped at burst); expire visible items (autoDismissSec > 0); drop pending older
 *  than pendingTtlMs. hidden: pending cleared, nothing shown. Otherwise, while tokens >= 1 and visible < maxVisible,
 *  show the highest-priority then oldest pending item whose coalesce window has passed (consumes one token). */
export function tickAlerts(s: AlertQueueState, cfg: AlertSettings, nowMs: number, hidden: boolean): { state: AlertQueueState; shown: readonly AlertItem[] };
export function dismissAlert(s: AlertQueueState, id: string): AlertQueueState;
// typewriter.ts
export function typewriterText(text: string, elapsedMs: number, charsPerSec: number, reduced: boolean): string;
export function typewriterDone(text: string, elapsedMs: number, charsPerSec: number, reduced: boolean): boolean;
```

#### 3.3.3 Sources and copy (W1-4)

```ts
/** ask: status became waiting|blocked (key = status). done: status became done (key 'done'). Only agents on the
 *  selected floor; no alert for agents first seen in `next` already in that status (snapshot/floor switch). */
export function alertsFromAgents(prev: Readonly<Record<string, Agent>>, next: Readonly<Record<string, Agent>>, onFloor: (projectId: string) => boolean, nowMs: number): AlertInput[];
/** failure: events with id > afterId, hookEvent === 'PostToolUseFailure', on the floor, ts >= now - replayGraceMs. */
export function alertsFromEvents(events: readonly OfficeEvent[], afterId: number, onFloor: (projectId: string) => boolean, nowMs: number): { inputs: AlertInput[]; lastId: number };
export interface AlertCopy { icon: string; title: string; body?: string }
/** ask "❓ {name} asks for you"; failure "💥 {name} stumbled: {tool} failed"; done "⚔ Quest complete!" (body
 *  "{name}: {description}"). Coalesced: "{n} heroes need you" (modern "teammates", rift "crew"). */
export function alertCopy(item: AlertItem, style: 'modern' | 'guild' | 'rift', names: readonly string[], description?: string): AlertCopy;
```
- `useAlertFeed()` subscribes to `officeStore` (agents and events; `afterId` starts at the max id present on mount),
  runs a 500 ms `tickAlerts` interval with `hidden = document.visibilityState === 'hidden'` (the existing
  `lib/notify.ts` keeps handling the hidden tab), emits `sfxBus.emit({ id: 'alert-ask' | 'alert-fail' | 'alert-done' })`
  for each shown item, and returns `{ visible, dismiss(id) }`.
- `AlertHost({ onShowMe }: { onShowMe: (agentId: string) => void })`: top-right stack (phone: inset-x-2 under the top
  bar), `pointer-events-auto` only on boxes. Non-modal, never moves focus. Container `aria-live="polite"`,
  `role="status"`; each box has "Show me" (calls `onShowMe(agentIds[0])`, then dismisses) and a dismiss button
  (`aria-label`), Esc is NOT captured.
- `AlertBox`: JRPG frame (double border, theme accent), the `hud/Portrait` of the agent (`usePortraitLook`),
  title + typewriter body (30 chars/s). Reveal is a CSS transform/opacity transition under `motion-safe:`; under
  reduced motion the full text shows at once with no transition (follow the `animate` skill if available).

### 3.4 Coordination: `CosmeticClaims` (W1-11)
- `game/cosmetic/claims.ts`: `export class CosmeticClaims implements CosmeticClaimsApi` (section 2.3 semantics).
- `game/cosmetic/eligible.ts`: `isIdleEligible(c: Pick<Character, 'gone' | 'leaving' | 'lifecycleFrame' | 'boundAgentId'>, agent: Agent | undefined): boolean`
  (drama's `stillOk`), `waitingTiles(actors: Iterable<Character>): Point[]`.
- One instance per scene (`OfficeScene.claims`), passed to drama, life and NPC hosts.
- `DramaDirector` adopts it: `DramaHost` gains optional `claims?(): CosmeticClaimsApi` (a private instance when absent,
  so existing tests still compile). `tryStart` claims every key as `drama` (aborts and releases all on any failure);
  `candidates()` skips claimed keys; gather-spot `isFree` also checks `isTileReserved`; `finish`/`cancel`/`reset`
  release. `onRevoke(key)`: clear that character's drama emote/bubble without moving it, remove it from the scene,
  and cancel the rest of a pair scene.
- Priorities: meeting (3) > reaction (2) > drama = activity (1). A reaction may pull an idle character out of an antic;
  a kickoff may pull anyone out of anything; nothing preempts a meeting.
- Caps: drama keeps `max(1, floor(maxBubbles / 2))` scenes; life `maxConcurrent` scripts; NPCs `maxConcurrent`
  actors with at most `maxReactors` reactors each. Reset order on rebuild/floor change: drama, life, npcs, then
  `claims.clear()`.

### 3.5 NPCs and encounters (13.3)

#### 3.5.1 Files
- W1-13 (art): `themes/costumes.ts` (new hats `cap`, `police-cap`, `fedora`, `hardhat`; staffs `mop`, `parcel`,
  `watering-can`, `clipboard`; `SHADES_TEXTURE` bitmap; `paintCostumeTextures` also calls `paintCreatureTextures`),
  `game/npc/creatures.ts` (`CREATURE_BITMAPS: Record<CreatureId, readonly [Bitmap, Bitmap]>`,
  `paintCreatureTextures(scene)`, each frame <= 14x10, feet at the bottom row).
- W1-15 (pure): `game/npc/encounters.ts`, `game/npc/rules.ts`.
- W2-4: `game/npc/script.ts` (`export const createScriptRunner: CreateScriptRunner`).
- W2-5: `game/npc/reactions.ts` (`export const createReactions: CreateReactions`).
- W2-6: `game/npc/npcDirector.ts`.

#### 3.5.2 Encounter table (`encounters.ts`) and rules (`rules.ts`)

```ts
export const ENCOUNTERS: Readonly<Record<NpcKind, EncounterDef>>;
/** Weighted seeded pick of weight * hours[hour] over kinds that are not disabled, not the janitor, not in `active`,
 *  and (when !settings.encounters) routine. null when the total is 0 or `!settings.enabled`. */
export function pickEncounter(hour: number, rand: () => number, settings: NpcSettings, active?: ReadonlySet<NpcKind>): EncounterDef | null;
/** 'mop' once per evening hour (18-23) bucket, 'bins' on a burst; both respect janitorCooldown; null when off/disabled. */
export function janitorDue(hour: number, burst: boolean, lastAtMs: number | null, nowMs: number, settings: NpcSettings): 'mop' | 'bins' | null;
/** Burst = floor-wide toolCount rose by >= 12 within 60 s (constants BURST_TOOLS, BURST_WINDOW_MS). */
export class BurstMeter { observe(agents: readonly Pick<Agent, 'id' | 'toolCount'>[], nowMs: number): void; burst(nowMs: number): boolean; clear(): void }
export interface ReactorCandidate { key: ActorKey; x: number; y: number }
/** Nearest first within 6 tiles of the NPC, never within WAITING_CLEARANCE_TILES of a waiting tile, at most `max`. */
export function pickReactors(cands: readonly ReactorCandidate[], npcTile: Point, waiting: readonly Point[], max: number, seed: string): ActorKey[];
/** A free walkable tile >= 4 tiles from `threat`, preferring the same room, clear of waiting characters. */
export function fleeTarget(map: Pick<GeneratedMap, 'walkable' | 'roomAt' | 'cols' | 'rows'>, from: Point, threat: Point, rand: () => number, isFree: (p: Point) => boolean): Point | null;
export function nextEncounterDelayMs(floorKey: string, bucket: number, everySec: number): number; // everySec*1000*(0.5..1.5)
/** `theme.npcs?.skins[kind]`, else a neutral built-in skin (name = humanized kind, color 0x8e8e9e, no costume). */
export function npcSkin(theme: Pick<ThemeDefinition, 'npcs'>, kind: NpcKind): NpcSkin;
```

| kind | routine | weight | hours (peak) | steps | reaction | modern / guild / rift skin |
|---|---|---|---|---|---|---|
| janitor | yes | (janitorDue) | 18-23 + bursts | enter, sweep 12, goto {bin}, bit sweep 4-6 s, exit | none | Janitor / Broom Goblin / Maintenance Drone (hardhat) |
| courier | yes | 3 | 9-17 | enter, goto entrance, bit carry 4-6 s line, exit | none | Courier / Messenger / Cargo Runner |
| plant-waterer | yes | 2 | 7-11 | enter, goto {plant}, bit water 4 s, wander 1, goto {plant}, bit water, exit | none | Plant Carer / Herbalist / Hydroponist |
| guest | no | 3 | 9-18 | enter, wander 2, goto crowd, bit chat 5-7 s line, exit | gather | Guest / Merchant / Star Pilgrim |
| police | no | 1 | 10-22 | enter, goto crowd, bit whistle 4-6 s line, exit | flee | Police / Town Guard / Rift Warden |
| cia-agent | no | 1 | 20-4 | enter, wander 3, bit phone 5 s line, exit | none | CIA Agent (shades) / Inquisitor (shades) / Void Auditor |
| sales-dog | no | 2 | 9-17 | enter, goto crowd, bit cheer 5 s bark, exit | chase | Sales Dog (dog) / Wolf (wolf) / Hover Hound (hover-hound) |
| monster | no | 1 | 22-5 | enter, wander 2, bit cheer 4 s roar, exit | flee | Bug Monster (monster) / Slime (slime) / Void Blob (void-blob) |
| office-cat | no | 3 | all day, x2 at night | enter, goto {sofa}, bit nap 8-12 s meow, exit | gather | Office Cat (cat) / Familiar (familiar) / Astro Cat (astro-cat) |

#### 3.5.3 Script runner (W2-4)
- `enter`: emit `appeared`; `sfx('door-bell', at spawn)` and `npc-jingle-<skin.jingle>`.
- `goto`: resolve the target to a tile clear of waiting characters (`furniture` → nearest item → `propSpots`;
  `rooms` → a seeded free tile of a room of that type; `corridor` → a seeded free hall tile (`roomAt` null);
  `entrance` → a free tile next to the reception desk, else next to `map.spawn`; `crowd` → the room with the most
  idle-eligible cast characters, a free tile near them); walk; done on arrival or `stepTimeout`.
- `wander n`: n successive seeded rooms. `sweep n`: n successive corridor tiles with a `sweepPause` in pose `sweep` and
  a `mop` sfx at each.
- `bit`: `setPose`, `face` the nearest cast character, a `skin.lines` line when `line`, `sfx(step.sfx ?? skin.sound)`,
  emit `bit`, `ctx.react(npc, step.react)` when set; wait the seeded duration.
- `exit`: walk to `map.spawn`, then `char.leave(null)`; emit `left`; `done` once `char.gone`.
- `npc.held` (M14): stay in the current step (pose `chat`), no timeout progress. Any step past `scriptMax` → `exit`.

#### 3.5.4 Reactions (W2-5)
- `start`: candidates = cast characters that are idle-eligible, not walking, claim free or held by `drama`/`activity`,
  in the NPC's room or within 6 tiles; `pickReactors(..., office.npcs.maxReactors)`; claim each as `reaction`.
  Duration per reactor = `reactMin + rand * reactSpan`.
  - `flee`: emote `alarm`, walk to `fleeTarget`.
  - `gather`: emote `heart` (cat) or `laugh`, walk to `ringSpots` around the NPC tile, `face(npc)`.
  - `chase`: emote `alarm`, repath toward the NPC every `chaseRepath`.
- On end: clear emote/pose, `goHome`, release on arrival (or `LIFE_TIMING.return`). Revoke (a meeting) drops the key.
  A reactor that becomes ineligible is released at once (left alone if walking).
- Gate: only when `npcs.allowChaos && !lowQuality()` (the runner checks before calling `react`).

#### 3.5.5 Director (W2-6)
`new NpcDirector(host: NpcHost, f: { createScriptRunner: CreateScriptRunner; createReactions: CreateReactions })` with
`reset(opts?: { sendHome?: boolean }): void` (destroys every NPC; reactors go home when `sendHome`, used by applySkin),
`afterCast(nowMs: number): void` (feeds `BurstMeter`), `update(time: number, delta: number, speed: number): void`
(ticks its own NPC `Character`s every frame, logic on a 500 ms throttle), `npcs(): ReadonlyMap<ActorKey, Character>`,
`setDim(alpha: number): void`, `destroy(): void`, and the M14 hooks `hold(id: string): boolean`,
`release(id: string): void`, `dismiss(id: string): void` (jump to `exit`).
- Gates: `npcs.enabled && office.ambientEffects && !isMultiverse()`; otherwise no new NPCs and the
  existing ones exit. Reduced motion allows a static visit only: the NPC appears at the door, stays for one bit's
  duration (same `appeared`/`bit`/`left` events, so a battle can be offered), then leaves; no walking, reactions or janitor.
- Schedule: janitor via `janitorDue(host.hour(), burst, ...)` when `npcs.janitor`; others via `nextEncounterDelayMs` +
  `pickEncounter(host.hour(), dramaRng(seed), npcs, activeKinds)`. Capacity `lowQuality ? 1 : npcs.maxConcurrent`,
  one NPC per kind at a time.
- Spawn: key `npc:<kind>:<seq>` at `map.spawn` via `host.spawnNpc`; then `setLook({ color, name, title, sprite: 0 })`,
  `setCostume(skin.costume ?? {}, color)`, `setCreature(skin.creature ?? null)`, `setActivity('idle', 'active')`,
  `setPlateOptions(plateOptions(office.labels))`.

#### 3.5.6 M14 hooks left in place
- `EncounterEvent` (`appeared` / `bit` / `left`) forwarded by `OfficeGame` as the `encounter` event.
- `NpcDirector.hold/release/dismiss` for the "Battle / Ignore" prompt and `autoIgnoreSec`.
- `NpcKind` is the M14 enemy roster key; `ENCOUNTERS` weights stay the encounter source. M14 adds
  `OfficeGame.holdEncounter/releaseEncounter/dismissEncounter` pass-throughs.

### 3.6 Gates

| condition | plates | alerts | audio | drama | life meetings | life walking activities | life in-place activities | NPCs | chaos |
|---|---|---|---|---|---|---|---|---|---|
| feature flag off (`labels.*`, `alerts.enabled`, `office.sound`+prefs, `life.enabled`, `npcs.enabled`) | Text fallback / n.a. | off | off | | off | off | off | off | off |
| `ambientEffects` off | on | on | on | off | off | off | off | off | off |
| reduced motion | on | no reveal/typewriter | on | in place | off | off | on (static) | static visit at the door (no walking, no chaos; still emits the encounter event) | off |
| quality `low` | on | on | on | on | max 1 script | | | max 1 | off |
| canvas renderer | system text | on | on | on | on | on | on | on | on |
| tab hidden | n.a. | queue paused, notify.ts | master 0 (suspend) | | | | | | |
| Multiverse | on | on | on | on | per realm | per realm | on | off | off |

### 3.7 Audio (13.5)

#### 3.7.1 Files
- W1-5 synth: `lib/audio/sfxr.ts`, `presets.ts`, `ambient.ts`.
- W1-6 engine: `lib/audio/engine.ts`, `mix.ts`, `spatial.ts`.
- W1-7 glue: `stores/audioPrefsStore.ts`, `features/office/audio/useAudioBridge.ts`, `features/office/audio/SoundRow.tsx`,
  `game/sfxProximity.ts`.

#### 3.7.2 Contracts and rules
- `renderSfx(p, sampleRate)`: deterministic (seeded noise, mulberry32), length = attack + sustain + decay (or the
  notes' end), peak <= `gain`, no NaN, one-pole filters. Rendered once per id per `AudioContext` and cached as an
  `AudioBuffer`.
- `SFX_PRESETS`: every `SfxId`; total duration <= 1.5 s (gong/fanfare) and footstep/typing <= 0.08 s.
- Ambient: `ambientFor('modern', false) = 'office-day'` (filtered brown noise hum + rare soft keyboard ticks),
  `office-night` (cricket chirps from gated sine bursts), `tavern-day/night` (band-passed murmur noise + fire crackle),
  `rift` (detuned low oscillators + slow LFO). Built from `AudioBufferSourceNode`/`OscillatorNode`/`BiquadFilterNode`
  graphs into one bus gain; ambient gain is 0.25 x master; `stop()` disconnects everything.
- `resolveMix(office, prefs, hidden)`: `muted = prefs.muted ?? !office.sound`; `master = hidden || muted ? 0 :
  (prefs.volume ?? office.audio.volume)`; the four toggles copy `office.audio`.
- `spatial.ts`: `spatialGain(at: Point, l: SfxListenerPose): number` = 1 inside the central half of the view, linear
  to 0 at 1.25 x the half-diagonal; `spatialPan(at, l): number` = clamp((at.x - l.x) / l.halfW, -1, 1) * 0.6.
- Engine: unlocks on the first `pointerdown`/`keydown` on `target` (one-shot listeners, then `ctx.resume()`); no-op
  when `createContext()` returns null (tests, old browsers); max 8 concurrent voices (extra dropped); per-id min
  interval 60 ms (`footstep` 250 ms, `typing` 150 ms); `play` respects `SFX_CATEGORY` vs the mix; `master === 0`
  suspends the context. Phaser keeps `audio: { noAudio: true }`.
- `audioPrefsStore` (ADR #25 pattern, a copy of `displayPrefsStore`'s storage handling): localStorage `tagconn.audio`
  = `{ muted: boolean | null, volume: number | null }`, `setMuted`, `setVolume` (clamped 0..1), `reset`.
- `useAudioBridge(active: boolean)`: `engine.setMix(resolveMix(...))` on settings/prefs/visibility/`active` changes
  (inactive tab = master 0); `sfxBus.on(e => engine.play(e.id, { gain: (e.gain ?? 1) * (e.at && l ? spatialGain(e.at, l) : 1), pan }))`
  (skip when the spatial gain is 0); `sfxBus.onAmbient(a => engine.setAmbient(mix.ambient ? ambientFor(a.style, a.night) : null))`.
- `SoundRow` (menu sheet ☰): a speaker toggle button (`🔊`/`🔇`, `aria-pressed`), a volume range input (`aria-label`),
  and "Use server default" (reset). Clicking it is the user gesture that unlocks audio; plays `ui-click`.
- `game/sfxProximity.ts`:

```ts
export interface ProximityActor { x: number; y: number; walking: boolean; typing: boolean }
export interface ProximityState { lastStepAt: number; lastTypeAt: number }
/** At most one footstep per 280 ms (nearest walking actor) and one typing tick per 180 ms (nearest typing actor),
 *  only for actors with spatialGain > 0; gains 0.35 / 0.25. */
export function pickProximitySfx(actors: Iterable<ProximityActor>, l: SfxListenerPose, nowMs: number, s: ProximityState): { events: SfxEvent[]; state: ProximityState };
export function listenerFromCamera(cam: { midPoint: { x: number; y: number }; worldView: { width: number; height: number } }): SfxListenerPose;
export class ProximitySfx {
  /** 100 ms throttle: sets sfxBus' listener and emits picked events. */
  tick(nowMs: number, actors: Iterable<ProximityActor>, listener: SfxListenerPose): void;
}
```
`pickProximitySfx` needs `spatialGain`; to keep W1-7 independent of W1-6 it uses its own inline "inside the view
rectangle" check (the engine applies the real falloff).

---

## 4. Integration surface (PM only)

### 4.1 After Wave 1 (W1-W)
`game/scenes/OfficeScene.ts`
1. `applyMemberLook` (`:1351-1352`): `c.setLook({ color, name: hero?.name, title: themedTitle, description: agent.isMain ? undefined : agent.description, sprite: role?.sprite ?? 0 }, true)` (drop the `${hero.name} · ` concatenation).
2. `enterResting` (`:1310`): `c.setLook({ color: 0x8e8e9e, name, title: 'Resting', sprite: 0 }, true)`.
3. `refreshLabels` (`:1438-1444`): per actor, before `setTagVisible`: `c.setPlateOptions(plateOptions(office.labels)); c.setPlateZoom(zoom);` (compute `plateOptions` once per call). The Receptionist gets the same.
4. Fields + `create()`: `private proximity = new ProximitySfx();`.
5. `update()` after `this.triggers.update(...)`: `this.proximity.tick(time, this.proximityActors(), listenerFromCamera(this.cameras.main));`
   with a private generator `proximityActors()` yielding `{ x: c.x, y: c.y, walking: c.walking, typing: c.currentActivity === 'typing' }`
   for `characters` (and NPCs after W2).
6. `applyLighting()` end: `sfxBus.setAmbient({ style: this.theme.id === 'modern' ? 'modern' : this.theme.id === 'guild' ? 'guild' : 'rift', night: isNight });`
7. SHUTDOWN handler: `sfxBus.setListener(null);`.

`features/office/OfficeView.tsx`: `useAudioBridge(active);` after `useFurnitureTriggers(game);`, and
`<AlertHost onShowMe={selectAgent} />` inside the `wrap` div after the top-centre column.
`app/MenuSheet.tsx`: `<SoundRow />` right after `<ScreenEffectRow />`.

### 4.2 After Wave 2 (W2-W)
`game/postfx/PostFxController.ts`: `get resolvedQuality(): 'low' | 'high'` (the value `resolveQuality` last computed; `'high'` before the first apply).

`game/scenes/OfficeScene.ts` (modeled on the DramaDirector wiring):
1. Imports; fields `private claims = new CosmeticClaims(); private life!: LifeDirector; private npcs!: NpcDirector;`.
2. `create()` drama host: add `claims: () => this.claims`. Then construct, before the first `buildWorld`:
   - `this.life = new LifeDirector({ map, finder, seats, actors: () => this.characters, agents, themeFor /* same as drama */, office, floorKey, reducedMotion, lowQuality: () => this.postFx.resolvedQuality === 'low', claims: () => this.claims, keyForAgent: (id) => this.agentIndex.get(id), realmRooms: (c) => (c.realmIndex !== null ? (this.realmScopes.get(c.realmIndex)?.roomIds ?? null) : null) }, { startMeeting, startActivity });`
   - `this.npcs = new NpcDirector({ map, finder, seats, actors: () => this.characters, agents, theme: () => this.theme, office, floorKey, reducedMotion, lowQuality, isMultiverse: () => this.multiversePlan !== null, hour: () => new Date().getHours(), claims: () => this.claims, spawnNpc: (key, at) => this.spawnNpc(key, at), emit: (e) => this.events.emit('encounter', e) }, { createScriptRunner, createReactions });`
   - private `spawnNpc(key, at)`: `new Character(this, key, 0, 0)`, `teleport(at)`, `setHitScale(this.currentHitScale)`, `pointerover/out → setHovered(key|null)`.
3. `buildWorld` (`:428`): after `this.drama.reset();` add `this.life.reset(); this.npcs.reset(); this.claims.clear();`.
4. `applySkin` (`:458-465`): `this.npcs.reset({ sendHome: true });`.
5. `setOfficeState` `if (instant)` block (`:1097`): after `this.drama.reset();` add `this.life.reset(); this.npcs.reset(); this.claims.clear();`.
6. After `this.drama.afterCast(Date.now())` (`:1105`): `this.life.afterCast(Date.now()); this.npcs.afterCast(Date.now());`.
7. `update()` after `this.drama.update(time, delta)` (`:1601`): `this.life.update(time, delta); this.npcs.update(time, delta, speed);`
   and in the `hitZoomChanged` branch: `for (const n of this.npcs.npcs().values()) n.setHitScale(this.currentHitScale);`.
8. `refreshLabels` (`:1436-1437`): `actors.push(...this.npcs.npcs())`; `actorFor` (`:529-531`): fall back to `this.npcs.npcs().get(key)`.
9. `applyFocusDim` (`:1418`): `this.npcs.setDim(alpha);`. `proximityActors()` also yields NPCs.
10. SHUTDOWN: `this.life.destroy(); this.npcs.destroy();`.

`game/OfficeGame.ts`: `Events` gains `encounter: (e: EncounterEvent) => void` (listener set, `ready.events.on('encounter', ...)`, cleared in `destroy`).

Then: root `pnpm typecheck && pnpm test && pnpm build`, `pnpm test:perf`, `?demo=1` smoke in modern, guild and
Multiverse (section 6.8), commit.

---

## 5. Tasks

Sizing per `packages/agent-templates/skills/task-sizing`. Waves run in order; tasks inside a wave are file-disjoint.
Paths are under `apps/web/src/` unless they start with `packages/`, `config/` or `docs/`. Every developer runs the
ROOT `pnpm typecheck` and the web tests before handing off, and never edits `OfficeScene.ts`, `OfficeView.tsx`,
`OfficeGame.ts`, `MenuSheet.tsx`, `CHANGELOG.md`, `ROADMAP.md` or `docs/`. A STUB file created in W0 is owned by
the Wave-1 task named in section 2.7; it must keep the W0 signatures.

### Wave 0 (contract; W0a and W0c in parallel, then W0b)

| id | title | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|---|
| W0a | Settings contract | developer | `packages/shared/src/settings.ts`, `features/settings/meta.ts`, `features/settings/meta.test.ts`, `config/office.yaml` | none | Section 1 verbatim; `defaultSettings()` has every new key with its default; meta hints/enum/step present; extended meta tests green; ROOT `pnpm typecheck` + `pnpm test` green (server settings tests included). |
| W0c | Furniture kinds | developer | `game/procgen/types.ts`, `game/procgen/pins.ts`, `game/themes/paint/furniture.ts` (alias lines only), `game/themes/paint/riftFurniture.ts` (alias lines only), `game/themes/__tests__/painters.test.ts`, `game/themes/__tests__/riftPainters.test.ts` | none | Section 2.9: 4 kinds in the union, `KIND_BLOCKING` true for each, placeholder painters in MODERN/GUILD/RIFT, test kind sets updated; existing maps unchanged (no recipe places the kinds yet); ROOT typecheck + web tests green. |
| W0b | Web contract + stubs | developer | `game/themes/types.ts`, `game/drama.ts` (EMOTE_ICON placeholders only), `game/sfxBus.ts` + `game/sfxBus.test.ts`, `game/cosmetic/types.ts`, `game/actors/poses.ts`, `game/life/types.ts`, `game/npc/types.ts`, `lib/audio/types.ts`, `features/office/alerts/types.ts`; STUBS: `game/actors/namePlate.ts`, `game/text/pixelFont.ts`, `features/office/alerts/alertQueue.ts`, `features/office/alerts/typewriter.ts`, `lib/audio/{sfxr,presets,ambient,mix,engine}.ts` | W0a (imports `NpcKind`) | Sections 2.1-2.8 verbatim; sfxBus tested (emit/on/off, listener, ambient replay, throwing listener isolated, `SFX_CATEGORY` total); stubs export the exact signatures with the stub bodies of 2.7; ROOT typecheck + web tests green. |

### Wave 1 (parallel)

| id | title | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|---|
| W1-1 | Plate layout + pixel font | developer | `game/actors/namePlate.ts`, `game/actors/__tests__/namePlate.test.ts`, `game/text/glyphs.ts`, `game/text/pixelFont.ts`, `game/text/__tests__/glyphs.test.ts` | W0 | 3.1.2/3.1.3 implemented; glyph tables cover `BIG_CHARS`/`SMALL_CHARS` with exact row sizes; tests per 6.1. |
| W1-2 | Character: plates + cosmetic hooks | developer | `game/actors/Character.ts`, `game/actors/poses.ts`, `game/actors/__tests__/poses.test.ts` | W0 (codes against the namePlate/pixelFont stubs) | 3.1.4: plate above the head, bubble above the plate, `tagRect`/`labelAnchor` consistent with the plate, canvas Text fallback, task line per mode, beacon above plate, chip position; `setPose`/`setCreature`/`face`/getters/shades; `POSE_ANIM` total and tested; `POSE_PROP` unchanged. |
| W1-3 | Alert queue (pure) | developer | `features/office/alerts/alertQueue.ts`, `features/office/alerts/typewriter.ts`, `features/office/alerts/__tests__/alertQueue.test.ts`, `features/office/alerts/__tests__/typewriter.test.ts` | W0 | 3.3.2 implemented and tested per 6.3. |
| W1-4 | Alert UI + feed | developer (frontend) | `features/office/alerts/alertSources.ts`, `features/office/alerts/alertCopy.ts`, `features/office/alerts/useAlertFeed.ts`, `features/office/alerts/AlertBox.tsx`, `features/office/alerts/AlertHost.tsx`, `features/office/alerts/__tests__/alertSources.test.ts`, `features/office/alerts/__tests__/alertCopy.test.ts` | W0 (codes against the queue stub) | 3.3.3: sources/copy tested per 6.4; host non-modal, `aria-live`, Show me/dismiss with labels, no focus steal, reduced-motion path, emits alert sfx. |
| W1-5 | Synth core | developer | `lib/audio/sfxr.ts`, `lib/audio/presets.ts`, `lib/audio/ambient.ts`, `lib/audio/__tests__/sfxr.test.ts`, `lib/audio/__tests__/presets.test.ts`, `lib/audio/__tests__/ambient.test.ts` | W0 | 3.7.2 synth rules; deterministic renders; preset durations within limits; `ambientFor` table tested; `createAmbient` builds/stops with a fake context. |
| W1-6 | Audio engine + mix | developer | `lib/audio/engine.ts`, `lib/audio/mix.ts`, `lib/audio/spatial.ts`, `lib/audio/__tests__/engine.test.ts`, `lib/audio/__tests__/mix.test.ts`, `lib/audio/__tests__/spatial.test.ts` | W0 (codes against the synth stubs) | 3.7.2 engine rules with a fake AudioContext: unlock on first gesture, category gating, voice cap, per-id interval, buffer cache, suspend at master 0, inert without context. |
| W1-7 | Audio prefs, bridge, menu row, proximity | developer (frontend) | `stores/audioPrefsStore.ts`, `stores/audioPrefsStore.test.ts`, `features/office/audio/useAudioBridge.ts`, `features/office/audio/SoundRow.tsx`, `game/sfxProximity.ts`, `game/__tests__/sfxProximity.test.ts` | W0 (codes against the engine/mix stubs) | Prefs storage per ADR #25 (bad storage never throws); bridge per 3.7.2; SoundRow accessible; proximity throttles and nearest-first tested. |
| W1-8 | Painters modern + guild | developer | `game/themes/paint/furniture.ts`, `game/themes/__tests__/painters.test.ts` | W0c | Real art for the 4 kinds (table 2.9) in modern and guild, inside the footprint (no overdraw unless `againstNorthWall`, cap `MAX_OVERDRAW_PX`); painters tests green. |
| W1-9 | Painters rift | developer | `game/themes/paint/riftFurniture.ts`, `game/themes/__tests__/riftPainters.test.ts` | W0c | Same for rift. |
| W1-10 | Lounge recipe slots | developer | `game/procgen/recipes.ts`, `game/procgen/__tests__/furnish.test.ts` | W0c | The lounge's extra 2x1 rows place, by slot index (no extra `rand()` calls): `ping-pong`, `board-game-table`, `foosball`, then `arcade` (1x1 at the slot's x), then `table`; seats and their positions unchanged; other rooms byte-identical; `pnpm test:perf` green. |
| W1-11 | Cosmetic claims + drama adoption | developer | `game/cosmetic/claims.ts`, `game/cosmetic/eligible.ts`, `game/cosmetic/__tests__/claims.test.ts`, `game/cosmetic/__tests__/eligible.test.ts`, `game/scenes/dramaDirector.ts`, `game/scenes/dramaDirector.test.ts` | W0 | 3.4: semantics tested; drama claims/releases, skips claimed keys, revoke handled, existing drama tests green, new test: a meeting claim revokes an antic without moving the character. |
| W1-12 | Life emotes + pose props art | developer | `game/textures.ts`, `game/textures.test.ts`, `game/drama.ts` | W0 | 10 `icon-<emote>` bitmaps (<= 7x7 before the outline) and 6 new `prop-*` bitmaps; EMOTE_ICON points at them; test: every EMOTE_ICON and POSE_PROP key has a bitmap. |
| W1-13 | NPC costumes + creatures art | developer | `game/themes/costumes.ts`, `game/themes/__tests__/costumes.test.ts`, `game/npc/creatures.ts`, `game/npc/__tests__/creatures.test.ts` | W0 | 3.5.1 art; every `CreatureId` has 2 frames <= 14x10; new hats/staffs/shades bitmaps; `paintCostumeTextures` paints creatures (idempotent). |
| W1-14 | Life rules + spots | developer | `game/life/rules.ts`, `game/life/spots.ts`, `game/life/__tests__/rules.test.ts`, `game/life/__tests__/spots.test.ts` | W0 | 3.2.3 implemented and tested per 6.5. |
| W1-15 | NPC rules + encounter table | developer | `game/npc/rules.ts`, `game/npc/encounters.ts`, `game/npc/__tests__/rules.test.ts`, `game/npc/__tests__/encounters.test.ts` | W0 | 3.5.2 implemented; table matches; tests per 6.6. |
| W1-16 | Content: modern | developer | `game/themes/modern.ts`, `game/themes/content/modernLife.ts`, `game/themes/content/modernNpcs.ts` | W0 | `life` + `npcs` per 3.2.7/3.5.2, validated by W1-18's content test. |
| W1-17 | Content: guild | developer | `game/themes/guild.ts`, `game/themes/content/guildLife.ts`, `game/themes/content/guildNpcs.ts` | W0 | Same for guild. |
| W1-18 | Content: rift + content test | developer | `game/themes/rift.ts`, `game/themes/content/riftLife.ts`, `game/themes/content/riftNpcs.ts`, `game/themes/__tests__/lifeContent.test.ts` | W0 | Same for rift. The test validates EVERY theme that sets `life`/`npcs` (so it is green whether or not W1-16/17 landed): >= 11 activities, unique ids, `requires` are FurnitureKinds, cast min <= max, weight > 0, every line <= 48 chars, >= 3 lines per meeting pool, a skin for every `NpcKind`, valid creature ids. The PM checks after the wave that all three themes set both fields. |
| W1-W | Wire plates, alerts, audio | PM | `game/scenes/OfficeScene.ts`, `features/office/OfficeView.tsx`, `app/MenuSheet.tsx` | W1-1..W1-7, W1-12 | Section 4.1; ROOT typecheck/test/build; smoke: plates in all styles and zooms, canvas fallback (force `Phaser.CANVAS` locally), alerts for ask/failure/done in demo, sound row toggles and plays. |

Hot files in Wave 1: `Character.ts` → W1-2; `procgen/types.ts` → none (W0c only); `paint/furniture.ts` → W1-8;
`riftFurniture.ts` → W1-9; `themes/modern.ts` / `guild.ts` / `rift.ts` → W1-16 / W1-17 / W1-18; `themes/types.ts` →
none (W0b only); `drama.ts` → W1-12; `dramaDirector.ts` → W1-11; `costumes.ts` → W1-13; `textures.ts` → W1-12.

### Wave 2 (parallel, then W2-W)

| id | title | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|---|
| W2-1 | Meeting script | developer | `game/life/meeting.ts`, `game/life/__tests__/meeting.test.ts` | W1-2, W1-11, W1-14 | 3.2.5 with fake chars (dramaDirector.test.ts style): phases in order, straggler fetched, break-off rules, revoke, abort releases every claim and tile, never calls SeatAllocator.assign/release. |
| W2-2 | Activity script | developer | `game/life/activity.ts`, `game/life/__tests__/activity.test.ts` | W1-2, W1-11, W1-14 | 3.2.6 with fakes: gather/play/return, pose/emote set and cleared, in-place under reduced motion, break-off, revoke. |
| W2-3 | Life director | developer | `game/life/lifeDirector.ts`, `game/life/__tests__/lifeDirector.test.ts` | W1-11, W1-14 | 3.2.4 with fake factories: kickoff from a delegating session with 2 spawns, stand-up timing, activity scheduling, caps, gates table, Multiverse realm limit, reset/abort, no waiting character ever cast. |
| W2-4 | NPC script runner | developer | `game/npc/script.ts`, `game/npc/__tests__/script.test.ts` | W1-2, W1-15 | 3.5.3 with fakes: every step kind, targets clear of waiting tiles, held pauses, scriptMax exit, events emitted in order. |
| W2-5 | NPC reactions | developer | `game/npc/reactions.ts`, `game/npc/__tests__/reactions.test.ts` | W1-2, W1-11, W1-15 | 3.5.4: reactor selection, flee/gather/chase, duration bounds, goHome + release, revoke, cancelAll; waiting characters never react. |
| W2-6 | NPC director | developer | `game/npc/npcDirector.ts`, `game/npc/__tests__/npcDirector.test.ts` | W1-13, W1-15 | 3.5.5 with fake factories and a fake `spawnNpc`: gates, capacity (incl. low quality), janitor schedule, one per kind, reset destroys NPCs, hold/release/dismiss, setDim. |
| W2-W | Wire life + NPCs | PM | `game/scenes/OfficeScene.ts`, `game/OfficeGame.ts`, `game/postfx/PostFxController.ts` | W2-1..W2-6 | Section 4.2; ROOT typecheck/test/build and `test:perf` green; smoke per 6.8. |
| Gate | QA, review, security, docs | qa-engineer, code-reviewer, security-engineer, tech-writer (parallel) | qa: tests only; tech-writer: `docs/guide/` (new life/NPC/alerts/sound pages, office/display updates), `CHANGELOG.md` | W2-W | Plan's gate: desktop + phone, every style, Multiverse; security: new settings bounds, localStorage parse, no new endpoints; docs current. |

Hot files in Wave 2: none of the theme/procgen/Character files are touched; `OfficeScene.ts`, `OfficeGame.ts` and
`PostFxController.ts` belong to W2-W only.

---

## 6. Test plan (vitest, pure first)

6.1 `namePlate.test.ts`: name only (anonymous) = 1 line; name + title = 2 lines; task wraps to exactly `maxLines`
with an ellipsis on the last line; a single word longer than maxW is hard-cut; empty/whitespace task omitted;
`maxLines` 0 omits the task; widths never exceed maxW; `w/h` include padding; `plateGlyphScale` gives integer
screen pixels (`zoom * scale` is an integer >= 1) for zoom 0.25..4; `taskVisible` truth table; `plateOptions` maps
settings. `glyphs.test.ts`: every char present with exact row counts/widths, only `#`/space, lowercase maps to the
small set.

6.2 `poses.test.ts`: `POSE_ANIM` and `POSE_PROP` total over `LifePose`; hand offsets within the 14x20 body box.

6.3 `alertQueue.test.ts`: burst then refill at perMinute (fake clock); priority order ask > failure > done; exact
repeat dropped; cooldown blocks same/lower priority but not a higher one; coalescing within `coalesceMs` merges
agent ids (deduped) and shows one item; pending cap and TTL; hidden clears pending and shows nothing; autoDismiss
0 keeps items; `maxVisible` respected; `dismissAlert`. `typewriter.test.ts`: reveal by elapsed time, reduced = full,
emoji/surrogate pairs not split.

6.4 `alertSources.test.ts`: transitions to waiting/blocked/done produce inputs once; agents first seen in a status
produce none; floor filter; failure events after `afterId` only, replay grace; `lastId` advances. `alertCopy.test.ts`:
per kind/style, coalesced counts, missing tool name.

6.5 `rules.test.ts` (life): `KickoffTracker` (opens on delegating, counts spawns in window, fires once, expires,
other sessions ignored); `standupDue` boundaries; `pickVenue` fallback chain and realm filter; `pickStraggler`
deterministic and null with < 2; `pickActivity` weighted (seeded histogram), requires filter, cast filter,
order-independent; `pickProp` nearest + taken; `nextLifeDelayMs` in range. `spots.test.ts`: `ringSpots`
deterministic, same room, free, adjacent; `propSpots` sofa vs table; `nearbySpot` radius; `nearWaiting`.

6.6 `rules.test.ts` (npc): `pickEncounter` never returns disabled kinds, the janitor, active kinds, zero-hour kinds;
`encounters: false` = routine only; `enabled: false` = null; weights respected (seeded histogram); `janitorDue`
evening/burst/cooldown; `BurstMeter`; `pickReactors` clearance and max; `fleeTarget` distance and clearance.
`encounters.test.ts`: every `NpcKind` defined, 24-entry hour curves, steps start with `enter` and end with `exit`.

6.7 Scripts and directors (fake Character like `dramaDirector.test.ts`): see W2 acceptance criteria. Shared assertions
in every suite: no call to `SeatAllocator.assign/release`; a character turning waiting/blocked or getting a tool
leaves the script within one step; claims released at the end; `abort` leaves nothing reserved.

6.8 PM smoke (`?demo=1`, modern, guild, Multiverse; desktop and 375x667): plates readable at min/max zoom; a hovered
character shows its task; a kickoff gathers the delegating PM and two subagents with one straggler fetched; a
stand-up after lowering `standupEverySec`; idle activities at arcade/sofa/cooler; an NPC enters, does its bit and
leaves through the front door; chaos never touches a waiting character; alerts appear with rate limiting; sound after
unmuting in the menu; toggling every new setting live; reduced motion (OS setting) stops walking scripts and NPCs.

---

## 7. Trade-offs

- **Claims registry over director-private sets.** One small shared object (and a drama edit in Wave 1) instead of
  three directors guessing about each other. Priorities make kickoffs win without the drama director knowing
  meetings exist.
- **Injected factories** (`LifeDirector`, `NpcDirector`) let six Wave-2 tasks run in parallel on disjoint files at the
  cost of two extra constructor arguments in the PM wiring.
- **Stubs in W0** (the M12 precedent) let consumers and implementers of the same API work in one wave; the cost is
  that a consumer only sees real behaviour after the wave.
- **Pixel font with integer screen scale.** Crisp at every zoom, at the price of plate size stepping with zoom (it
  snaps to whole screen pixels). Canvas gets system text because `BitmapText` tint is WebGL-only.
- **Plate fixed above the icon slot** instead of hugging the head: no bouncing when the idle `zz`/cup alternates;
  the plate sits a few pixels higher than strictly needed.
- **NPCs off on the Multiverse** in M13: one front door for many realms makes scripts awkward and the floor is already
  the busiest. Life still runs per realm.
- **Content next to `drama`** in `ThemeDefinition` (as planned), kept in `themes/content/*.ts` so the theme files only
  gain two lines each.
- **Sound off by default** (`office.sound` stays `false`): an observer tool should not make noise until asked; the
  menu row is one click and is also the audio unlock gesture.
