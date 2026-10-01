# The office is the game (M12 Wave 2 → v0.6.0)

Status: approved for implementation · Plan: `~/.claude-sessions/profiles/ilomon/plans/fix-the-role-serene-creek.md` "Wave 2"
Scope: G1 Drama, G2 HUD, G3 Furniture triggers, G4 Furniture locking. Web only; the server side of G1
(`Agent.toolStartedAt`, `apps/server/src/modules/agents/agents.service.ts:98,113`) shipped with Wave 1.

Read first: `docs/design/guild-hall.md` (procgen, themes), `docs/design/living-office.md` (cast, lifecycle,
heroes), `docs/design/back-wall.md` (appliances, `againstNorthWall`).

Principles kept from earlier milestones:
- **D2**: geometry never depends on style. Drama props, trigger furniture and pins are style-agnostic
  `FurnitureKind`s; only labels, lines and art are per style.
- **Contract first**: section 1 is pasted by the PM before any task starts (task W2-0), so every task
  compiles against it.
- **Configurable**: every threshold is a setting (`office.drama.*`, `office.furnitureTriggers`).
- **Pure core, thin Phaser shell**: every rule that can be a pure function is one, with tests.
- **OfficeScene.ts is a hot file** (1551 lines, three features want it). No task edits it. Each feature
  ships a self-contained module with a narrow host interface; the PM wires them in one small edit
  (section 6). The same goes for `OfficeView.tsx` for the one G3 line.

---

## 1. Contract (task W2-0, PM, before the wave)

### 1.1 Settings (`packages/shared/src/settings.ts:242-252`)

Add to `office.drama` (all with defaults, no `.default()` changes elsewhere):

```ts
/** A character waiting for you / blocked longer than this starts sweating. */
sweatAfterSec: z.number().min(10).max(3600).default(120),
/** "On a roll": at least this many tool calls ... */
streakTools: z.number().int().min(2).max(100).default(8),
/** ... within this window. */
streakWindowSec: z.number().min(10).max(600).default(60),
```

Add `KEY_HINTS` in `apps/web/src/features/settings/meta.ts` for `office.drama.enabled`, `idleChatSec`,
`tiredAfterSec`, `dizzyToolSec`, `sweatAfterSec`, `streakTools`, `streakWindowSec`,
`office.furnitureTriggers`, `office.selectionBeacon`. None is restart-required. Run the ROOT `pnpm typecheck`.

### 1.2 Procgen types (`apps/web/src/game/procgen/types.ts`)

```ts
export type FurnitureKind =
  | /* ...existing... */
  // M12 G3: trigger furniture placed by procgen/triggers.ts (2D: same kind in every style).
  | 'notice-board'
  | 'roster-board';

/** M12 G3: the panel a furniture item opens. A subset of `app/menuHotkeys.ts` MenuActionId (asserted by a test in G3). */
export type FurnitureAction = 'board' | 'log' | 'quests' | 'settings' | 'heroes' | 'receptionist';

export interface PlacedFurniture extends Rect {
  // ...existing fields...
  /** M12 G4: placed from `LayoutRoom.furniture` (a user pin); never removed by the reachability retry. */
  pinned?: true;
  /** M12 G3: this item is the floor's trigger for `action` (exactly one item per action, at most). */
  trigger?: FurnitureAction;
}
```

Adding two kinds breaks three exhaustive records and two test sets. W2-0 adds placeholders so the tree stays
green (G3 replaces them with real art):
- `themes/paint/furniture.ts:20` MODERN: `'notice-board': (g, f, T, r) => MODERN.board(g, f, T, r), 'roster-board': (g, f, T, r) => MODERN.board(g, f, T, r),`
- `themes/paint/furniture.ts:546` GUILD: same with `GUILD.board`.
- `themes/paint/riftFurniture.ts:79` RIFT: `'notice-board': paintCrystalAppliance, 'roster-board': paintCrystalAppliance,`
- `themes/__tests__/painters.test.ts:13` and `riftPainters.test.ts:12` `FURNITURE_KIND_SET`: add both kinds.

### 1.3 Theme types (`apps/web/src/game/themes/types.ts`)

```ts
import type { DecorSlot, FurnitureKind, GeneratedMap, PlacedFurniture, WallDecorSlot } from '../procgen/types';

/** Particle effects on a character. M12 adds `streak` (on a roll). Used by types.ts:95, fx.ts:196, Character.ts:301. */
export type ActivityFxKind = 'sparkles' | 'bubbles' | 'rune' | 'channel' | 'streak' | 'none';

/** M12 G1 work strain, in display priority order (dizzy wins). */
export type StrainKind = 'dizzy' | 'sweating' | 'tired' | 'on-a-roll';
export const STRAIN_PRIORITY: readonly StrainKind[] = ['dizzy', 'sweating', 'tired', 'on-a-roll'];

/** M12 G1 icon shown over a character during an idle antic. */
export type DramaEmote = 'mug' | 'note' | 'dice' | 'ball' | 'phone' | 'laugh' | 'spark' | 'zz';

export interface DramaAntic {
  /** kebab-case, unique within one theme's list. */
  id: string;
  /** The cast gathers next to ONE of these (the first kind present in the room wins). `[]` = acts in place. */
  props: readonly FurnitureKind[];
  /** 1 = solo, 2 = needs a partner in the same room. */
  cast: 1 | 2;
  emote?: DramaEmote;
  /** One exchange is picked per run: `[a]` for solo antics, `[a, b]` (b = the partner's reply) for pairs. Each line <= 48 chars. */
  lines: readonly (readonly [string] | readonly [string, string])[];
}

export interface DramaContent {
  antics: readonly DramaAntic[];
  /** One line is said (lowest bubble priority) when a strain starts. Each line <= 48 chars. */
  strain: Record<StrainKind, readonly string[]>;
}

export interface ThemeDefinition {
  // ...existing...
  activityFx?: Partial<Record<Activity, ActivityFxKind>>;   // was the inline union (line 95)
  /** M12 G1: idle antics + strain lines. Optional: a theme without it has no drama (rift reuses guild's). */
  drama?: DramaContent;
}
```

