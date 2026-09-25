# M8 design: Living Office (heroes, character reuse, one PM per floor, Multiverse)

Status: proposed, covering ROADMAP 8b, 8c, 8h and 8i. The contract is in `packages/shared/src/heroes.ts` and `multiverse.ts` (both new
and exported from `index.ts`), plus the **Contract patch** in section 2.2, which the PM applies to `settings.ts`, `socket.ts` and `domain.ts`.
Related work: 8a (staleness) is in `modules/{agents,sessions}`, 8d/8e (glow, bubbles) are in `game/{actors,scenes,labels}`, and
8j to 8m are covered in `docs/design/runner-and-helpdesk.md`. When code and doc disagree, the shared contract wins.

User asks: "reuse the long idle characters so no stale character in the canvas", "several PM on one project", "a special
floor called multiverse ... shows all the floors' characters in the same floor ... special style that merges the styles",
"each character can be hand-picked naming and customized".

## 1. Decisions and trade-offs

| # | Decision | Why |
|---|---|---|
| L1 | A **hero** is a persistent identity per `(projectId, role, slot)`, stored on the server (`heroes` table). Agents are *bound* to heroes, and the binding lives on the hero row (`boundAgentId`, `releasedAt`). The `Agent` type does not change. | Heroes must survive restarts and look the same in every browser tab, so the server has to own them. Keeping the binding on the hero avoids touching `agents` (8a is editing it) and `Agent`. |
| L2 | The server does the binding, not the web. The rule is the pure `chooseHeroForAgent` in shared, so the server, the demo mock and tests all use the same code. | "Stable across restarts" needs one authority. With a pure function the rule gets unit tests without a DB. |
| L3 | The **web actor key is the hero id** (`hero:<id>`). An agent without a hero falls back to `agent:<id>`, the anonymous look used today. | This one change is what gives 8c: a new subagent bound to a resting hero reuses that hero's sprite, which walks from the tavern instead of spawning. |
| L4 | Only released heroes are reused. A subagent may also take over the hero of a live subagent that has been `idle` for at least `heroes.reuseIdleAfterSec` (600 s by default). The agent it was taken from stays live but **is not drawn** while it is idle and has no hero. | The user asked for long-idle characters to be reused. An idle agent may still be a background worker, so taking its hero is limited to long idle, and it gets a hero back on its next non-idle event. |
| L5 | 8b uses `office.pmMode: 'single'` (the default) with a **count chip**, not Deputy sprites. In single mode the floor has one Guild Master sprite. Other live sessions are counted on its name tag chip ("+2"), which turns red when one of them needs you. | The complaint was "several PM on one project". Smaller Deputies are still extra PMs cluttering the Guild Master's Hall. A chip keeps every session one click away (popover) with no extra sprites. `per-session` gives back today's behaviour. |
| L6 | The Guild Master has a **fixed identity**: in single mode the GM sprite always wears pm hero slot 0, whichever session is primary. | The floor's leader keeps one name ("Aldric") while sessions come and go. |
| L7 | The **Multiverse replaces "All floors"** and keeps the id `'*'` (`MULTIVERSE_FLOOR_ID`), so the `'*'` subscription, the event log and the roster keep working. Its layout is a normal `OfficeLayout` that the web generates. It fits `LAYOUT_LIMITS`, so `generateMap` and `validateLayout` handle it unchanged. | Procgen, pathfinding, seats and stairs are all reused. The only new render feature is per-region themes. |
| L8 | Themes are composed **per region**: `renderGeneratedMap` takes `regions: {rect, theme}[]`, and a tile, door or furniture item uses the theme of the region that contains it. Everything else (Nexus, void, corridors) uses the new web-only `rift` theme. | Geometry stays independent of style (guild-hall D2). No shared `OfficeStyle` changes are needed, because `rift` cannot be picked by users. |
| L9 | Seats are **scoped to a realm** in the Multiverse. An agent resolves its zone against its realm's room types, and seats are filtered by `roomId`. | `GeneratedMap.zones` merges every room of a type. Without scoping, a qa-engineer from project A could sit in project B's lab. |

## 2. Contract

### 2.1 New files (written)
- `heroes.ts`: `HERO_LIMITS`, `HERO_ID_RE` (`h-` + 8 hex), `HERO_ROLE_RE` (a role or raw agent type, excluding reserved JS keys),
  appearance vocabulary (`HERO_SKIN_TONES`, `HERO_HAIR_COLORS`, `HERO_HAIR_STYLE_COUNT`, `HERO_HATS`, `HERO_PROPS`,
  `HERO_ACCESSORIES`, where `auto` means the theme costume), `HeroAppearanceSchema`, `HeroSchema`/`Hero`, `HeroCreateSchema`, `HeroPatchSchema`
  (`baseUpdatedAt` gives a 409), `HeroUpdateRequestSchema`, `HeroListRequestSchema`, `HeroNamePoolsSchema`, `DEFAULT_HERO_NAME_POOLS`, and the pure
  helpers `heroRoleFor`, `isHeroReleased`, `namePoolFor` (own-property lookup), `fnv1a`, `heroSeed`, `generateHeroAppearance`,
  `pickHeroName` and `chooseHeroForAgent` (+ `BoundAgentState`, `HeroAssignInput`, `HeroAssignment`).
- `multiverse.ts`: `MULTIVERSE_FLOOR_ID = '*'`, `MULTIVERSE_LAYOUT_ID = 'multiverse'`, `MULTIVERSE_THEME_ID = 'rift'`,
  `MULTIVERSE_LIMITS`, `MultiverseProjectInput`, `MultiverseRealm`, `MultiversePlan`.

### 2.2 Contract patch (PM applies it; everything is additive, nothing is renamed)

**`settings.ts`**. Add `import { DEFAULT_HERO_NAME_POOLS, HERO_LIMITS, HeroNamePoolsSchema } from './heroes.js';` and
`import { MULTIVERSE_LIMITS } from './multiverse.js';`. Then:
```ts
// inside `office: z.object({ ... })`, after maxStoredLayouts:
      /** 8b. `single`: one Guild Master per floor (the most recently active session) + a session count chip. */
      pmMode: z.enum(['single', 'per-session']).default('single'),
      /** 8b. Minimum seconds before the Guild Master switches to another session (a session that needs you switches at once). */
      pmSwitchCooldownSec: z.number().min(0).max(600).default(15),
      /** 8c. Seconds a hero with no live agent rests in the tavern before walking out; 0 = leave at once. */
      idleLeaveSec: z.number().min(0).max(86_400).default(300),
      /** 8h. Realms drawn on the Multiverse floor; extra projects are grouped into one "Other realms". */
      multiverseMaxRealms: z.number().int().min(1).max(MULTIVERSE_LIMITS.maxRealms).default(MULTIVERSE_LIMITS.maxRealms),
      /** 8h. Character cap on the Multiverse floor (split fairly across realms; Guild Masters first). */
      multiverseMaxCharacters: z.number().int().min(1).max(MULTIVERSE_LIMITS.maxCharacters).default(60),

// new top-level section, right after `agents`:
  heroes: z
    .object({
      /** Bind agents to persistent named heroes (8i). Off = anonymous characters (pre-M8 look). */
      enabled: z.boolean().default(true),
      maxPerRole: z.number().int().min(1).max(HERO_LIMITS.hardMaxPerRole).default(6),
      maxPerProject: z.number().int().min(1).max(HERO_LIMITS.hardMaxPerProject).default(40),
      /** A new subagent may take over the hero of a subagent idle this long; 0 = never. */
      reuseIdleAfterSec: z.number().min(0).default(600),
      /** Role (or `default`) → names for new heroes. */
      namePools: HeroNamePoolsSchema.default(DEFAULT_HERO_NAME_POOLS),
    })
    .prefault({}),
```
Also change `WHOLESALE_REPLACE_SETTINGS` to `['agents.typeToRole', 'office.zones', 'heroes.namePools']`. None of the new keys are restart-required
or GUI-immutable. Update the `defaultLayoutId` comment to "Layout for floors without their own `layoutId`", since the Multiverse no longer uses it.

**`domain.ts`**. Add `import type { Hero } from './heroes.js';`, then add to `OfficeSnapshot`:
```ts
  /** Heroes of the subscribed floor(s) (M8 8i). Optional so pre-M8 servers and fixtures stay valid. */
  heroes?: Hero[];
```

**`socket.ts`**. Add `import type { Hero, HeroCreate, HeroListRequest, HeroUpdateRequest } from './heroes.js';`, then:
```ts
// ServerToClientEvents (to rooms.all + rooms.project(hero.projectId), like agents)
  'hero:upsert': (h: Hero) => void;
  'hero:remove': (id: string) => void;
// ClientToServerEvents
  'heroes:list': (req: HeroListRequest, ack: Ack<Hero[]>) => void;
  'heroes:create': (req: HeroCreate, ack: Ack<Hero>) => void;
  'heroes:update': (req: HeroUpdateRequest, ack: Ack<Hero>) => void;
  /** Regenerate name (pool) and appearance (seed); clears `customized`. */
  'heroes:reset': (id: string, ack: Ack<Hero>) => void;
  /** Rejected while the hero is bound to a live agent. */
  'heroes:delete': (id: string, ack: Ack<true>) => void;
```
Server bus (`core/event-bus/event-bus.ts`, owned by H1): `'hero.upserted': Hero; 'hero.removed': { id: string; projectId: string }`.