Also change the inline unions in `themes/fx.ts:196` and `actors/Character.ts:301` to `ActivityFxKind`
(`createActivityFx`'s `default:` branch already returns an empty container for `streak` until G1b implements it).
Re-export the new types from `themes/index.ts`.

### 1.4 Drama module stub (`apps/web/src/game/drama.ts`)

W2-0 writes this file with these exact exports; constants are final, function bodies are safe stubs
(`return null` / `[]` / `0`) that T1 replaces. T2 and T3 code against the signatures.

```ts
import type { Agent, Settings } from '@tagconn/shared';
import type { FurnitureKind } from './procgen/types';
import type { DramaAntic, DramaContent, DramaEmote, StrainKind, ThemeDefinition } from './themes/types';

export type DramaSettings = Settings['office']['drama'];

/** Texture keys (generated by textures.ts in T2). The HUD (T3) paints the same bitmaps. */
export const STRAIN_ICON: Record<StrainKind, string> = { dizzy: 'icon-dizzy-1', sweating: 'icon-sweat', tired: 'icon-yawn', 'on-a-roll': 'icon-fire' };
export const DIZZY_FRAMES = ['icon-dizzy-1', 'icon-dizzy-2', 'icon-dizzy-3'] as const;
export const EMOTE_ICON: Record<DramaEmote, string> = {
  mug: 'icon-mug', note: 'icon-note', dice: 'icon-dice', ball: 'icon-ball', phone: 'icon-phone', laugh: 'icon-laugh', spark: 'icon-sparkle', zz: 'icon-zz',
};
export const EMPTY_DRAMA: DramaContent = { antics: [], strain: { dizzy: [], sweating: [], tired: [], 'on-a-roll': [] } };

/** FNV-1a 32-bit (same as Character.ts:45 and seats.ts:6). */
export function dramaHash(s: string): number;
/** A deterministic [0,1) stream seeded by a string (mulberry32 over dramaHash). */
export function dramaRng(seed: string): () => number;
/** floor(nowMs / (idleChatSec * 1000)): the seeding bucket. */
export function dramaBucket(nowMs: number, idleChatSec: number): number;
/** Delay until the next drama attempt on a floor: idleChatSec * 1000 * (0.5 .. 1.5), seeded by (floorKey, bucket). */
export function nextDramaDelayMs(floorKey: string, bucket: number, idleChatSec: number): number;

export interface DramaCandidate { key: string; roomId: string; x: number; y: number }
export interface DramaCast { roomId: string; keys: readonly [string] | readonly [string, string] }
/**
 * Who acts next. Ignores rooms in `busyRoomIds`. Seeded pick of a room with candidates; in it, a pair
 * (the two closest by Manhattan distance, ties by key) when 2+ candidates and the seeded coin says "pair"
 * (p = 0.7), else a solo. Deterministic for the same inputs regardless of candidate order.
 */
export function pickCast(candidates: readonly DramaCandidate[], busyRoomIds: ReadonlySet<string>, seed: string): DramaCast | null;
/** A seeded antic with `cast === castSize` whose `props` is empty or intersects `roomProps`. */
export function pickAntic(content: DramaContent, roomProps: ReadonlySet<FurnitureKind>, castSize: 1 | 2, seed: string): DramaAntic | null;
/** A seeded exchange of `antic.lines`. */
export function pickExchange(antic: DramaAntic, seed: string): readonly [string] | readonly [string, string];

export type StrainInput = Pick<Agent, 'status' | 'activity' | 'startedAt' | 'updatedAt' | 'toolStartedAt'>;
/** Rules in section 2.4. `null` when calm, done, or `cfg.enabled` is false. */
export function strainFor(agent: StrainInput, nowMs: number, cfg: DramaSettings, onARoll: boolean): StrainKind | null;
/** A seeded strain line, or null when the list is empty. */
export function strainLine(content: DramaContent, kind: StrainKind, seed: string): string | null;
/** `theme.drama ?? EMPTY_DRAMA`. */
export function dramaFor(theme: Pick<ThemeDefinition, 'drama'>): DramaContent;

/** "On a roll": records (toolCount, time) samples per agent; a tool-count drop (a new agent reusing an id) resets it. */
export class StreakTracker {
  observe(agentId: string, toolCount: number, nowMs: number): void;
  /** True when toolCount rose by >= cfg.streakTools within the last cfg.streakWindowSec. */
  isOnARoll(agentId: string, nowMs: number, cfg: Pick<DramaSettings, 'streakTools' | 'streakWindowSec'>): boolean;
  forget(agentId: string): void;
}
```

### 1.5 OfficeGame event (`apps/web/src/game/OfficeGame.ts:27-48,60-69,75-82,182-190`)

```ts
/** M12 G3: a trigger furniture item was clicked (gated by `office.furnitureTriggers` in the scene). */
furnitureClick: (action: FurnitureAction) => void;
```
plus the listener set, the `ready.events.on('furnitureClick', ...)` forward and the `clear()` in `destroy()`.

W2-0 acceptance: root `pnpm typecheck` and `pnpm --filter @tagconn/web test` green; PM commits before the wave.

---

## 2. G1 Drama

### 2.1 What the user sees

- **Idle antics.** Every ~`idleChatSec` (45 s) per floor, one or two idle characters in the same room walk to an
  appliance (water cooler, coffee machine, counter, fireplace, table...) and play a short scene: speech bubbles
  in turn and an emote icon, 6-10 s, then walk back to their seat. Modern style plays office drama, guild plays
  tavern drama, the Multiverse rift reuses guild's.
- **Work strain** on characters that are on a quest:
  - **tired** (on one quest longer than `tiredAfterSec`): a yawn icon, a slight droop.
  - **dizzy** (the current tool has run longer than `dizzyToolSec`, from `Agent.toolStartedAt`): spinning stars
    over the head and a slow sway.
  - **sweating** (waiting for you or blocked longer than `sweatAfterSec`): a sweat drop beside the head, next to
    the existing `?` / `!`.
  - **on a roll** (`streakTools` tool calls within `streakWindowSec`): a flame icon plus orange sparks.
  - When a strain starts, the character says one strain line (lowest bubble priority).

### 2.2 Eligibility (who may act)

A cast `Character` (`OfficeScene.characters`, never the Receptionist) is a drama **candidate** when all hold:
- not `leaving`/`gone`, not walking (`Character.walking`), and the director is not already using it;
- either `lifecycleFrame.state === 'resting'` (living-office.md 4.2), or `state === 'quest'` and its bound agent has
  `status === 'active' && activity === 'idle'` (the server parks idle agents in the lounge,
  `agents.service.ts:331`);
- the character's tile is in a room (`map.roomAt`), not a corridor.

Waiting/blocked characters never do antics: they need you and must stay where they are.

### 2.3 The director (`game/scenes/dramaDirector.ts`, task T2)

A plain class (no `Phaser.Scene` subclass) that OfficeScene owns. Host interface (all getters, because
`buildWorld` replaces map/finder/seats, `OfficeScene.ts:390-397`):

```ts
export interface DramaHost {
  map(): GeneratedMap;
  finder(): PathFinder;
  seats(): SeatAllocator;
  actors(): ReadonlyMap<ActorKey, Character>;
  /** state.agents of this floor (the director indexes them by id each afterCast). */
  agents(): readonly Agent[];
  /** The theme the actor is drawn in (the realm's on the Multiverse, else the floor's). */
  themeFor(c: Character): ThemeDefinition;
  office(): Settings['office'] | undefined;
  floorKey(): string;
  reducedMotion(): boolean;
}
export class DramaDirector {
  constructor(host: DramaHost);
  /** buildWorld / floor change: drop every scene and every timer, touch no character (they are about to be teleported or destroyed). */
  reset(): void;
  /** End of setOfficeState: re-index agents, feed StreakTracker, cancel scenes whose cast became ineligible, refresh strain now. */
  afterCast(nowMs: number): void;
  /** Every frame; does real work on a 500 ms throttle (strain refresh, scene steps, scheduling). */
  update(time: number, delta: number): void;
  destroy(): void;
}
```

Scene state machine per running drama: `gathering` → `playing` → `returning` → done.

1. **Schedule.** `nextAt = now + nextDramaDelayMs(floorKey, dramaBucket(now, idleChatSec), idleChatSec)`. When
   `now >= nextAt`: collect candidates, `pickCast(candidates, busyRooms, `${floorKey}|${bucket}`)`. Concurrency cap:
   at most `max(1, floor(office.maxBubbles / 2))` running scenes per floor and one per room.
2. **Antic.** `roomProps` = kinds of `map.furniture` with that `roomId` (precomputed per room on `reset`).
   `pickAntic(dramaFor(themeFor(first)), roomProps, cast.keys.length, seed)`; a pair with no pair antic falls back
   to a solo antic for the first key. `null` → skip this attempt.
3. **Gather.** Pure `gatherSpots(map, prop, count, isFree)` in `game/dramaSpots.ts`: walkable tiles 4-adjacent to the
   prop's footprint, inside the same room, sorted by distance to the footprint centre then (y, x); `isFree(p)` =
   `seats.occupant(p) === undefined` (`seats.ts:51`) and no other director reservation and no character currently
   standing on it. Pairs take two spots, preferring ones on opposite or adjacent sides. No spots or an empty
   `props` → act in place (no walk). Walk with `finder.find(c.tile, spot)` then `c.walk(path, false, onArrive)`;
   a `null` path → act in place. Movement never assigns or releases seats: the actor keeps its
   `SeatAllocator` assignment the whole time, so `updateCast` (`OfficeScene.ts:1116-1127`) sees no change.
4. **Play.** When everyone arrived (or after a 6 s gather timeout): set the emote on all participants
   (`setDramaEmote`), A `sayDrama(line[0], 3)`, then B `sayDrama(line[1], 3)` 1.8 s later. Total 6-10 s
   (seeded). Lines are skipped (emote only) when `office.showBubbles` is false.
5. **Return.** Clear emotes/drama bubbles, walk each participant back to `seats().get(key)` with its `seated` flag
   (`Character.walk(path, seated)`); for a resting actor that is its lounge seat (`OfficeScene.ts:1250`).
6. **Cancel** (checked on every tick and in `afterCast`): a participant is no longer a candidate, is gone, or the
   flags turned drama off. Clear its drama state; if it is **not walking** (the scene did not just send it
   elsewhere), walk it back to its seat as in step 5; if it is walking, leave it (an `updateCast` walk already
   replaced the path and dropped our `onArrive`, `Character.ts:676-682`). The partner returns too.
7. **Lifecycle interplay.** `enterResting` (`OfficeScene.ts:1244`) walks once on entry; a resting actor the
   director moved is returned by step 5/6, so it always ends at its lounge seat. A rebind
   (`cameFromRestOrLeave`, `OfficeScene.ts:1090`) makes it ineligible → cancel → `updateCast`'s own walk wins.
   `enforceCaps` eviction sets `leaving` → cancel. A floor change calls `reset()` before the characters are
   destroyed (`OfficeScene.ts:1049-1053`); a rebuild calls `reset()` before `forceReseat` teleports.

**Strain refresh** (every 1 s inside the throttle, and in `afterCast`): for each quest-state actor with a bound
agent: `strainFor(agent, Date.now(), office.drama, tracker.isOnARoll(agent.id, now, office.drama))` →
`c.setStrain(kind, animated)`; on a `null → kind` transition say `strainLine(...)` once (seed = agent id + kind).
Resting/leaving actors get `setStrain(null)`. Timestamps are server epoch ms, so use `Date.now()` like
`updateCast` does (`OfficeScene.ts:1072`), never `scene.time.now`.

**Flags.**

| Condition | Antics | Strain icons | Strain motion/fx | Drama bubbles |
|---|---|---|---|---|
| `office.drama.enabled = false` | off | off | off | off |
| `office.ambientEffects = false` | off | static icon | off (no sway/droop, no `streak` fx) | strain line only |
| reduced motion (`host.reducedMotion()`) | in place only (no walking) | static frame | off | on |
| `office.showBubbles = false` | emote only | on | per above | off |

### 2.4 Pure rules (`game/drama.ts`, task T1)

`strainFor(agent, now, cfg, onARoll)`:
- `!cfg.enabled` or `status === 'done'` → `null`.
- **dizzy**: `toolStartedAt !== undefined && now - toolStartedAt >= cfg.dizzyToolSec * 1000`.
- **sweating**: `status` is `waiting` or `blocked` and `now - updatedAt >= cfg.sweatAfterSec * 1000`
  (`updatedAt` does not move while the agent waits, so it approximates "waiting since").
- **tired**: `status === 'active'`, `activity` not `idle`, and `now - startedAt >= cfg.tiredAfterSec * 1000`.
- **on-a-roll**: `onARoll && status === 'active'`.
- First match in `STRAIN_PRIORITY` order wins.

All pickers are pure functions of their string seed. Seeds: `${floorKey}|${bucket}` (cast),
`${keys.join('+')}|${bucket}` (antic, exchange), `${agentId}|${kind}` (strain line).

### 2.5 Character API (`actors/Character.ts`, task T2)

```ts
/** Strain overlay: `null` clears. `animated` false = static frame, no sway/droop, no streak fx. */
setStrain(kind: StrainKind | null, animated: boolean): void;
/** Emote in the main head-icon slot during an antic; `null` clears. */
setDramaEmote(emote: DramaEmote | null): void;
/** A drama bubble: shown like setBubble, but flagged so the label engine ranks it last. */
sayDrama(text: string, seconds: number): void;
/** Clears the drama emote and a still-visible drama bubble. */
clearDrama(): void;
get hasDramaBubble(): boolean;
```

Rules:
- **Bubble channels.** `setBubble` (`Character.ts:617`) dedups against a new `lastServerBubble` field instead of
  `lastBubble`, so the server bubble re-sent by every `applyMemberLook` (`OfficeScene.ts:1308`) does not wipe a
  drama line. A *changed* server bubble replaces a drama bubble at once and clears `hasDramaBubble`.
- **Icons.** A new `strainIcon` image beside the head at about (6, -17), so a sweat drop and the `?` show
  together. Dizzy cycles `DIZZY_FRAMES` at ~6 fps; sweat drips 0-3 px; yawn pulses alpha. The drama emote takes
  the main `icon` slot (`Character.ts:220`) only when `animate()` picked no activity/status icon or picked the
  idle `icon-zz`/cup (`Character.ts:879-886`): status icons `?` and `!` always win.
- **Motion** (when `animated`): tired adds +1 px to `bob` and lowers the right hand 1 px; dizzy sways
  `upper.x` by ±1 px at ~1 Hz. On a roll adds a second fx container with `createActivityFx(scene, 'streak', ...)`.
- `destroyAll()` also clears drama timers/tweens.

### 2.6 Textures and fx (task T2)

New bitmaps in `textures.ts:64-73` (same outline convention, at most 7x7 before the outline): `icon-dizzy-1`,
`icon-dizzy-2`, `icon-dizzy-3` (3 stars rotating), `icon-sweat` (blue drop), `icon-yawn` (open "O" mouth with a
small "z"), `icon-fire` (orange flame), `icon-mug`, `icon-note` (music note), `icon-dice`, `icon-ball`
(ping-pong ball + paddle), `icon-phone`, `icon-laugh` ("ha"). `textures.test.ts` asserts every key in
`STRAIN_ICON`, `DIZZY_FRAMES` and `EMOTE_ICON` exists in `CHARACTER_BITMAPS`.

`themes/fx.ts`: implement `streak` (warm orange sparks: reuse the `sparkles` helper with an orange tint and a
faster cadence) in `createActivityFx` (`fx.ts:194`).

### 2.7 Label priority (task T2)

`labels/types.ts` `LabelSubject` gains `drama?: boolean`. `labels/priority.ts:5` tier becomes
`selected 0, waiting 1, normal 2, drama 3`. So a drama bubble collapses first under `office.maxBubbles` and
never displaces a real one. `OfficeScene.refreshLabels` passes `drama: c.hasDramaBubble` (PM wiring, section 6).

### 2.8 Content (task T1: `themes/modern.ts`, `themes/guild.ts`, `themes/rift.ts`)

`rift.ts:188` sets `drama: guildTheme.drama`. All lines <= 48 chars (bubbles truncate at 60, `Character.ts:650`).
Props reference existing kinds (lounge/tavern rooms have `counter`, `table`, `sofa`, `armchair`, `plant` from
`recipes.ts:293-322` and `water-cooler`, `coffee-machine`, `fridge`, `fireplace` appliances from
`backWallSpec.ts:59`). Developers may add exchanges but must keep these.

**Modern: office drama** (12 antics)

| id | props | cast | emote | exchanges |
|---|---|---|---|---|
| water-cooler-gossip | water-cooler | 2 | | "Did you hear about the refactor?" / "Which one? There are three." · "Standup ran forty minutes." / "Was it a sit-down?" |
| coffee-run | coffee-machine | 1 | mug | "Coffee number four." · "This machine has better uptime than prod." |
| coffee-chat | coffee-machine | 2 | mug | "Decaf?" / "Do I look like I deploy on decaf?" |
| ping-pong | table | 2 | ball | "Best of three?" / "Loser fixes the flaky test." · "Spin serve!" / "That's not in the spec." |
| stretching | (none) | 1 | spark | "Stretch break. My spine is deprecated." · "Ten squats, then one more ticket." |
| phone-scrolling | sofa, armchair | 1 | phone | "Just checking the build... and memes." · "Someone starred our repo!" |
| who-broke-the-build | board, (none) | 2 | laugh | "Who broke the build?" / "Not me. git blame says... oh." · "CI is red again." / "Have you tried turning it green?" |
| desk-plant-chat | plant | 1 | | "You're the only one who listens, Fern." · "Photosynthesis looks so relaxing." |
| fridge-mystery | fridge | 2 | | "Whose yogurt is this?" / "The label says 'do not deploy'." |
| donut-alert | counter | 2 | mug | "Donuts in the kitchen!" / "Is it someone's birthday?" |
| tabs-vs-spaces | (none) | 2 | laugh | "Tabs." / "Spaces. Fight me." · "Dark mode or light mode?" / "Is that a trick question?" |
| weekend-plans | sofa, (none) | 2 | | "Plans for the weekend?" / "Finally reading the docs." |

(`(none)` in a list means the antic also runs in place: model it as two antics or as `props: []`; the
simplest is `props: []` for "anywhere" antics and a concrete list otherwise.)

Strain (modern): tired: "*yawn*", "Is it Friday yet?", "One more ticket...". dizzy: "Still compiling...",
"This is taking forever...", "My head is spinning.". sweating: "Waiting on you...", "Need a decision here!",
"Blocked. Sweating bullets.". on-a-roll: "On a roll!", "Ship it!", "In the zone.".

**Guild: tavern drama** (12 antics)

| id | props | cast | emote | exchanges |
|---|---|---|---|---|
| ale-toast | counter, table | 2 | mug | "To a quest well done!" / "And to the next one. Cheers!" · "Another round, innkeeper!" / "Put it on the guild's tab." |
| arm-wrestling | table | 2 | spark | "Best two of three?" / "Loser polishes the shields." |
| bards-tale | fireplace, (none) | 2 | note | "Sing us the Ballad of the Great Merge!" / "Only if you hum the chorus." |
| dice-game | table | 2 | dice | "Roll for initiative." / "Natural twenty!" · "Double or nothing?" / "My gold is cursed anyway." |
| sharpening-blade | (none) | 1 | spark | "A sharp blade, a sharp mind." · "One more edge, then the dragon." |
| quest-board-rumour | notice-board, board | 2 | | "Heard there's a hydra in the backlog." / "Cut one bug, two more appear." · "A new bounty was posted." / "Gold, or more tickets?" |
| fireside-nap | fireplace, sofa | 1 | zz | "Just resting my eyes..." · "Wake me when the portal opens." |
| potion-tasting | counter | 2 | mug | "This potion tastes of mana and regret." / "That's the cleaning tonic." |
| map-squabble | board, table | 2 | | "The shortcut is through the swamp." / "Last time that took three sprints." |
| tall-tale | (none) | 2 | laugh | "I once slew a bug with one semicolon." / "And I'm the Archmage of Tabs." |
| hearth-stories | fireplace | 2 | | "Remember the outage of the Long Night?" / "We do not speak of it." |
| shield-polish | (none) | 1 | spark | "Shiny enough to see my own bugs." |

Strain (guild, inherited by rift): tired: "*yawn* A long quest...", "My candle burns low.", "I need a tavern
break.". dizzy: "The spell is still channeling...", "The runes swim before my eyes.", "So... much... mana...".
sweating: "Awaiting your command!", "The gate won't open without you!", "By the gods, decide!". on-a-roll:
"The spells flow freely!", "Victory after victory!", "Unstoppable!".

---

## 3. G2 HUD

### 3.1 Layout

The docked `Roster` column (`OfficeView.tsx:559`) and the right-hand `AgentDrawer` (`OfficeView.tsx:549-556`)
go away. Everything floats over a full-width canvas:

```
+-------------------------------------------------------------+
| [status card]                 (toast)                        |
|                                                              |
|                      office canvas                           |
|                                                              |
| [+][-][Fit]   [chip][chip][chip][chip][+2 off canvas]        |
+-------------------------------------------------------------+
```

- **Party bar** (`features/office/hud/PartyBar.tsx`), bottom centre, one row of portrait chips in roster order
  (`useFloorAgents()` order, same as today, so `[`/`]` cycling matches). Horizontal scroll with a fade on
  overflow. Each chip (`PortraitChip.tsx`, a `button`, >= 44 px on `coarse:`): portrait, role-colour ring,
  status dot (`STATUS_STYLE` colours from `Roster.tsx:12`), strain icon (from `strainFor(..., onARoll=false)`),
  `main` pip, dimmed when done or off canvas. `aria-label` = "Name, Title, status". Selected chip raised.
  The "off canvas" toggle (`Roster.tsx:152-157`) becomes a trailing `+N off canvas` chip that expands them.
- **Phones** (new `PHONE_QUERY = '(max-width: 639px), (max-height: 500px)'` in `lib/useMediaQuery.ts`): the bar
  collapses to the existing pill (`Roster.tsx:172-187`); tapping opens the tray sheet (same classes as
  `Roster.tsx:190-197`) with the chips in a wrapping grid plus the per-agent rows. Selecting closes the tray.
- **Status card** (`StatusCard.tsx`), top-left, shown while something is selected: large portrait; name
  (`hero.name`, else the themed title); themed title (`useThemedRoleLookup`, `lib/hooks.ts:91`, which already
  calls `titleFor`) plus the plain title when it differs (like `Roster.tsx:83`); status/activity badge; current
  tool and how long it has run (`elapsed(toolStartedAt, now)`); quest time (`elapsed(startedAt, endedAt ?? now)`);
  **mana** bar = `contextRatio(usage)` (`lib/tokens.ts:24`) with `formatTokens(contextTokens) / formatTokens(contextWindowFor(model))`,
  `role="meter"` with `aria-valuenow`; **XP** = `formatTokens(totalTokens(usage))` with `Lv {xpLevel}`; the strain,
  as words ("Dizzy · tool running 2m 10s"); buttons **Details**, **Follow** (the checkbox moved here from
  `AgentDrawer.tsx:70`) and close (deselect). Phones: one compact row (portrait, name, mana bar, Details, close).
  The overflow banner and the "office is quiet" pill (`OfficeView.tsx:500-519`) move to top-centre so they never
  sit under the card.
- **Details** opens `AgentDetailsDialog.tsx`: the current drawer body inside `components/Sheet.tsx` (focus in, Tab
  trap, Esc closes, focus returns to the Details button; `data-modal` keeps the global hotkeys quiet). Refactor
  `AgentDrawer.tsx` into an exported `AgentDetails({ agentId })` body (the `<dl>`, tasks, recent activity,
  "Edit hero") used by the dialog; the old `aside` wrapper is deleted. Esc order: dialog first, then a second
  Esc deselects (existing handler `OfficeView.tsx:459-474` already skips while `isModalOpen()`).
- Kept as is: `[`/`]` cycling and its `aria-live` announcement (`OfficeView.tsx:344-366`, `494-497`), scene clicks,
  follow, focus dim, `GmSessionsPopover`.

### 3.2 Labels per style (`hud/hudMath.ts`)

```ts
export function hudLabels(style: OfficeStyle | 'rift'): { mana: string; xp: string } // modern: Context/Tokens · guild, rift: Mana/XP
/** 1 + floor(sqrt(tokens / 25_000)), clamped 1..99. */
export function xpLevel(totalTokens: number): number;
/** The strain sentence for the card, e.g. "Dizzy · tool running 2m 10s" (uses lib/format elapsed). */
export function strainSentence(kind: StrainKind, agent: StrainInput & Pick<Agent, 'currentTool'>, now: number): string;
```

### 3.3 Portraits (`game/heroPreview.ts`, task T3)

- `paintPortrait(ctx, opts: HeroPreviewOptions & { crop: 'bust' | 'full' })`: `paintHeroPreview` with the origin
  shifted so the head and shoulders fill the frame for `bust`.
- `anonymousAppearance(actorKey: string, sprite: number): HeroAppearance`: the same skin/hair the scene draws for an
  unbound actor (`Character.ts:187-190`, hair style `sprite % HAIR_STYLES` from `Character.ts:262`), so a chip
  matches the sprite. Actor key: `agent:<id>`, or `gm:<projectId>` for a main agent when `pmMode === 'single'`
  (`cast.ts:38-40`). A bound hero uses `heroLookForStyle(hero, style).appearance`. Style = the agent's floor style
  (`floorStyleFor`, `lib/hooks.ts:84`); on the Multiverse that is the realm's style.
- `Portrait.tsx` draws once per (appearance, role, colour, style, size) on a `<canvas>`; no animation.

### 3.4 Camera safe insets (`game/camera/insets.ts:109`, task T3)

`insetsFromOverlay` only handles edge-spanning panels; the card and the bar do not span. Add an optional edge
hint, backward compatible:

```ts
export type InsetEdge = 'top' | 'right' | 'bottom' | 'left';
/** `edge` given: inset that edge by the overlay's extent from it, whatever its shape. Omitted: today's inference. */
export function insetsFromOverlay(container: EdgeRect, overlay: EdgeRect, edgeSlop?: number, edge?: InsetEdge): SafeInsets;
```

Markup: `data-camera-overlay="top"` on the status card (desktop: card height; it is narrow, so this keeps a
selected character centred below it), `data-camera-overlay="bottom"` on the party bar and the open tray,
plain `data-camera-overlay` elsewhere. The measure effect (`OfficeView.tsx:434-455`) passes
`el.dataset.cameraOverlay || undefined` and re-runs on selection, tray, details and phone/desktop changes.
Tests in `camera/__tests__/insets.test.ts`.

---

## 4. G3 Furniture triggers

### 4.1 Mapping

The action is a property of the placed item (`PlacedFurniture.trigger`, set by procgen in G4a, section 5.3),
so exactly one item per action per floor glows. Kinds per action (style-agnostic, D2):

| Action (panel, hotkey) | Kinds that qualify | Kind placed when missing | modern label | guild label | rift label |
|---|---|---|---|---|---|
| board (Board, B) | `board` | `board` (w 2) | Kanban board | War map | Star chart |
| log (Log, L) | `bookcase`, `shelf-stack` | `bookcase` (w 2) | Bookcase | Guild ledger | Archive crystal |
| quests (Quests, Q) | `notice-board` | `notice-board` (w 1) | Notice board | Quest board | Bounty shard |
| settings (Settings, S) | `console` | `console` (w 1) | Server console | Arcane terminal | Rift console |
| heroes (Heroes, H) | `roster-board` | `roster-board` (w 1) | Team roster | Hall of Heroes | Hero constellation |
| receptionist (Receptionist, D) | `reception-desk` | placed in the entrance only (see 5.3) | Reception desk | Gatekeeper's desk | Nexus gate desk |

Pure module `game/furnitureTriggers.ts` (task T4):

```ts
export const TRIGGER_KINDS: Record<FurnitureAction, readonly FurnitureKind[]>;
export const TRIGGER_PLACE: Record<Exclude<FurnitureAction, 'receptionist'>, { kind: FurnitureKind; w: 1 | 2 }>;
export const TRIGGER_ORDER: readonly FurnitureAction[]; // ['receptionist','board','log','quests','settings','heroes']
export const TRIGGER_PANEL: Record<FurnitureAction, { panel: string; hotkey: string }>; // a test asserts hotkey === MENU_HOTKEYS[action]
export function triggerLabel(styleId: ThemeDefinition['id'], action: FurnitureAction): string;
/** "Quest board · Open Quests (Q)" */
export function triggerTooltip(styleId: ThemeDefinition['id'], action: FurnitureAction): string;
export function triggersOf(map: Pick<GeneratedMap, 'furniture'>): PlacedFurniture[]; // furniture with `trigger`, in TRIGGER_ORDER
/** First-seen pulse memory; storage injectable for tests (localStorage key `tagconn.furnitureSeen.v1`, a JSON array). */
export function createSeenStore(storage?: Pick<Storage, 'getItem' | 'setItem'> | null): { has(a: FurnitureAction): boolean; mark(a: FurnitureAction): void };
```

G4a imports `TRIGGER_KINDS`, `TRIGGER_PLACE`, `TRIGGER_ORDER` from here; this file has no Phaser import.
The two new kinds get real art (task T4) in `themes/paint/furniture.ts` (MODERN: cork board with pinned notes /
framed photo grid; GUILD: plank board with parchment bounties / heraldic banner on a stand) and
`riftFurniture.ts` (a crystal appliance variant with a glyph). They are wall-standing: 1 row deep, may overdraw up
to `MAX_OVERDRAW_PX` only when `againstNorthWall` (back-wall.md 2.2). `painters.test.ts` shapes include them.

### 4.2 Scene layer (`game/scenes/furnitureTriggerLayer.ts`, task T4)

```ts
export interface TriggerHost {
  showTooltip(text: string): void;
  hideTooltip(): void;
  /** False while inputLocked, mid-drag, pinching or pressing the edge arrow (same guard as OfficeScene.ts:453-455). */
  canClick(): boolean;
  emit(action: FurnitureAction): void;   // PM wiring: this.events.emit('furnitureClick', action)
  reducedMotion(): boolean;
}
export class FurnitureTriggerLayer {
  constructor(scene: Phaser.Scene, host: TriggerHost, seen?: ReturnType<typeof createSeenStore>);
  /** Destroy + recreate zones and rings for `triggersOf(map)`. Called from buildWorld. */
  build(map: GeneratedMap, styleId: ThemeDefinition['id'], enabled: boolean): void;
  /** Reskin: tooltips only (geometry unchanged). */
  setStyle(styleId: ThemeDefinition['id']): void;
  /** `office.furnitureTriggers`: hides rings and disables zones (`disableInteractive`), live. */
  setEnabled(enabled: boolean): void;
  /** Keep each zone >= the WCAG 2.5.8 target: size * hitScaleFor(min(w,h) * T, zoom), like OfficeScene.ts:730-740. */
  updateHitSizes(zoom: number): void;
  /** 500 ms throttle: first-seen pulse for triggers inside cam.worldView. */
  update(time: number, cam: Phaser.Cameras.Scene2D.Camera): void;
  destroy(): void;
}
```

- One `Zone` per trigger over its footprint, `setDepth(-1)` like the stairs zone (`OfficeScene.ts:641`): input
  depth below every character (depth = y >= 0), above realm zones (-3), so a character in front still wins.
- Hover: a gold (0xf3c94d) rounded-rect ring 1 px outside the footprint at depth 0.5 (above the base texture at
  -10, below every character and room labels at 1) + `host.showTooltip(triggerTooltip(...))`; out: hide.
- Click (`pointerup`): `if (!host.canClick()) return; host.hideTooltip(); host.emit(f.trigger)`. Because the zone
  is a hit object, the scene's `emptyClick` (`OfficeScene.ts:857-863`) does not fire.
- First-seen pulse: the first time a trigger's centre is inside `cam.worldView` and `!seen.has(action)`: three
  ring pulses (scale 1 → 1.25, alpha 1 → 0, 600 ms each), then `seen.mark(action)`. Reduced motion: a static ring
  for 2 s. Not gated by `ambientEffects` (it is a hint, not ambience).

### 4.3 React side (task T4)

- `app/useMenuActions.ts:32`: extract `usePanelActions(): Record<'board'|'log'|'quests'|'roles'|'settings'|'heroes'|'receptionist', { run(): void; disabled: boolean }>`
  (the bodies at `useMenuActions.ts:45-52`); `useMenuActions` composes it. No behaviour change for the menu.
- `features/office/useFurnitureTriggers.ts`: `useFurnitureTriggers(game: OfficeGame | null)` subscribes
  `game.on('furnitureClick', (a) => ...)`: ignore when `isModalOpen()`; every action, `receptionist` included, calls
  `usePanelActions()[a].run()` unless disabled, so the receptionist goes through the same admin `guard()` as the menu
  (a non-admin gets the pairing dialog; Gate 2 security Info2).
- **Keyboard/a11y parity:** every trigger duplicates a menu entry and its hotkey (B/L/Q/S/H/D), shown in the
  tooltip; the canvas adds no focus stops. `docs/guide` says so (gate 2).

---

## 5. G4 Furniture locking

### 5.1 Data

`LayoutRoom.furniture?: PinnedFurniture[]` (shared, already there): interior-relative `x, y`, `w, h <= 8`,
`kind` regex, optional `variant`; max 48 per room; `validateLayout` errors (`pinned-invalid`) on out of
interior, overlap, or covering an explicit door's apron (`layout.ts:392-431`). Reminder: a geometry error makes
`generateMap` fall back to `DEFAULT_LAYOUT` (`generate.ts:172-179`), so the editor must never produce one.

### 5.2 Generation (`procgen/pins.ts` new, `procgen/generate.ts`, `procgen/recipes.ts`; task T5)

```ts
// procgen/pins.ts
/** Whether a kind blocks walking, matching what recipes.ts places it as (block() vs soft()). Exhaustive. */
export const KIND_BLOCKING: Record<FurnitureKind, boolean>;
/** Every kind except 'stairs-up' / 'stairs-down'. */
export function isPinnableKind(kind: string): kind is FurnitureKind;
export interface ResolvedPins { items: (RecipeItem & { pinned: true })[]; issues: LayoutIssue[] }
/** Absolute-coord pins for one room. Skips (with a `pinned-invalid` WARNING) unknown kinds, items outside the
 *  interior, and items overlapping an earlier pin. Covering a door apron is kept but reported `pinned-blocks` (warning). */
export function resolvePins(room: Pick<LayoutRoom, 'id' | 'name' | 'type' | 'furniture'>, interior: Rect, aprons: ReadonlySet<string>): ResolvedPins;

// procgen/recipes.ts
/** The seats a single item of `kind` at `rect` offers inside `interior` (extracted from furnishRoom's per-kind rules:
 *  desks/booths/reading tables sit on the outward row below, else above; tables ring; benches, benches of the lab,
 *  shelves, racks and counters stand below every 2 tiles; console sits left; sofa/armchair sit on themselves). */
export function seatsFor(kind: FurnitureKind, rect: Rect, interior: Rect): RecipeSeat[];
```

Changes in `build()`'s room loop (`generate.ts:509-758`):
1. Before the recipe (`:587`): `const pins = resolvePins(spec, interior, reserved)`; push its issues; put every pin
   into `keptItems` first and its blocking cells into `blocked`; seats from `seatsFor` for each pin are added to the
   recipe seats before the existing filter (`:600-602`).
2. Recipe items colliding with a pinned cell are skipped by the existing `fits` check (`:590-599`) once pinned
   cells (blocking or soft) are in a `pinnedCells` set checked there.
3. The retry (`:651-688`) looks for the last blocking item **without** `pinned`; if only pins remain and the room is
   still not clean, push `{ severity: 'warning', code: 'pinned-blocks', message: '<room>: locked furniture blocks part of the room.', roomIds: [id] }`
   and stop. The global verify (`:785-813`) adds a `pinned-blocks` warning next to `unreachable-room` when the room has pins.
4. Appliances (`:700-731`) already treat `blocked`/`occupiedCells` as taken; pins are in both. `flagAgainstNorthWall`
   (`:726`) runs over `keptItems` including pins.
5. Pins keep their `variant` (default 0) and are emitted with `pinned: true`.
6. Rooms with pins and no recipe (`stairs`, `hall`): pins are ignored for `stairs` (the landing must stay free) and
   placed for `hall` (decor only, no seats).

A layout with no pins must generate byte-identical maps except for section 5.3 (snapshot/parity tests).

### 5.3 Trigger guarantee (`procgen/triggers.ts` new; task T5)

```ts
export interface TriggerPassInput {
  rooms: readonly GeneratedRoom[];          // seats already final for the room loop
  furniture: (RecipeItem & { roomId: string; roomType: RoomType; againstNorthWall?: boolean; pinned?: true; trigger?: FurnitureAction })[]; // mutated: trigger marks + new items
  tiles: readonly TileKind[][];
  apronsByRoom: ReadonlyMap<string, ReadonlySet<string>>;
  tallColumnsByRoom: Map<string, Set<number>>; // mutated: columns of new wall-standing items
  seed: number;
}
export function assignTriggers(input: TriggerPassInput): void;
```

Called once after the room loop, before blocking is applied to `walkable` (`generate.ts:760`), skipped when the
internal `genOpts.triggers === false` (the back-wall parity test passes `{ backWall: false, triggers: false }`).
For each action in `TRIGGER_ORDER`:
1. Existing item of `TRIGGER_KINDS[action]`: pick the one in the entrance, else a lounge, else any room (ties: lowest
   y, then x); set `trigger`. Pins count.
2. Else: place `TRIGGER_PLACE[action]` in the entrance, then each lounge (by id), using the
   `placeAppliances` rules (`backWall.ts:140-150` validity, the component no-split check `:222-237`, front cell
   free): first the interior top row against a north wall (`againstNorthWall: true`, add its columns to
   `tallColumnsByRoom`), then any interior edge cell; w 2 falls back to w 1. Blocking, no seats.
   `rngFor(seed, 'triggers')` only orders equal candidates.
   **Deviation (Gate 2, review L9):** the original design never placed a missing reception desk (`receptionist` had no
   `TRIGGER_PLACE` entry), so floors without a recipe-made desk had no receptionist trigger. The generator now places a
   missing `reception-desk` (w 3, `RECEPTION_PLACE` in `triggers.ts`) in the **entrance room only** (never a lounge), so at
   least 95% of generated floors carry all six triggers (property-tested in `triggers.test.ts`).
3. Nothing fits: no trigger for that action (the menu still works). Never a new issue.

### 5.4 Editor (task T6: `PlanCanvas.tsx`, `Inspector.tsx`, `OfficeEditor.tsx`, `shortcuts.ts`, `stores/editorStore.ts`, `features/editor/pins.ts` new)

- **Tool**: `EditorTool` gains `'furniture'`, shortcut `F` (`shortcuts.ts:76-80`), toolbar button "Furniture".
- **Hit-test** (`pins.ts`): `hitFurnitureAt(map, rooms, tile)` → topmost item under the tile, pinned first; returns
  `{ room, item, pinIndex | null }`. Not pinnable: `stairs-*`, items wider/taller than 8 (cursor `not-allowed`,
  hint "Too large to lock").
- **Drag a generated item** = materialize + move in ONE undo step: `beginGesture()` (`editorStore.ts:395`), then
  `pinDirect(roomId, pinFromPlaced(item, interior))` (direct mutate like `setDoorRect`, `editorStore.ts:331`), then
  `setPinPos` per move (clamped to the interior; a position overlapping another pin is refused, the pin stays at
  its last valid spot), `endGesture()` on pointer up. Dragging a pin is the same without the materialize. Same
  pattern as the door tool's `ensureExplicitDoors` + `move-door` (`PlanCanvas.tsx:526-533`).
- **Click** (no drag) selects the item (`selectedFurniture`). Drawing: generated items as today
  (`PlanCanvas.tsx:238`); pins amber with a padlock badge (the U+1F512 glyph, like the stairs arrows at `:247`) in
  the top-right corner; the selection outlined.
- **Inspector furniture section** (selected item): kind (themed label if any), position and size (interior-relative),
  "Locked" / "Generated"; buttons **Lock in place** (generated) or **Release to procedural** (pinned). Room section:
  "N locked", **Lock all** (every pinnable generated item of the room, deduped, capped at
  `LAYOUT_LIMITS.maxPinnedPerRoom`) and **Release all** (`furniture: undefined`).
- **Keyboard**: arrows nudge the selected pin (one commit, clamped, overlap refused), Delete/Backspace releases it,
  Esc clears the furniture selection.
- **Store API** (`editorStore.ts`):

```ts
export type FurnitureSelection = { roomId: string; pinIndex: number } | { roomId: string; generated: PinnedFurniture };
selectedFurniture: FurnitureSelection | null;
selectFurniture(sel: FurnitureSelection | null): void;
lockFurniture(roomId: string, pin: PinnedFurniture): void;            // commit; no-op if an identical pin exists or the cap is reached
pinDirect(roomId: string, pin: PinnedFurniture): number;              // gesture-only, returns the pin index (existing index if identical)
setPinPos(roomId: string, index: number, pos: { x: number; y: number }): void; // gesture-only
nudgePin(roomId: string, index: number, dx: number, dy: number): void; // commit
releasePin(roomId: string, index: number): void;                       // commit; clears the selection if it pointed at it
lockAll(roomId: string, pins: PinnedFurniture[]): void;                // commit
releaseAll(roomId: string): void;                                      // commit
```

- **Keeping pins valid**: `resizeRoomTo`, `updateRoom` (when `w`/`h`/`walled`/`type` change) and `nudgeSelection`
  never leave an invalid pin: `prunePins(room)` (in `pins.ts`) drops pins outside the new interior or on an
  explicit door apron. Moving and duplicating a room carry pins (they are interior-relative).
  `rerollRoomSeed` (`editorStore.ts:260`) and `resetRoomFurnish` keep pins; "Surprise me" (`replaceDraft`)
  replaces all rooms, so no pins.
- Undo/redo: existing history; tests in `editorStore.test.ts`.

### 5.5 Property tests (task T5, `procgen/__tests__/pins.test.ts`, `triggers.test.ts`)

- For DEFAULT_LAYOUT and 100 `generateRandomLayout` seeds: pin 1-3 random generated items per room (as the editor
  would, via a test-local `pinFromPlaced`), regenerate: every valid pin appears at its absolute position with
  `pinned: true`; the map is valid (no new errors) or reports `pinned-blocks`.
- Reroll (`furnish.seed` change) keeps every pin in place.
- Unknown kind / out of interior pins are skipped with a warning, never thrown, never a fallback to DEFAULT_LAYOUT.
- Triggers: at most one item per action; >= 95% of 200 BSP seeds at the default size have all six actions;
  `triggers: false` vs `true` adds no `unreachable-*` issues.
- `generate.perf.test.ts` budget unchanged with pins on every room of the 128x96 map (`pnpm test:perf`).

---

## 6. PM wiring (after T2 and T4; one edit to `OfficeScene.ts`, one line in `OfficeView.tsx`)

`OfficeScene.ts`:
1. Imports; fields `private drama!: DramaDirector; private triggers!: FurnitureTriggerLayer;`.
2. `create()`: construct both after `this.postFx = ...` (`:357`), before the first `buildWorld` (`:358`). Hosts:
   - drama: `map: () => this.map`, `finder: () => this.finder`, `seats: () => this.seats`, `actors: () => this.characters`,
     `agents: () => this.state?.agents ?? []`, `themeFor: (c) => c.realmIndex !== null && this.multiversePlan ? getTheme(this.multiversePlan.realms.find((r) => r.index === c.realmIndex)?.style ?? MULTIVERSE_THEME_ID) : this.theme`,
     `office: () => this.state?.settings.office`, `floorKey: () => this.floorKey ?? ''`, `reducedMotion: () => this.reducedMotion.value`.
   - triggers: `showTooltip`/`hideTooltip` → the private methods (`:582-590`), `canClick: () => !this.inputLocked && !this.drag?.moved && !this.pinchGuard && !this.arrowPress`,
     `emit: (a) => this.events.emit('furnitureClick', a)`, `reducedMotion` as above.
3. `buildWorld` (`:388-407`): `this.drama.reset()` after `this.seats = new SeatAllocator(...)` (`:397`);
   `this.triggers.build(this.map, style, this.state?.settings.office.furnitureTriggers ?? true)` after `buildStairsInteractive()` (`:399`).
4. `applySkin` (`:426-432`): `this.triggers.setStyle(style)`.
5. `updateZoneHitSizes` (`:730`): `this.triggers.updateHitSizes(zoom)`.
6. `setOfficeState` (`:1021`): `this.triggers.setEnabled(office.furnitureTriggers)` after `applyReceptionistLook()` (`:1046`);
   `this.drama.reset()` first inside the `if (instant)` block (`:1049`); `this.drama.afterCast(Date.now())` after `updateCast` (`:1056`).
7. `refreshLabels` (`:1390-1397`): add `drama: c.hasDramaBubble` to the subject.
8. `update` (`:1514`): `this.drama.update(time, delta)` after the characters loop (`:1536`), `this.triggers.update(time, this.cameras.main)`.
9. SHUTDOWN (`:367-374`): `this.drama.destroy(); this.triggers.destroy();`.

`OfficeView.tsx` (as rewritten by T3): `useFurnitureTriggers(game);` right after `useGameBridge(game);` (`:257`).

Then: root `pnpm typecheck && pnpm test && pnpm build`, `pnpm test:perf`, a `?demo=1` smoke in modern, guild and
Multiverse, commit.

---

## 7. Trade-offs

- **Trigger = a marked item, not "every item of a kind".** Bookcases and boards appear in many rooms; making all of
  them clickable would turn the floor into a minefield of tooltips. One marked item per action keeps the hint
  discoverable and deterministic, at the cost of a procgen pass and two new kinds. The kinds are new (not
  reused `board` variants) so the quest board and the roster read differently from the Kanban board in every style.
- **The director never touches SeatAllocator.** Drama walks are cosmetic: seats stay assigned, so `updateCast`'s
  zone logic is untouched and a cancelled antic simply walks home. The cost is that two antics could aim at the
  same spot if a character is mid-walk through it; `isFree` checks standing characters and director reservations.
- **Strain from existing fields only.** `updatedAt` stands in for "waiting since" and `startedAt` for "quest
  start"; a main session that has run for hours looks tired, which is the point. No server change in Wave 2.
- **HUD replaces the drawer.** The drawer body survives inside the Details dialog, so no information is lost, but
  the map is never covered by a 20rem panel any more. The docked roster column is gone on desktop too; the party
  bar plus the off-canvas chip carry its information.
- **Pins as materialized generated items** (like explicit doors) instead of a palette: the user drags what is
  already there, nothing is invented, and an unknown kind degrades to "skipped" rather than a broken floor.
- **OfficeScene stays out of every task.** Two modules plus a 9-point PM edit cost one sequential step but remove
  the only realistic merge conflict of the wave.

---

## 8. Tasks

Sizing per `packages/agent-templates/skills/task-sizing`. W2-0 first; T1-T6 run in parallel (file-disjoint);
W2-W after T2 and T4 (and T3 for the OfficeView line). Every developer runs the root `pnpm typecheck` and the web
tests before handing off, and does not touch `OfficeScene.ts`, `OfficeView.tsx` (except T3), `CHANGELOG.md`,
`ROADMAP.md` or `docs/`.

| id | role | files owned (write) | depends on | acceptance criteria |
|---|---|---|---|---|
| W2-0 | PM | `packages/shared/src/settings.ts`, `apps/web/src/features/settings/meta.ts`, `apps/web/src/game/procgen/types.ts`, `apps/web/src/game/themes/types.ts`, `apps/web/src/game/themes/index.ts`, `apps/web/src/game/drama.ts` (stub), `apps/web/src/game/OfficeGame.ts`, placeholder lines only in `themes/paint/furniture.ts`, `themes/paint/riftFurniture.ts`, `themes/fx.ts:196`, `actors/Character.ts:301`, `themes/__tests__/{painters,riftPainters}.test.ts` | none | Section 1 pasted verbatim; root `pnpm typecheck` + web tests green; committed before T1-T6 start. |
| T1 | developer (game logic) | `game/drama.ts` (bodies), `game/drama.test.ts` (new), `game/themes/modern.ts`, `game/themes/guild.ts`, `game/themes/rift.ts` | W2-0 | All section 1.4 functions implemented per 2.3-2.4; `strainFor` table-tested (each rule, thresholds at the boundary, priority, disabled, done); pickers deterministic and order-independent, never return an antic whose props are absent; `nextDramaDelayMs` within [0.5, 1.5] x idleChatSec; `StreakTracker` window + reset on toolCount drop. Content of 2.8 present: >= 12 antics per style, both cast sizes, every line <= 48 chars, ids unique, every prop a `FurnitureKind`, 3 lines per strain kind; rift reuses guild's object. |
| T2 | developer (game scene) | `game/actors/Character.ts`, `game/textures.ts`, `game/textures.test.ts`, `game/themes/fx.ts`, `game/labels/types.ts`, `game/labels/priority.ts`, `game/labels/__tests__/priority.test.ts`, `game/dramaSpots.ts` + test (new), `game/scenes/dramaDirector.ts` (new) | W2-0 (codes against the drama.ts signatures; T1 may land later) | Character API of 2.5 incl. the two bubble channels (a re-sent unchanged server bubble does not clear a drama bubble; a changed one does); 12 new bitmaps exist (test over `STRAIN_ICON`/`DIZZY_FRAMES`/`EMOTE_ICON`); `streak` fx; drama tier 3 sorts last (test); `gatherSpots` pure + tested (adjacent, same room, free, deterministic); `DramaDirector` implements 2.3 incl. cancel rules and the flags table, imports no OfficeScene internals. |
| T3 | developer (frontend) | `features/office/OfficeView.tsx`, `features/office/Roster.tsx` (rewrite or delete), `features/office/AgentDrawer.tsx` (→ `AgentDetails`), `features/office/hud/*` (new: `PartyBar.tsx`, `PortraitChip.tsx`, `Portrait.tsx`, `StatusCard.tsx`, `AgentDetailsDialog.tsx`, `hudMath.ts` + test), `features/office/useHiddenAgentIds.ts` (new, moved from Roster.tsx:30), `game/heroPreview.ts` + `heroPreview.test.ts`, `game/camera/insets.ts` + `camera/__tests__/insets.test.ts`, `lib/useMediaQuery.ts` | W2-0 | Section 3: party bar in roster order with portraits matching sprites (`anonymousAppearance` test against the Character hash), status card with name/themed title/status/tool + tool time/quest time/mana meter/XP + Lv/strain sentence/Details/Follow/close; Details = Sheet with focus trap and return; phones: pill → tray, compact card; `[`/`]` cycling + announcement unchanged; insets edge hint tested and wired; `hudMath` tested; no layout shift of the zoom buttons; works at 375x667, 667x375, 1280x800 in `?demo=1`. |
| T4 | developer (game + frontend) | `game/furnitureTriggers.ts` + test (new), `game/scenes/furnitureTriggerLayer.ts` (new), `game/themes/paint/furniture.ts`, `game/themes/paint/riftFurniture.ts`, `game/themes/__tests__/painters.test.ts`, `game/themes/__tests__/riftPainters.test.ts`, `app/useMenuActions.ts`, `features/office/useFurnitureTriggers.ts` + test (new) | W2-0 | Section 4: mapping/labels/tooltips per style (test incl. hotkeys === `MENU_HOTKEYS`); seen store tested with a fake storage; layer per 4.2 (depth, hit sizes, enable toggle, reduced-motion pulse); real art for `notice-board`/`roster-board` in modern, guild, rift within the overdraw cap (painters tests); `usePanelActions` extracted with no menu behaviour change; hook routes all six actions (receptionist direct). |
| T5 | developer (procgen) | `game/procgen/generate.ts`, `game/procgen/recipes.ts`, `game/procgen/pins.ts` (new), `game/procgen/triggers.ts` (new), `game/procgen/backWallSpec.ts`, `game/procgen/__tests__/{pins,triggers}.test.ts` (new), existing `procgen/__tests__/*` and `generate.perf.test.ts` as needed | W2-0 (imports `TRIGGER_*` from T4's `game/furnitureTriggers.ts`: if T4 has not landed, inline the three constants per 4.1 and switch the import at hand-off) | Sections 5.2, 5.3, 5.5: pins placed first, never removed, seats via `seatsFor`, `pinned-blocks`/`pinned-invalid` warnings, no fallback to DEFAULT_LAYOUT for skipped pins; no-pin layouts unchanged apart from triggers; trigger pass per 5.3 with `triggers: false` knob (back-wall parity test updated); property tests and `pnpm test:perf` green. |
| T6 | developer (editor) | `features/editor/PlanCanvas.tsx`, `features/editor/Inspector.tsx`, `features/editor/OfficeEditor.tsx`, `features/editor/shortcuts.ts` + test, `features/editor/pins.ts` + test (new), `stores/editorStore.ts` + `editorStore.test.ts` | W2-0 (works on today's generator: pins already validate; T5 makes them render in place) | Section 5.4: Furniture tool (F), hit-test, drag-to-lock in one undo step, click-select, padlock badge, Inspector furniture + room sections (Lock in place / Release to procedural / Lock all / Release all), arrow nudge, Delete release, resize/type changes prune invalid pins (test), reroll keeps pins (test), undo/redo of every action (tests), a draft never fails `validateLayout` because of pins. |
| W2-W | PM | `game/scenes/OfficeScene.ts`, one line in `features/office/OfficeView.tsx` | T2, T3, T4 (T1, T5 for a meaningful smoke) | Section 6 applied; root typecheck/test/build and `test:perf` green; demo smoke: an idle pair chats in the lounge (modern) and tavern (guild), a long tool shows dizzy, the six triggers open their panels, toggling `office.furnitureTriggers`/`office.drama.enabled` works live. |
| Gate 2 | qa-engineer, code-reviewer, security-engineer, tech-writer (parallel) | qa: tests only; tech-writer: `docs/guide/office.md`, `docs/guide/display.md`, `CHANGELOG.md` | W2-W | Plan's Gate 2: desktop + phone, every style, Multiverse; review; security of the layout-pin limits (48/room, w/h <= 8, kind regex) and the new settings; docs for HUD, menu, triggers, drama settings, the Furniture tool. |

**Hot files and how they are split**
- `OfficeScene.ts`: owned by nobody in the wave; G1 ships `DramaDirector`, G3 ships `FurnitureTriggerLayer`, the PM
  wires both (section 6).
- `OfficeView.tsx`: T3 only; the G3 hook is one PM line.
- `procgen/types.ts`, `themes/types.ts`, `OfficeGame.ts`, `drama.ts` signatures: W2-0 only; T1 then owns `drama.ts` bodies.
- `themes/paint/furniture.ts` / `riftFurniture.ts`: W2-0 adds two placeholder lines each, then T4 owns them.
- `Character.ts`: W2-0 changes one type annotation (`:301`), then T2 owns it.
- `generate.ts`: T5 only (both the pins and the trigger pass, so the editor task never needs it).