## 3. Heroes (8i)

### 3.1 Data model
`heroes(id TEXT PK, project_id TEXT NOT NULL, role TEXT NOT NULL, slot INTEGER NOT NULL, name TEXT NOT NULL, title TEXT,
appearance TEXT JSON NOT NULL, customized INTEGER NOT NULL, bound_agent_id TEXT, bound_at INTEGER, released_at INTEGER,
created_at INTEGER, updated_at INTEGER)`, with `UNIQUE(project_id, role, slot)` and `INDEX(bound_agent_id)`. Rows are parsed with `HeroSchema`
on read, and invalid rows are skipped with a warning (the same approach as layouts). The display name is `name · (title ?? themed role title)`, e.g.
"Brom · Artificer". A new hero gets `name = pickHeroName(namePoolFor(pools, role), namesOfProjectHeroes, heroSeed(p, role, slot), roleTitle)`
and `appearance = generateHeroAppearance(heroSeed(...))`, so the same slot on the same floor always starts identical, and a reset restores that.

### 3.2 Assignment (server, `heroes.service.ts`)
The service keeps an in-memory `Map<agentId, BoundAgentState>`, seeded at boot from the live agents (read through the cradle's
`agentsRepository` list method, read-only) and kept current from the bus:
- **`agent.upserted`**. Update the state (`live = status !== 'done'`). If the agent is live and has no bound unreleased hero, and it is not
  (`idle` and without a hero, i.e. just taken over), run `chooseHeroForAgent` and apply the result:
  - `keep`: if `releasedAt !== null`, set it back to null (the agent came back after an 8a stale removal).
  - `reuse`: `boundAgentId = agent.id, boundAt = now, releasedAt = null`. If `takenFrom` is set, the old agent simply loses its binding.
  - `create`: insert a new row in the slot.
  - `none`: nothing happens (the web draws the agent anonymously).

  If `status === 'done'` and the bound hero is unreleased, set `releasedAt = now`. Emit `hero.upserted` only when a row changed. The hot path (every tool
  call) is a single map lookup with no DB access.
- **`agent.removed`** (including 8a stale removals). Release the bound hero (`releasedAt = now`) and set `live = false`.
- When `heroes.enabled` is false, do nothing. Existing bindings are left as they are.
- Rules: at most one unreleased hero per agent, and a hero is bound to at most one agent. Main agents map to role `pm`, where **slot 0 is the Guild Master**.
  Main agents never take over idle heroes.

Stable across restarts: bindings are rows, and the boot seed rebuilds liveness. A restart with lost `SubagentStop` events is covered by 8a (stale
agents are removed, which releases their heroes).

### 3.3 Server module `apps/server/src/modules/heroes/` (standard files)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/heroes?projectId=` | | `Hero[]` (by project, role, slot) |
| POST | `/api/heroes` | `HeroCreate` | 201 `Hero` (lowest free slot). 404 for an unknown project, 409 when `maxPerRole` or `maxPerProject` is reached |
| PATCH | `/api/heroes/:id` | `HeroPatch` | `Hero` (`customized = true`). 409 when `baseUpdatedAt` is stale, 404 for an unknown id |
| POST | `/api/heroes/:id/reset` | `{}` | `Hero` with the seeded name and appearance, `customized = false` |
| DELETE | `/api/heroes/:id` | | 204. 409 while bound to a live agent. Emits `hero.removed` |

The socket handlers mirror these (section 2.2) using `ackify`, and payloads are parsed with the shared schemas. `hero.upserted` and `hero.removed` go to
`rooms.all + rooms.project(projectId)`, and `snapshot` includes `heroes` for the subscribed scope. Name pools are ordinary settings
(`PATCH /api/settings {heroes:{namePools}}`, replaced wholesale). Security: the routes go through the existing Origin, Host and JSON-only guards. Names and titles
are stripped of control and bidi characters and length-capped, and are rendered only as text. `:id` must match `HERO_ID_RE`, which is checked before any DB access.
There is no file-system access. Bodies are bounded by the schemas (at most 200 pool names of up to 40 characters per role). The `layouts` service also rejects the reserved id
`multiverse` (a one-line check in H1).

### 3.4 Hero editor (GUI, `features/heroes/`)
- **Entry points**: a TopBar "Heroes" button (hotkey `H`, ignored inside inputs), "Heroes" in the FloorManager row menu, and "Edit hero" in the
  AgentDrawer of a bound agent (it opens the editor on that hero).
- **Layout**: a modal with a floor picker at the top (defaults to the current floor). The left side lists heroes grouped by role, in themed
  role-title order. Each row shows a 32 px sprite preview, the name, the title, a status (*on quest* with the agent's description, *resting*, or *away*)
  and a "customized" dot. "+ Recruit" creates a hero for a chosen role.
- **Edit pane**: name (with a dice button for the next unused pool name), title (placeholder: the themed role title), skin swatches (`HERO_SKIN_TONES`
  plus a custom colour), a hair style stepper (0..6), hair colour swatches (plus custom), outfit colour ("Role colour" toggle or custom), a hat select (Auto
  shows what the theme gives the role), a hat colour, a prop select, an accessory select and an accessory colour. A **live preview** is rendered at
  6x in both styles side by side (guild and modern). It is a 2D canvas painter over the same ASCII bitmaps (see W4), so it needs no Phaser.
- **Actions**: **Randomize** (client-side: seeded from `Date.now()` over the curated palettes. Name, title and costume stay unchanged unless Shift is held),
  **Reset** (`heroes:reset`, with a confirmation), **Save** (Ctrl/Cmd+S; `baseUpdatedAt`, and on a 409 a dialog offers "reload" or "overwrite"), and **Delete**
  (disabled while on a quest, with a tooltip explaining why).
- **Name pools tab**: one textarea per role (one name per line) plus `default`. It shows inline validation (length, max 200, duplicates flagged)
  and saves through `settings:update`.
- Demo mode: `lib/mock.ts` keeps heroes in `localStorage` and binds them with the same `chooseHeroForAgent`.

## 4. Character pool and reuse (8c)

### 4.1 Cast resolver (pure, `apps/web/src/game/cast.ts`)
```ts
export type ActorKey = `hero:${string}` | `agent:${string}` | `gm:${string}`;
export interface CastMember {
  key: ActorKey;
  agent: Agent;                     // the live agent driving this actor
  hero: Hero | null;                // look + name; null = anonymous hash look
  kind: 'guild-master' | 'member';
  /** Single pmMode only, on the Guild Master: other live main sessions on this floor. */
  sessionsChip?: { count: number; attention: boolean; agentIds: string[] };
}
export interface CastInput {
  agents: Agent[]; heroes: Hero[]; sessions: Session[];
  office: Pick<Settings['office'], 'pmMode' | 'pmSwitchCooldownSec'>;
  heroesEnabled: boolean;
  /** Previous primary main agent id per project (hysteresis), owned by the scene. */
  prevPrimary: ReadonlyMap<string, string>;
  now: number;
}
export interface Cast { members: CastMember[]; primary: Map<string, string>; hidden: string[] }
export function resolveCast(input: CastInput): Cast;
```
Rules:
- `heroByAgent`: the hero with `boundAgentId === agent.id` (released or not, so a `done` agent keeps its look).
- A non-main agent with `activity === 'idle'` and no hero is **hidden** (`hidden`, shown in the roster only), provided heroes are enabled.
- A new non-main agent with no hero that is younger than 750 ms is hidden too (the grace window for the `agent:upsert` → `hero:upsert` race), then drawn anonymously.
- Main agents follow section 5. Other agents become `member` with the key `hero:<id>` or `agent:<id>`.
- `visibleAgents` ordering and `maxCharacters` move into the resolver: Guild Masters first, then members that need you (`waiting`/`blocked`),
  then by `startedAt`.

### 4.2 Actor lifecycle (scene, keyed by `ActorKey`)
```
          bind (new key in cast)                  agent done
 (none) ───────────────────────▶ ON_QUEST ───────────────────────▶ RETURNING
   ▲  spawn at entrance/realm gate   ▲  zone changes: walk            wave 1.6s, walk to lounge seat
   │                                 │                                   │ arrive
   │ gone                            │ rebind (key back in cast)         ▼
 LEAVING ◀──── idleLeaveSec ─────── RESTING  (activity idle, lounge seat, name tag dimmed)
   walk to spawn, fade               ▲  key absent from cast (agent removed/stale/hidden)
                                     └── from ON_QUEST: walk to lounge (hero actors only)
```
- A hero actor whose key leaves the cast goes to **RESTING** in the tavern (it walks to a lounge seat and runs the `idle` animation), is drawn at 0.85 alpha,
  and gets the hover text "Resting · Brom". After `office.idleLeaveSec` it goes to **LEAVING** (the existing `leave()` path). With `idleLeaveSec = 0` it leaves immediately.
- When a RESTING or RETURNING hero's key comes back into the cast (a new subagent got this hero), the actor keeps its position and walks to the new
  zone's seat. **No new sprite is created.** The bubble shows the new description once. A LEAVING actor that is rebound turns around (its path
  is replaced) and the fade is cancelled.
- A `done` agent's hero actor goes to the lounge instead of the entrance (it walks out later, after resting). Anonymous `agent:` actors keep
  today's behaviour (a done agent walks to the entrance and a removed one walks out).
- `maxCharacters` counts resting actors. When the cap is exceeded, the resting actor that has rested longest leaves first. It never evicts an ON_QUEST actor.
- Clicking a resting actor opens the hero editor on that hero. Clicking an actor on a quest opens the agent drawer (today's behaviour), using
  `Character.boundAgentId`, which is now mutable.
- `Character` gains `setAppearance(appearance: HeroAppearance | null, roleColor)`: skin, hair style and colour, outfit tint, and explicit
  hat, prop, accessory and colours on top of the theme costume (`auto` keeps the theme value, `none` removes it). A null appearance keeps the hash look.
  The name tag shows `heroName · title`, and the quest description goes to the hover card (8e).

### 4.3 Interplay with 8a staleness
The server removes stale agents (`agent.removed`), and the heroes module releases their heroes, which then rest and leave on the web. Hero rows
are never deleted by the lifecycle. If a stale agent comes back (a later event), the server sees `keep` (still bound) and the actor returns, or it gets a free
hero if its old one was taken. `sessions.pmIdleLeaveSec` (8a) removes idle main agents, and the resolver simply stops considering them for Guild Master.
The result is that the canvas shows only live work plus a few resting heroes for at most `idleLeaveSec`, which answers the "no stale character" ask.

## 5. One PM per floor (8b)
- **`single`** (the default). The candidates are live main agents on the floor (not `done`, not removed, session not `ended`). The primary is chosen in this order:
  (1) a candidate with `status` `waiting` or `blocked`, the most recently updated first; (2) otherwise the most recent `updatedAt`. Hysteresis: the
  previous primary is kept unless it is gone, or the challenger needs you and the primary does not, or the challenger's `updatedAt` is later
  than the primary's by more than `pmSwitchCooldownSec`. The primary is drawn as a single actor with the key `gm:<projectId>`, the look of pm hero slot 0 (or the
  seeded look of slot 0 if the row does not exist yet), and `kind: 'guild-master'`. The other candidates are not drawn. They make up
  `sessionsChip` (`+N`; `attention` if any of them is waiting or blocked). When the primary changes, the GM's bubble shows "Now leading session ab12cd" once
  (theme verb), and the sprite does not move rooms.
- **Chip UX** (Phaser text next to the name tag, 8e keeps it visible even at low LOD when `attention`): clicking it emits
  `scene.events.emit('gmSessions', projectId)`, and React opens a popover that lists the sessions (short id, last prompt, status, age). Clicking a session
  opens the agent drawer for that main agent, and "Pin as Guild Master" sets the web-local `pinnedPrimary[projectId]` until that session ends.
- **`per-session`**: every main agent is a `member` with its own bound pm hero (today's behaviour plus names).
- The AgentDrawer for any main agent shows the floor's GM hero name plus a "session ab12cd" badge. Subagents of every session are drawn
  normally.

## 6. The Multiverse floor (8h)

### 6.1 Realm selection and plan (`apps/web/src/game/multiverse/plan.ts`, pure)
`planMultiverse(projects: MultiverseProjectInput[], opts: { maxRealms; floorOrder; now; idleLeaveSec }): MultiversePlan`
1. **Realms**: non-archived projects with `liveAgents > 0` or `now - lastLiveAt < idleLeaveSec*1000`. The bridge keeps `lastLiveAt` in
   memory, and this hysteresis stops realms from flickering. If more than `maxRealms` qualify, the top `maxRealms - 1` by (`liveAgents` desc,
   `lastActivityAt` desc) get their own realm, and the rest form one **overflow realm** ("Other realms (N)", rift style).
2. **Order**: the chosen realms are sorted by `floorOrder` (the same order as the stairs), so positions stay stable as agents come and go.
3. **Grid**: with up to 8 realms, a 3x3 grid of 30x22 cells (90x66 tiles) with the Nexus in the centre cell. With 9 to 12 realms, a 4x4 grid (120x88) with a 2x2
   Nexus. Realms fill the perimeter cells clockwise starting at the top centre, and unused cells stay void (open starfield). Background `void`,
   `corridorWidth` 2. Procgen carves the rift corridors between neighbouring regions (guild-hall step 6).
4. **Realm template** (a 26x18 block at cell offset (2,2); ids `r<i>-pm|desks|lib|lounge|council`): `pm-office` walled 8x7 at (0,0),
   `desks` open 10x7 at (8,0), `library` walled 8x7 at (18,0), `lounge` open 13x11 at (0,7), `meeting-room` walled 13x11 at (13,7).
   Every zone resolves inside the realm (qa-lab → desks, review-booth → library, whiteboard → meeting-room, …). At 12 realms that is 60 rooms.
5. **Nexus**: `entrance` open 20x12 (the plaza, where the spawn is) and a `stairs` open 4x4 beside it, making 62 rooms or fewer (within the limit of 64). `seed = fnv1a(key)`, and
   `key = realm projectIds joined + '|' + styles`. The acceptance test is `validateLayout(plan.layout)` returning no errors for 0..40 projects.
6. The scene rebuilds only when `plan.key` changes. A realm appearing re-seats characters instantly (the existing rebuild path).

### 6.2 Composing themes (`themes/renderTheme.ts`, `themes/rift.ts`)
- `renderGeneratedMap(scene, map, theme, regions: ThemeRegion[] = [])` with `interface ThemeRegion { rect: Rect; theme: ThemeDefinition }`.
  `themeAt(x,y)` returns the first region whose rect contains the tile, otherwise `theme`. It applies to floor, wall and void tiles, to doors (by door
  tile) and to furniture (by its `(x,y)`). Existing single-theme callers are unchanged.
- `ThemeDefinition.id` widens to `OfficeStyle | typeof MULTIVERSE_THEME_ID`, and `getTheme` accepts `'rift'`. `animate(scene, map, opts)` gains
  `opts.motes?: boolean` (default true) and `opts.budget?: number`. The scene calls each realm theme with a **map slice** (furniture, decor,
  doors and stairs filtered to the realm cell) and `motes: false`, and calls the rift theme once for the whole map with the global motes. The sum is
  capped at `MULTIVERSE_LIMITS.maxAmbientObjects`, with the budget split evenly and the rift theme taking a third.
- **Rift theme recipes** (16 px, Graphics only): the void is deep indigo `0x0b0820` with seeded 1 px stars (roughly 1 per 6 tiles, 3 brightness levels) and
  occasional 2x2 cross stars. **Floating islands**: void tiles that are 1 or 2 rows below a realm cell's bottom-most floor or wall row get a jagged rock
  underside (`0x3a2f4f` fading to `0x1c1630`), so each realm reads as an island. The Nexus floor is hexagonal crystal tiles (`0x2a2350` with cyan
  `0x6ff5ff` edges at 30% alpha). Corridors are **rift bridges**: dark planks with a 1 px glowing violet rail on both edges. Walls are obsidian
  with teal mortar. The entrance is the "Nexus Gate" (a rune ring) and the stairs are "Rift Stairs" (the guild portal art in cyan and magenta).
  Animated: 2 or 3 **aurora ribbons** (additive, wide low-alpha sine strips drifting across the void, alpha 0.08 by day and 0.18 at night), star
  twinkle on at most 40 stars, and slow island bobbing is **off** (geometry must stay put). With `ambientEffects` off or reduced motion there are no tweens.
  Names: `zoneNames` and `roomNames` read "Nexus …", `floorLabel` returns "The Multiverse", and role titles and costumes come from the guild theme.
- The overflow realm is painted by rift with a "∞" banner.

### 6.3 Characters, interaction, stairs
- Each character appears **in its project's realm**. The cast is resolved per project (so there is one Guild Master per realm in single mode). Seats come from
  `seats.assign(key, zone, scope)` with `scope = { roomIds, types, gate }` for the realm, zone resolution uses `resolveZone(zone, realm types)`,
  and `entrance` maps to the realm **gate**, the realm floor tile nearest the Nexus that is reachable from the spawn. New characters walk in from the Nexus
  spawn through the rift bridge. Resting heroes rest in their realm's lounge.
- **Cap**: `office.multiverseMaxCharacters`, shared fairly (each realm gets `floor(cap/realms)`, and the leftover goes round-robin to realms in need, GMs first).
  A realm's banner shows "+N" for characters that were not drawn.
- **Realm banner** (above the block): the project name, "Floor N", live and waiting counts, and a red pip if anything is waiting. It is drawn as Phaser text and
  hidden at the lowest LOD except for the pip. Room labels are hidden on this floor.
- **Travel**: a realm has an interactive zone over its cell, which sits below the characters (characters win the hit test). Hovering shows an outline glow in the realm's
  theme accent plus the tooltip "Travel to Floor 3 · api-server". A click emits `scene.events.emit('realmClick', projectId)`, and `OfficeView` runs the normal floor
  transition to that floor. Clicking the overflow realm opens the floor picker. Keyboard: `Tab` cycles realms when no character is focused (8f), and `Enter` travels.
- **Stairs**: the top floor's *up* stairs lead to the Multiverse (`above = { id: '*', label: 'The Multiverse' }`). On the Multiverse,
  `floor = { index: count, count: count + 1, below: topFloor }`, *down* goes to the top floor, and *up* is disabled. PageUp on the top floor goes to the Multiverse,
  while End goes to the top project floor. The floor picker lists "The Multiverse" first, with an "∞" icon.
- **Performance**: one base texture of at most 1920x1408 px (a 120x88 grid), procgen under 50 ms (the existing perf test adds a 12-realm plan case), no per-frame
  work per realm, and realm hit zones are static rects.

## 7. Web-internal contracts (created first by the task that owns the file)
- `OfficeState` (W7a) gains `heroes: Hero[]`, `sessions: Session[]`, `multiverse: MultiversePlan | null` (null on project floors) and
  `pinnedPrimary: Record<string, string>`. `floorKey` stays. On the Multiverse, `layout = plan.layout` and `style` is the rift style.
- `SeatAllocator.assign(key: string, zone: Zone, scope?: SeatScope)` with `SeatScope { roomIds: ReadonlySet<string>; types: ReadonlySet<RoomType>; gate: Point }` (W7a).
- `heroStore` (W2): `heroes: Record<string, Hero>`, `upsert`, `remove`, `replaceAll(projectScope, list)`, and a selector `heroesForProject(id)`.
- `heroLook.ts` (W4): `resolveHeroCostume(themeCostume: Costume, a: HeroAppearance, roleColor: number): { costume: Costume; skin: number; hair: number; hairStyle: number; outfit: number }`.

## 8. Work breakdown
Wave 0: the PM applies section 2.2 and runs `pnpm typecheck`. The waves below are file-disjoint. W7a and W7b wait for 8d and 8e to land, because they share
`Character.ts` and `OfficeScene.ts`.

**H1. Server heroes module** [developer: server]. Depends on wave 0 and 8a merged (it reads live agents).
Owns: `apps/server/src/modules/heroes/**` (new), `core/db/{schema,migrations}.ts` (the `heroes` table), `core/event-bus/event-bus.ts` (2 events),
`core/realtime/index.ts` (2 broadcasts), `core/di/index.ts`, `app.ts` (register after `agents`), `modules/snapshot/**` (`heroes`),
`modules/layouts/layouts.service.ts` (reserve the `multiverse` id), `core/http/__tests__/security.test.ts` (hero routes), and `config/office.yaml` (document the new keys).
Coordinate `app.ts`, `realtime` and `event-bus` with the runner architect's tasks: the PM serialises these merges.
Acceptance criteria:
- CRUD works over REST and socket as specified in section 3.3, including 409s (cap, stale `baseUpdatedAt`, delete while bound) and 404s.
- A subagent gets a named hero on its first live upsert. The same agent id keeps it across a server restart.
- A second subagent of the same role after the first finished reuses the first hero. A long-idle agent's hero is taken over only after `reuseIdleAfterSec`.
- The main agent gets pm slot 0 when it is free. Stale removal (8a) releases the hero.
- No DB write happens on upserts that change nothing.
- The snapshot contains `heroes`.

Tests: unit tests for `chooseHeroForAgent`, covering the table of cases (keep, keep-after-release, reuse order, GM slot 0, takeover cutoff, caps, slot gaps). Tests for `pickHeroName`
(pool order, case-insensitivity, roman suffixes, fallback, the 40-character clip). Service tests with a fake bus replaying `apps/server/test/fixtures` (parallel subagents),
a restart test on the same DB file, route and socket tests, a migration test on a pre-M8 DB, and security tests (foreign Origin on POST, PATCH and DELETE gives 403, and a bad id gives 400).

**W2. Web hero data layer + settings meta** [developer: web A]. Depends on wave 0.
Owns: `apps/web/src/stores/heroStore.ts` (+ test), `apps/web/src/lib/{api,socket,mock}.ts` (hero calls and events, demo binding), `apps/web/src/features/settings/meta.ts`
(the `heroes` section label, hints and enum options for `office.pmMode`, and hiding `heroes.namePools` in the generic form, because it has its own editor).
Acceptance criteria: the snapshot and upsert/remove events keep the store in sync (also on `'*'`), and demo mode binds heroes with the shared rule and persists them in `localStorage`.

**W3. Cast resolver (8b + 8c logic)** [developer: web B]. Depends on wave 0 only.
Owns: `apps/web/src/game/cast.ts`, `apps/web/src/game/cast.test.ts`.
Acceptance criteria: everything in section 4.1 and section 5 is covered by pure tests: primary selection with the waiting preemption and hysteresis, the chip count and attention,
per-session mode, hidden idle unbound agents, the 750 ms grace window, and the cap ordering.

**W4. Hero look + preview painter** [developer: web C]. Depends on wave 0.
Owns: `apps/web/src/game/textures.ts` (export the bitmap data and palettes; the values stay equal to `HERO_*`), `apps/web/src/game/themes/costumes.ts`
(export the bitmap data), `apps/web/src/game/heroLook.ts` (+ test), `apps/web/src/game/heroPreview.ts` (a 2D-canvas painter over the same bitmaps, + test).
Acceptance criteria: the web palettes match `HERO_SKIN_TONES` and `HERO_HAIR_COLORS` (test), `auto` and `none` semantics are handled per field, and the preview draws every hat, prop and accessory
without throwing (stub canvas).

**W5. Hero editor UI** [developer: web D]. Depends on W2 and W4.
Owns: `apps/web/src/features/heroes/**` (new: `HeroPanel.tsx`, `HeroEditor.tsx`, `HeroList.tsx`, `NamePoolEditor.tsx`, `HeroPreview.tsx`),
`apps/web/src/app/TopBar.tsx` (the Heroes button and the `H` hotkey), `apps/web/src/features/office/AgentDrawer.tsx` (Edit hero, session badge).
Acceptance criteria: the section 3.4 flows work against the server and in demo mode (edit, randomize, reset, save with a 409 dialog, recruit, delete disabled while on a quest, name pools),
and it is fully keyboard operable, with labelled controls.

**W6. Multiverse plan + rift theme + region rendering** [developer: web E]. Depends on wave 0.
Owns: `apps/web/src/game/multiverse/**` (new: `plan.ts` and tests), `apps/web/src/game/themes/{rift.ts,renderTheme.ts,types.ts,index.ts}`,
`apps/web/src/game/themes/paint/rift*.ts`, `apps/web/src/game/themes/__tests__/rift*.test.ts`, `apps/web/src/game/procgen/__tests__/perf.test.ts` (add the plan case).
Acceptance criteria:
- `planMultiverse` meets the section 6.1 criteria: no validate errors and every realm seat reachable for 0..40 projects; the 12-realm cap and the overflow realm; a stable key and positions under agent churn.
- The region override paints each realm with its own style, and the rest with rift.
- `ambientEffects: false` creates no tweens, and the ambient budget is respected.

**W7a. Scene integration** [developer: web F]. Depends on W3, W4, W6 and 8d/8e merged.
Owns: `apps/web/src/game/scenes/OfficeScene.ts`, `apps/web/src/game/actors/Character.ts`, `apps/web/src/game/seats.ts` (+ test), `apps/web/src/game/OfficeGame.ts`.
Acceptance criteria:
- The actor lifecycle in section 4.2: a reuse walks from the tavern with no new sprite, resting actors leave after `idleLeaveSec`, and a rebind cancels leaving.
- A single Guild Master with the chip, and the `gmSessions` event.
- Realm-scoped seats, realm hit zones with `realmClick`, and the stairs to and from the Multiverse.
- The hero appearance is applied, and switching styles does not move actors.

**W7b. React bridge + floors** [developer: web G]. Depends on W2 and W6, and runs in parallel with W7a against the section 7 `OfficeState`.
Owns: `apps/web/src/features/office/{OfficeView,FloorManager,Roster}.tsx`, the new `apps/web/src/features/office/GmSessionsPopover.tsx`,
`apps/web/src/lib/floors.ts` (+ test), `apps/web/src/stores/officeStore.ts` (+ test; `ALL_FLOORS` is kept as an alias of `MULTIVERSE_FLOOR_ID`).
Acceptance criteria:
- The Multiverse replaces "All floors" in the TopBar and the picker, and `floorsInOrder` and the neighbours include it above the top floor.
- `lastLiveAt` tracking feeds `planMultiverse`, and a realm click travels with the transition.
- The GM popover lists sessions and can pin one.
- The roster marks hidden (idle, unbound) agents as "off canvas".

**Q. Review, security and QA** (8g), run in parallel: the hero routes security review; a manual QA script covering a 3-floor demo, the Multiverse with 1, 5, 12 and 15 projects,
both styles, reduced motion, a replay of 20 sequential subagents of one role showing at most `maxPerRole` distinct heroes and 0 permanently idle sprites after
`staleAfterSec + idleLeaveSec`, and 2 parallel sessions on one floor showing one Guild Master with "+1".

## 9. Risks and open points
- **Bind race**: `agent:upsert` arrives before `hero:upsert`. It is mitigated by the 750 ms grace window. The alternative (an `Agent.heroId` set by the agents module)
  was rejected so that 8a can proceed untouched, but it can be revisited after M8.
- **Taking over an idle hero** can swap a background agent's identity when it resumes. This is bounded by `reuseIdleAfterSec` (600 s) and can be disabled by setting it to 0.
- **The 64-room limit** caps realms at 12 with 5 rooms each. A richer realm template needs fewer realms, or a `LAYOUT_LIMITS` bump (a contract change).
- **Rebuilds on realm set changes** teleport characters in the Multiverse. This is acceptable because realms change rarely, thanks to the `idleLeaveSec` hysteresis.
- 8j profiles can export heroes by `(role, slot, name, title, appearance)`. Hero ids are host-local and are not exported.
