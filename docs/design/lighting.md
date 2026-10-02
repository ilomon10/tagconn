# Light and time: host clock, sun cycle, lightmap and shadows (M16 → v0.10.0)

Status: approved for implementation · Plan: `~/.claude-sessions/profiles/ilomon/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md`
sections "15.1 Host-time sun cycle" and "15.2 Lightmap with occlusion and shadows" (renumbered M16) · ADR #30.
Sibling doc: `docs/design/furnishing.md` (15.3 harmony, 15.4 editor, M15 W4 carry-over). **The combined M16 wave plan
for both docs is §8 of this file.**
Scope: `packages/shared` (`HostClock` in the snapshot, `office.lighting.*`), one server line (`snapshot.service.ts`),
`apps/web/src/game/lighting/` (new, pure modules + three Phaser layers), `postfx/lights.ts` (`kind`), `procgen/roomLights.ts`
(new) + one call in `generate.ts`, theme `lighting` blocks, the HUD ☰ time row, `Character.ts` (cast shadow API).

Read first: `docs/design/back-wall.md` §1 (depth invariant: base texture at -10, characters at `depth = y`),
`docs/design/dual-grid.md` §2.2 (pass order of the base texture), `docs/design/navigation.md` §2 (`NavGrid`, `KIND_SHAPE`),
`docs/decisions.md` #22 (all art code-drawn), #25 (per-browser display preferences), #29 (half tile, D2).

---

## 0. Goals, non-goals, invariants

**Goals.** The office follows the *host's* clock (not the browser's): dawn and dusk ramp smoothly instead of the hard
19:00/07:00 switch in `OfficeScene.applyLighting`. Night is no longer a flat 42-55 % blue rectangle: rooms are lit by
their own lights, light stops at walls, windows throw sun shafts that move with the hour, furniture and characters cast
shadows. A ☰ slider lets any viewer scrub the time of day for themselves.

**Non-goals (M16).** Y-sorted furniture sprites and see-through walls (M17; the height table built here feeds M17's
height map), a server-side astronomy model (the sun is stylised, §2.2), per-pixel normal maps, shadows cast *by*
characters onto walls, lights that move (the Receptionist's candle stays where it is).

**Invariants.**
1. **One overlay, same depth.** The lightmap `RenderTexture` sits at `LIGHTMAP_DEPTH = 90_000` with `MULTIPLY` blend,
   exactly where today's night rectangle is, so everything that already sorts above it (bloom `LightLayer` 95_000,
   tooltip 200_000) and below it (world, characters, labels) is unchanged. The night rectangle is removed, not kept beside it.
2. **D2 holds.** Occluders, light positions, shaft geometry and shadow geometry read `GeneratedMap` geometry and the
   style-independent `KIND_HEIGHT` table only. A style contributes colours (`theme.lighting`) and nothing else; a skin
   switch never moves a shadow.
3. **Pure plans, thin Phaser.** Everything that decides *what* to draw (`sun.ts`, `occluders.ts`, `visibility.ts`,
   `plan.ts`, `shadows.ts`, `fallback.ts`) is pure TS with tests; `LightmapLayer`/`ShadowLayer` only draw a plan.
4. **Determinism.** A plan is a pure function of `(map, style, sun step, settings)`. No `Math.random`, no `Date` inside
   `game/lighting/` except through the injected clock (`HostClock` + skew). Two bakes of the same inputs are identical.
5. **Per-frame budget ≤ 1 ms on `high`.** The lightmap is baked only when the sun *step* changes
   (`office.lighting.sunStepMinutes`, default 15 game minutes), a light changes, or the map/skin/settings change.
   A frame does only: the step check, the ambient tint uniform and the character cast shadows (§4.3). Measured in
   `lighting.perf.test.ts` (`*.perf.test.ts`, so `pnpm test:perf`).
6. **Fallback = today's overlay, driven by the sun.** On the canvas renderer, with
   `office.lighting.lightmap = false`, or when the GPU texture limit is exceeded, the scene keeps one flat tinted rectangle whose alpha is
   `theme.lighting.nightAlpha * (1 - sun.ambient)` (§2.4). Nothing in this milestone makes a floor darker than today's
   night on that path. (As landed: `low` quality keeps the lightmap at quarter resolution with fewer bands, no shafts
   and blob shadows; see `resolveLightingMode`.)
7. **`office.theme` keeps working.** `day` / `night` / `auto` map onto the new settings (§1.3): `auto` = the configured
   cycle (default `host-clock`), `day` = fixed 13:00, `night` = fixed 01:00. A per-browser ☰ override wins over both.
8. **Hot files are PM-only.** `OfficeScene.ts`, `OfficeView.tsx`, `OfficeGame.ts` are wired by the PM in Wave 3 (§7).
   `renderTheme.ts` and `themes/paint/furniture.ts` / `riftFurniture.ts` are not edited by any lighting task (§8).

---

## 1. Contract (W0)

### 1.1 Host clock (`packages/shared/src/domain.ts`, server, demo)

```ts
/** M16: the server's wall clock at snapshot time, so every browser renders the HOST's day, not its own. */
export interface HostClock {
  /** `Date.now()` on the server when the snapshot was built (epoch ms, UTC). */
  serverNow: number;
  /** Minutes EAST of UTC for the server's local zone at `serverNow` (DST-correct): `-new Date(serverNow).getTimezoneOffset()`.
   *  Jakarta = 420, New York in summer = -240, UTC = 0. */
  tzOffsetMin: number;
  /** IANA zone name when the host knows it (`process.env.TZ` or `Intl.DateTimeFormat().resolvedOptions().timeZone`), for the HUD. */
  tz?: string;
}
export interface OfficeSnapshot {
  /* ...existing... */
  /** M16: host clock (optional so pre-M16 servers and fixtures stay valid; the client falls back to its own clock). */
  clock?: HostClock;
}
```

There is no `hello` event: the only snapshot delivery is the ack of `office:subscribe` (`lib/connection.ts:40-86`), which
also runs on every reconnect, so the skew is re-measured on every resync. `snapshot.service.ts#build(projectId, now)`
adds `clock: { serverNow: now, tzOffsetMin: -new Date(now).getTimezoneOffset(), tz }` (S1). `GET /api/snapshot` carries
it too (same builder). `lib/mock.ts` (demo) fills `clock` from the browser so `?demo=1` behaves like a local host.

**Docker / TZ.** Inside the container `TZ` is unset, so `tzOffsetMin` is 0 and the office would follow UTC. The compose
file passes it through (`environment: TZ: ${TZ:-UTC}`; `.env.example` documents `TZ=Asia/Jakarta`), and the user guide
(`docs/guide/display.md`, `docs/guide/configuration.md`) says: "Docker: set `TZ` in `.env` or the office runs on UTC".
`node:24.21.0-bookworm-slim` ships `tzdata`; the gate verifies `tzOffsetMin` from a throwaway container with
`TZ=Asia/Jakarta` (never the live stack). Desktop (native services) inherits the host zone and needs nothing.

### 1.2 Settings (`packages/shared/src/settings.ts`, inside `office`)

```ts
/** M16: host-time sun cycle and the lightmap (docs/design/lighting.md). */
lighting: z
  .object({
    /** `host-clock`: the server's local time. `fixed`: always `fixedHour`. `accelerated`: a full day every `cycleMinutes` real minutes. */
    cycle: z.enum(['host-clock', 'fixed', 'accelerated']).default('host-clock'),
    /** Decimal hour (14.5 = 14:30) used by `fixed`, and the starting hour of `accelerated`. */
    fixedHour: z.number().min(0).max(24).default(14),
    /** Real minutes per 24-hour cycle in `accelerated` mode. */
    cycleMinutes: z.number().min(1).max(1440).default(24),
    /** Sunrise / sunset centre hours and the length of each twilight ramp (hours). Stylised, not astronomical. */
    dawnHour: z.number().min(0).max(12).default(6.5),
    duskHour: z.number().min(12).max(24).default(18.5),
    twilightHours: z.number().min(0.25).max(4).default(1.5),
    /** Ambient brightness at deep night (0 = pitch black, 1 = no night). The old overlay alpha scales with `1 - ambient`. */
    nightAmbient: z.number().min(0).max(1).default(0.35),
    /** Multiplies every light's reach (room lights, lamps, torches, windows). */
    lightScale: z.number().min(0.25).max(3).default(1),
    /** `off` = none; `blob` = the static ellipse under characters only; `cast` = skewed furniture + character shadows from the dominant light. */
    shadows: z.enum(['off', 'blob', 'cast']).default('cast'),
    /** The occluded lightmap (WebGL, `high` quality). Off = the flat sun-driven overlay of M8. */
    lightmap: z.boolean().default(true),
    /** Lightmap resolution as a fraction of the world: `half` (1/2) on high quality; `quarter` is used on low automatically. */
    resolution: z.enum(['half', 'quarter']).default('half'),
    /** Game minutes between sun updates (lightmap and shadow re-bakes). */
    sunStepMinutes: z.number().int().min(1).max(120).default(15),
    /** Sun shafts (moonlight at night) on the floor in front of windows. */
    windowShafts: z.boolean().default(true),
  })
  .prefault({}),
```

`features/settings/meta.ts`: `ENUM_OPTIONS['office.lighting.cycle'/'shadows'/'resolution']` and a `KEY_HINTS` line per key
(the doc comments above, shortened). `office.theme`'s hint becomes "Day / night override; `auto` follows
`office.lighting.cycle`". Not restart-required, not GUI-immutable, no arrays (deep-merge patches work). `config/office.yaml`
gets the commented example block. Run the ROOT `pnpm typecheck` after the change (CLAUDE.md).

### 1.3 Mode resolution (pure, `game/lighting/clock.ts`)

```ts
export type LightingSettings = Settings['office']['lighting'];
export type ThemeMode = Settings['office']['theme'];
/** The ☰ per-browser override (displayPrefsStore, ADR #25 pattern): `null` = follow the server. */
export interface LightingOverride { hour: number }
export interface ResolvedCycle { cycle: 'host-clock' | 'fixed' | 'accelerated'; fixedHour: number; cycleMinutes: number; source: 'override' | 'theme' | 'settings' }
/**
 * Precedence: override (hour slider) → `office.theme` day/night (fixed 13:00 / 01:00) → `office.lighting`.
 * `office.theme = 'auto'` is a no-op here (the settings decide), which is exactly today's `auto`.
 */
export function resolveCycle(theme: ThemeMode, lighting: LightingSettings, override: LightingOverride | null): ResolvedCycle;
```

### 1.4 Clock sync (`game/lighting/clock.ts`)

```ts
export interface ClockSync { skewMs: number; tzOffsetMin: number; tz?: string; measuredAt: number }
/** One-shot sync from a snapshot: `sentAt`/`receivedAt` are the browser's `Date.now()` around the `office:subscribe` ack;
 *  skew = serverNow - midpoint. A missing `clock` yields skew 0 and the browser's own zone (pre-M16 server, demo). */
export function syncClock(clock: HostClock | undefined, sentAt: number, receivedAt: number, browserTzOffsetMin = -new Date().getTimezoneOffset()): ClockSync;
/** Host epoch ms now. */
export const hostNow = (sync: ClockSync, now = Date.now()): number => now + sync.skewMs;
/** Host local decimal hour in [0, 24): `((hostNow + tzOffsetMin * 60_000) % 86_400_000) / 3_600_000`, via UTC fields so the browser zone never leaks in. */
export function hostLocalHour(sync: ClockSync, now = Date.now()): number;
/** The hour the sun uses: `host-clock` → hostLocalHour; `fixed` → fixedHour; `accelerated` → (fixedHour + 24 * elapsedMin / cycleMinutes) mod 24, elapsed since `epochMs`. */
export function cycleHour(cycle: ResolvedCycle, sync: ClockSync, now: number, epochMs: number): number;
/** Integer step index `floor(hour * 60 / stepMinutes)`; the lightmap re-bakes when it changes. */
export const sunStep = (hour: number, stepMinutes: number): number => Math.floor((hour * 60) / stepMinutes);
```

Skew handling: the midpoint estimate absorbs the RTT; a browser whose clock is minutes off still renders the host's hour
because every read goes through `hostNow`. A sleep/resume jumps both wall clocks equally. Reconnects re-measure
(`resync()` runs `office:subscribe` again). `lib/connection.ts` records `sentAt` before `emitWithAck('office:subscribe')`
and `receivedAt` in the ack, and stores `ClockSync` in `officeStore` (`clockSync: ClockSync`) through
`reducers.applySnapshot` (+ a `syncClock` call in `connection.ts`), from where `OfficeView`'s bridge passes it to the scene.

### 1.5 `OfficeState` (PM, `OfficeScene.ts`)

```ts
export interface OfficeState {
  /* ...existing... */
  /** M16: host clock sync (skew + zone) from the last snapshot; undefined on pre-M16 servers (browser clock). */
  clock?: ClockSync;
  /** M16: this browser's ☰ time-of-day override (ADR #25 pattern), undefined = follow the server. */
  lightingOverride?: LightingOverride;
}
```

### 1.6 Theme colours (`themes/types.ts`, all new fields optional; defaults in `lighting/palette.ts`)

```ts
lighting: {
  dayTint: number; nightTint: number; nightAlpha: number; glowAtNight: boolean;   // existing; nightAlpha = the fallback overlay's max alpha
  /** M16 (docs/design/lighting.md §2.2). Omitted fields fall back to LIGHTING_DEFAULTS[theme.id]. */
  dawnTint?: number;     // sky colour blended into the ambient at dawn (modern 0xffd9b0, guild 0xffc890, rift 0xd0b0ff)
  duskTint?: number;     // (modern 0xffb080, guild 0xff9a60, rift 0xb080ff)
  moonTint?: number;     // night ambient colour (modern 0x3a4a80, guild 0x4a3a80, rift 0x30206a)
  sunColor?: number;     // window shaft colour by day   (modern 0xfff2c8, guild 0xffd89a, rift 0xa8f0ff)
  moonColor?: number;    // window shaft colour by night (modern 0x9ab0ff, guild 0xa090ff, rift 0x7ef0e8)
  roomLight?: number;    // the procgen ceiling light's colour (modern 0xfff4dc cool-white, guild 0xffb060 chandelier amber, rift 0x9fd8ff)
  shadowAlpha?: number;  // 0..1 darkness of cast shadows (modern 0.22, guild 0.28, rift 0.2)
};
```

### 1.7 Procgen room lights (`procgen/types.ts`, `procgen/roomLights.ts`, `generate.ts`)

```ts
/** M16: a style-independent ceiling light guaranteed per room (about one per `ROOM_LIGHT_TILES` tiles). No footprint, never blocks. */
export interface RoomLight extends Point {       // tile centre coordinates (integers; `x + 0.5` is the px centre)
  roomId: string;
  /** Reach in tiles before `lightScale`: `clamp(2.5, sqrt(area / count) * 0.9, 5)`. */
  reachTiles: number;
}
export interface GeneratedMap { /* ...existing... */ lights: RoomLight[]; }
```

```ts
// procgen/roomLights.ts (pure; L3)
export const ROOM_LIGHT_TILES = 24;
/** One light per ceil(area / ROOM_LIGHT_TILES), laid out on a k x m grid that best matches the interior's aspect, each at the
 *  centre of its grid cell; `stairs` rooms get one, `hall` rooms one per 48 tiles. Deterministic (no rand). */
export function planRoomLights(rooms: readonly Pick<GeneratedRoom, 'id' | 'type' | 'interior'>[]): RoomLight[];
```

`generate.ts` emits `lights: planRoomLights(generatedRooms)` right before the public map is assembled (after step 13;
reads `interior` only, so it cannot disturb any existing stream or parity test). The Multiverse `sliceMapForRect`
(`game/multiverse/`) copies `lights` like `decor` (the slice helper filters by rect; one line, L3).

### 1.8 Light sources (`postfx/types.ts`, `postfx/lights.ts`, `lighting/sources.ts`)

```ts
// postfx/types.ts
export type LightSourceKind = 'wall' | 'window' | 'point' | 'tiny' | 'ambient-fill';
export interface LightSource { /* ...existing... */ kind: LightSourceKind; }
```

`extractLightSources` sets `kind` on every entry it already emits (`wall` for `wall-light` slots, `window`, `point` for
lamp/console/equipment/fireplace, `tiny`) and is otherwise unchanged: the bloom list, its order and its cap stay as
they are (ambient-fill lights have no fixture to glow, so they never get a bloom sprite). The lightmap builds its own
list:

```ts
// lighting/sources.ts (pure; L2)
export interface LightmapLight {
  x: number; y: number;               // world px
  kind: LightSourceKind;
  color: number;
  /** Full reach in world px (already scaled by `lightScale`): room lights `reachTiles * T`, wall lights 4 T, lamps 3 T, fireplace 5 T, windows 3 T, tiny 1 T. */
  reach: number;
  /** 0..1 at full night; `intensityAt(sun)` fades electric lights by day (`1 - 0.85 * sun.daylight`) and keeps windows (`sun.daylight`, moonlight `0.25 * sun.moon`). */
  strength: number;
  flicker: boolean;
  roomId: string | null;
}
export function lightmapSources(map: GeneratedMap, style: OfficeStyle | typeof MULTIVERSE_THEME_ID, regionThemeAt: (x: number, y: number) => ThemeDefinition, lightScale: number): LightmapLight[];
```

Order: room lights first (they shape the rooms), then `extractLightSources(map, style, -1)` mapped 1:1 (uncapped; the
lightmap has its own cap `LIGHTMAP_MAX_LIGHTS = { high: 320, low: 96 }`, truncating from the end, so room lights are never
the ones dropped).

---

## 2. Pure modules (`apps/web/src/game/lighting/`, no Phaser)

### 2.1 Files

| file | task | exports |
|---|---|---|
| `types.ts` | W0 | `SunState`, `Segment`, `Polygon`, `LightmapPlan`, `ShadowQuad`, `ShaftQuad`, `CastShadow`, `LightingQuality` (type-only) |
| `clock.ts` | L1 | §1.3-1.4 |
| `sun.ts` | L1 | §2.2 |
| `fallback.ts` | L1 | §2.4 |
| `palette.ts` | L1 | `LIGHTING_DEFAULTS` per theme id + `lightingColours(theme)` (fills the optional fields) |
| `heights.ts` | L2 | `KIND_HEIGHT`, `OCCLUDER_MIN_HEIGHT_PX`, `WALL_HEIGHT_PX` |
| `occluders.ts` | L2 | §2.3 |
| `visibility.ts` | L2 | §2.3 |
| `sources.ts` | L2 | §1.8 |
| `plan.ts` | L2 | §2.5 |
| `shadows.ts` | L2 | §2.6 |
| `index.ts` | W0 | re-exports |

### 2.2 Sun (`sun.ts`)

```ts
export type SunPhase = 'night' | 'dawn' | 'day' | 'dusk';
export interface SunParams { dawnHour: number; duskHour: number; twilightHours: number; nightAmbient: number }
export interface SunState {
  hour: number;              // decimal, [0, 24)
  phase: SunPhase;
  /** 0 at night, 1 in full day; smoothstep ramps `twilightHours` wide centred on dawn/dusk. */
  daylight: number;
  /** 0..1: sin of the day fraction (0 at dawn/dusk centres, 1 at solar noon); 0 at night. */
  elevation: number;
  /** -1 (morning, sun east) .. +1 (evening, sun west); 0 at noon. Shafts and day shadows lean by `-skew`. */
  skew: number;
  /** 0..1 moonlight: `1 - daylight`, times a slow 29.5-day phase factor in [0.4, 1] from the host date (`moonPhase(dayIndex)`). */
  moon: number;
  /** Ambient brightness for the lightmap fill: `nightAmbient + (1 - nightAmbient) * daylight`. */
  ambient: number;
  /** Ambient colour: mix(moonTint, white, daylight) warmed by dawnTint/duskTint inside the ramps (strength = 1 - |2 * ramp - 1|). */
  tint: number;
}
export function sunAt(hour: number, p: SunParams, colours: ReturnType<typeof lightingColours>, dayIndex = 0): SunState;
export function moonPhase(dayIndex: number): number;   // 0.4 + 0.6 * (0.5 + 0.5 * cos(2π * dayIndex / 29.53))
/** Day shadow direction for a column of `heightPx`: `{ dx: -skew * len, dy: len }` with `len = heightPx * (0.35 + 0.9 * (1 - elevation))`, clamped to 2 T. Zero at night. */
export function sunShadowVector(sun: SunState, heightPx: number, T: number): Point;
```

Why stylised: the office has no latitude, windows are on the *north* wall (back-wall.md), and the reader expects
"morning light leans one way, evening the other". A real solar model would put direct sun through a north window only
in the tropics. `skew = -cos(π * dayFraction)` with `dayFraction = (hour - dawn) / (dusk - dawn)` clamped to [0, 1];
`elevation = sin(π * dayFraction)`. Tests pin the ramps: `daylight` is continuous and monotonic across each twilight,
`sunAt(h)` for `h ∈ {0, 6.5, 12, 18.5, 23.99}` matches a table, and `sunAt(24 - ε) ≈ sunAt(0)` within one step.

### 2.3 Occluders and visibility (`heights.ts`, `occluders.ts`, `visibility.ts`)

```ts
// heights.ts (D2: by kind only). Px of visual height above the floor; 0 = flat (rug, mat, sigil, mat, wall-art, banner, chair, crate, bin).
export const KIND_HEIGHT: Record<FurnitureKind, number>;      // desks 6, tables 5, benches 4, sofa/armchair 7, plant 9, lamp 10, counter 8,
                                                              // bookcase/shelf-stack/cabinet/filing-cabinet/rack/rack-row/cage/fridge/fireplace/coat-rack/supply-stack/printer/water-cooler 12-14,
                                                              // board/notice-board/roster-board 12, console 8, equipment 10, arcade 14, ping-pong/foosball/board-game-table 5, stairs 0
export const OCCLUDER_MIN_HEIGHT_PX = 10;   // kinds at or above this block light (bookcases, racks, cages, appliances); desks do not
export const WALL_HEIGHT_PX = 16;

// occluders.ts
export interface Segment { x1: number; y1: number; x2: number; y2: number }   // world px, axis-aligned
export interface Occluders {
  /** Merged wall/floor boundary runs (a wall run of n tiles is one segment per side) plus the four sides of every tall furniture rect. */
  segments: Segment[];
  /** Uniform grid of segment indices by tile (`cell = tx + ty * cols`), for radius queries. */
  bucket: Int32Array[];     // one array per tile; built once per map
}
/** Walls from `map.tiles` (boundary between wall and floor/door; void never occludes: a cliff edge is open sky), tall furniture
 *  from `map.furniture` with `KIND_HEIGHT[kind] >= OCCLUDER_MIN_HEIGHT_PX` (pins included; soft items never occlude). */
export function buildOccluders(map: Pick<GeneratedMap, 'cols' | 'rows' | 'tileSize' | 'tiles' | 'furniture'>, heights?: Record<FurnitureKind, number>): Occluders;
/** Segments whose bounding box intersects the disc (origin, radius), via the bucket. */
export function segmentsNear(o: Occluders, origin: Point, radius: number, cols: number, T: number): Segment[];

// visibility.ts
export const BASE_RAYS = 48;
/** Angular sweep: rays at `BASE_RAYS` even angles plus one ray per segment endpoint ± 1e-4 rad; each ray stops at the nearest
 *  segment hit or at `radius`; vertices sorted by angle. Star-shaped around `origin`, so `clipToRadius` is exact per vertex. */
export function visibilityPolygon(origin: Point, segments: readonly Segment[], radius: number): Point[];
/** The polygon with every vertex pulled to `min(dist, r)` along its ray (the ring at r for the gradient bands). */
export function clipToRadius(origin: Point, polygon: readonly Point[], r: number): Point[];
/** True when `p` is inside the polygon (ray test; used by the character shadow picker and the tests). */
export function containsPoint(polygon: readonly Point[], p: Point): boolean;
```

The nav grid is reused where it helps: `buildOccluders` takes tall furniture from `map.furniture` (so a half-tile pin
occludes its real rect) and walls from `tiles`; it does **not** rasterise the nav masks (a desk's inset cells are a
walkability detail, not a light one). A light origin that lies inside a wall tile (a torch on the wall face) is nudged
`T / 2` towards the floor side before the sweep, so a wall light illuminates its room instead of being swallowed by its
own wall. Cost: 128 x 96 has about 1.2-1.8k segments; a light sees 30-80 within 5 tiles; 320 lights x ~130 rays x ~60
segments ≈ 2.5M ray-segment tests ≈ 25-40 ms once per map (cached per light; a sun step re-bake never recomputes polygons).

### 2.4 Fallback overlay (`fallback.ts`)

```ts
export interface OverlayPlan { color: number; alpha: number }
/** The M8 night rectangle, driven by the sun: `alpha = nightAlpha * (1 - sun.ambient)` (0 by day, `nightAlpha` at `nightAmbient = 0`),
 *  colour = mix(theme.nightTint, sun.tint, 0.3). Today's night (`isNight`) equals `sunAt(1:00)` with `nightAmbient = 0`. */
export function overlayPlan(sun: SunState, theme: Pick<ThemeDefinition, 'lighting'>): OverlayPlan;
```

### 2.5 Lightmap plan (`plan.ts`)

```ts
export interface GradientBand { r: number; alpha: number }   // concentric rings, outer to inner
export interface PlannedLight {
  light: LightmapLight;
  polygon: Point[];                 // visibility polygon at full reach (cached per map; `plan` only re-reads it)
  bands: GradientBand[];            // BANDS_HIGH = 6, BANDS_LOW = 3; alpha_k = strength * intensity * (k / n)^1.6 ... summed additively ≈ a radial falloff
  intensity: number;                // from `intensityAt(light, sun)`
}
export interface ShaftQuad { points: [Point, Point, Point, Point]; color: number; alpha: number; roomId: string }
export interface LightmapPlan {
  /** RT fill: `sun.tint` scaled to `sun.ambient` (the multiply base). */
  fill: { color: number };
  lights: PlannedLight[];
  shafts: ShaftQuad[];
  /** Realm rects whose fill differs (Multiverse: the rift void between realms stays at `VOID_AMBIENT = 0.25` of the fill). */
  darkRegions: Rect[];
}
export interface PlanInput {
  map: GeneratedMap; sun: SunState; sources: LightmapLight[]; occluders: Occluders;
  polygons: ReadonlyMap<LightmapLight, Point[]>;   // from `bakePolygons` (once per map)
  quality: 'low' | 'high'; settings: LightingSettings; colours: ReturnType<typeof lightingColours>;
  regions: readonly { rect: Rect; theme: ThemeDefinition }[];
}
export function bakePolygons(sources: readonly LightmapLight[], occluders: Occluders, map: Pick<GeneratedMap, 'cols' | 'tileSize'>): Map<LightmapLight, Point[]>;
export function planLightmap(input: PlanInput): LightmapPlan;
/** A window's shaft: a parallelogram from the sill (the wall row's bottom edge over `span` tiles) going south by
 *  `len = T * (1 + 3 * (1 - elevation))` (moon: `1.5 T`), leaning `-sun.skew * len * 0.6` in x, clipped to the room's interior
 *  rect (walls stop light; furniture does not, accepted). Colour sunColor by day / moonColor by night; alpha `0.16 * daylight + 0.07 * moon`. */
export function shaftFor(slot: WallDecorSlot, room: GeneratedRoom, sun: SunState, colours: ..., T: number): ShaftQuad | null;
```

Why bands instead of a texture: Phaser's `Graphics` has no radial gradient and a `RenderTexture` cannot clip a drawn
image by a polygon. Stepped rings (`clipToRadius` per band) are exact for a star-shaped polygon, draw with `fillPoints`
only, and read as pixel-art light (the same stepped look as the pixel vignette). The half-resolution RT with `LINEAR`
filtering is the blur on `high`; `low` uses `quarter` + `NEAREST` and three bands.

### 2.6 Shadows (`shadows.ts`)

```ts
export interface ShadowQuad { points: [Point, Point, Point, Point]; alpha: number }
/** Drop shadows of every furniture item with `KIND_HEIGHT > 0`: the footprint's south edge extruded along the shadow vector
 *  (`sunShadowVector` by day; at night the vector from the nearest `ambient-fill`/`point` light within reach, length `height * 0.6`),
 *  skewed as a parallelogram, alpha `theme.shadowAlpha * (0.5 + 0.5 * max(daylight, nearestStrength))`. `blob` = an unskewed
 *  1-px-inset ellipse-ish rect at `alpha * 0.6`. Clipped to floor/door tiles (a shadow never climbs a wall). */
export function furnitureShadows(map: GeneratedMap, sun: SunState, lights: readonly LightmapLight[], mode: 'blob' | 'cast', shadowAlpha: number): ShadowQuad[];
export interface CastShadow { dx: number; dy: number; len: number; alpha: number }
/** Per character per frame (allocation-free: writes into `out`). Dominant light = the sun by day (`daylight > 0.5`), else the
 *  strongest `strength / (1 + d / reach)` light within reach of the feet via a per-tile light index built once per plan.
 *  `len` in px (6..14), direction away from the light; alpha fades with distance. `blob` → `{0, 0, 0, 0}`. */
export function characterShadow(feet: Point, sun: SunState, index: LightIndex, mode: 'blob' | 'cast', out: CastShadow): CastShadow;
export function buildLightIndex(lights: readonly LightmapLight[], cols: number, rows: number, T: number): LightIndex;
```

---

## 3. Phaser layers (`game/lighting/`, L4)

### 3.1 `LightingController` (the one object `OfficeScene` owns, like `PostFxController`)

```ts
export interface LightingHost {
  map(): GeneratedMap;
  theme(): ThemeDefinition;
  regions(): readonly ThemeRegion[];
  style(): OfficeStyle | typeof MULTIVERSE_THEME_ID;
  characters(): Iterable<Character>;           // cast + NPCs + the Receptionist (anything with a `castShadow`)
  quality(): 'low' | 'high';                    // postFx.resolvedQuality
  webgl(): boolean;                             // postFx.available
  reducedMotion(): boolean;
  now(): number;                                // Date.now(); injectable for tests
  /** Called when the sun phase flips (night ↔ day): the PM feeds `sfxBus.setAmbient({ style, night })`. */
  onPhase(phase: SunPhase): void;
}
export class LightingController {
  constructor(scene: Phaser.Scene, host: LightingHost);
  /** buildWorld / applySkin: rebuild occluders, sources, polygons, shafts; re-bake. Allocates the RT at the map size. */
  setMap(): void;
  /** setOfficeState: settings (`office.lighting`, `office.theme`, `office.shaders.quality`), clock sync, override. Re-bakes if anything that feeds the plan changed. */
  applySettings(office: Settings['office'], clock: ClockSync | undefined, override: LightingOverride | undefined): void;
  /** Every frame: sun step check (re-bake on change), character cast shadows, flicker. ≤ 1 ms on high with 60 characters. */
  update(time: number, delta: number): void;
  /** The current sun (HUD label, tests). */
  get sun(): SunState;
  destroy(): void;
}
```

Decision table (`resolveLightingMode`, pure in `fallback.ts`):

| condition | lightmap RT | shadow layer | character shadow | overlay rect |
|---|---|---|---|---|
| canvas renderer, or `lighting.lightmap = false` | none | none (`blob` keeps the existing ellipse) | existing `ch-shadow` only | `overlayPlan` |
| WebGL `low` | `quarter`, 3 bands, no shafts | `blob` only | existing ellipse | none |
| WebGL `high` | per settings (`half`), 6 bands, shafts | per `shadows` | per `shadows` | none |
| reduced motion | same as above; flicker off; the accelerated cycle still runs (it is slow) | | | |

### 3.2 `LightmapLayer`

- `scene.add.renderTexture(0, 0, ceil(worldW / s), ceil(worldH / s))`, `s = 2 | 4`, `setOrigin(0).setScale(s).setDepth(LIGHTMAP_DEPTH).setBlendMode(Phaser.BlendModes.MULTIPLY)`; texture filter `LINEAR` (high) / `NEAREST` (low).
- `bake(plan)`: `rt.clear(); rt.fill(plan.fill.color)`; for each `darkRegions` rect fill the darker colour; one shared
  `Graphics` (`scene.make.graphics({}, false)`) is cleared and reused: for each planned light, for each band
  `g.fillStyle(light.color, band.alpha); g.fillPoints(clipToRadius(origin, polygon, band.r) scaled by 1/s, true)`; the
  Graphics is drawn with `ADD` blend (`g.setBlendMode(ADD)`) once via `rt.draw(g)` every 32 lights (keeps the command list
  short); shafts are drawn last with `NORMAL` blend at their alpha. One `rt.draw` batch per 32 lights means 10 draws at
  320 lights. Dev log: `[lighting] lightmap baked in X ms (N lights, M shafts)`; target ≤ 16 ms at 128 x 96 half-res.
- By full day (`sun.ambient >= 0.98` and no shafts) the RT is `setVisible(false)`: multiplying by white costs a draw for nothing.
- Flicker (torches, fireplace; `flicker && !reducedMotion`): not a re-bake. The RT holds the *static* bake; a flickering
  light also gets a small additive `Image` of `LIGHT_GLOW_TEXTURE` (the existing bloom glow texture, `glowTexture.ts`) inside
  the lightmap's own `Container` at depth `LIGHTMAP_DEPTH + 1` tweened in alpha 0.0-0.08, capped at 24 sprites. This is the
  only per-frame moving part besides character shadows.

### 3.3 `ShadowLayer`

One `Graphics` at `SHADOW_DEPTH = -5` (above the base texture at -10, below every character at `depth = y >= 0`),
`NORMAL` blend, re-drawn from `furnitureShadows(...)` on every bake (cheap: a few hundred `fillPoints`). Shafts are *not*
here (they live in the lightmap so walls clip them for free); the layer only holds shadows, so a door open onto a sunlit
corridor still gets its shaft. Multiverse: realm rects use their own theme's `shadowAlpha`.

### 3.4 Character cast shadows (`actors/Character.ts`, `textures.ts`; L4)

```ts
// textures.ts: 'ch-shadow-cast': a 10 x 10 soft blob (alpha 0.22) drawn once, like 'ch-shadow'.
// Character.ts
/** M16: skewed shadow from the dominant light. `len`/`dx`/`dy` in px; `alpha` 0 hides it (blob mode / no light). Allocation-free. */
setCastShadow(s: Readonly<CastShadow>): void;
```

The cast image is added to the container right after `this.shadow` (so it is under the legs and over the floor), origin
`(0.5, 1)` at the feet, `scaleX = 1`, `scaleY = len / 10`, rotated to `atan2(dx, -dy)` (Phaser rotates clockwise in y-down; as landed in L4), alpha from the plan. The existing
`ch-shadow` ellipse stays (it is the "blob"). `destroyAll()` destroys it; the selection glow stays on `this.shadow`
(`Character.ts:697`), untouched.

### 3.5 Interaction with existing layers

| layer | depth | blend | M16 effect |
|---|---|---|---|
| base texture (tiles, dual edges, back wall, furniture) | -10 | normal | unchanged; the dual pass (M15) is baked into it, so shadows and the lightmap sit over its edges like over any pixel |
| **ShadowLayer** (new) | -5 | normal | furniture shadows; under characters |
| characters, labels, bubbles | y ≥ 0 … | | unchanged; characters get a cast shadow image inside their own container |
| room labels | 1 | | unchanged |
| realm banners | 50 000 | | unchanged |
| **LightmapLayer** (replaces the night rect) | 90 000 | multiply | darkens everything below per the plan |
| flicker glows | 90 001 | add | small, capped |
| bloom `LightLayer` | 95 000 | add + bloom postFX | unchanged: fixture glows read *through* the dark, as today |
| camera post pipelines (grading → screen → vignette) | camera | | unchanged: they grade the multiplied result, so the guild's warm grade still warms the night |
| tooltip | 200 000 (scrollFactor 0) | | unchanged |

`PostFxController` keeps owning bloom and never learns about the lightmap; the only coupling is read-only
(`resolvedQuality`, `available`) through the host.

---

## 4. HUD time-of-day row (`app/MenuSheet.tsx`, `stores/displayPrefsStore.ts`, `features/office/useLightingPrefs.ts`; L5)

- `displayPrefsStore` gains `lightingHour: number | null` (persisted in the same `tagconn.display` key; `null` = follow the
  server), `setLightingHour(h | null)`, and `resolveLightingOverride(prefs): LightingOverride | undefined`.
- `TimeOfDayRow` (same markup pattern as `ScreenEffectRow`): a switch "Time of day: follow the office clock" (on = follow,
  the default), and when overridden a `<input type="range" min=0 max=24 step=0.25>` with `aria-valuetext` "14:30, afternoon"
  and a live label (`formatHour(h)` + `phaseLabel(sunAt(h).phase)`), plus "Now" (sets the slider to the host hour and keeps
  the override) and "Default" (back to following). The row shows the host zone (`clock.tz ?? UTC±hh:mm`) in its hint, so a
  Docker user sees "UTC" and knows to set `TZ`. No hotkey in M16 (`T` is free in `MENU_HOTKEYS`, but the row is a slider, not
  a toggle action; a later milestone may add `T` = toggle override).
- `OfficeView`'s bridge (PM) adds `clock: useOfficeStore.getState().clockSync` and
  `lightingOverride: resolveLightingOverride(useDisplayPrefsStore.getState())` to `game.setState(...)` and subscribes
  to `useDisplayPrefsStore` like it does for `screenFx`.
- Phones: the row is inside the ☰ sheet already; the slider gets `coarse:min-h-11`.
- `docs/guide/display.md` (Gate, tech-writer): the row, the settings, Docker `TZ`.

---

## 5. Perf budgets (`game/lighting/__tests__/lighting.perf.test.ts`, `pnpm test:perf` only)

At 128 x 96 (`maxRoomsLayout()` from `game/__tests__/perfLayout.ts`), medians over 9 samples after a warm-up, generous
ceilings like `generate.perf.test.ts`:

| what | budget |
|---|---|
| `buildOccluders` | ≤ 6 ms |
| `bakePolygons` for every source (≈ 250-320 lights) | ≤ 60 ms (one-off per map; the dev log reports the browser figure) |
| `planLightmap` with cached polygons (a sun step) | ≤ 8 ms |
| `furnitureShadows` (cast) | ≤ 4 ms |
| `characterShadow` x 60 + `sunStep` + `cycleHour` (one frame, stub scene) | ≤ 0.3 ms (the 1 ms/frame budget leaves room for the Phaser transforms) |
| `generate.perf.test.ts` with `planRoomLights` | unchanged ceilings (`MEDIAN_BUDGET_MS = 400`); the lights pass is O(rooms) |

Browser (QA gate, `?demo=1`, Chrome): the Performance panel shows `LightingController.update` under 1 ms per frame on
high with 40 characters; a sun step bake under 16 ms at half resolution; low quality under 6 ms at quarter.

---

## 6. Test plan (vitest; pure first)

1. `clock.test.ts` (L1): `syncClock` midpoint math (RTT 0 / 200 ms; missing clock → skew 0, browser zone);
   `hostLocalHour` for Jakarta (+420) and New York (-240) on fixed epochs, independent of the test runner's zone
   (`vi.setSystemTime` + a stubbed `browserTzOffsetMin`); `cycleHour` for the three cycles incl. wrap at 24; `sunStep`
   boundaries; `resolveCycle` precedence table (override > theme day/night > settings; `auto` = settings).
2. `sun.test.ts` (L1): the table of §2.2; continuity (|Δdaylight| ≤ 0.05 per minute); symmetry (`skew(dawn + t) = -skew(dusk - t)`);
   `elevation` peaks at the day centre; `moonPhase` ∈ [0.4, 1]; `sunShadowVector` zero at night, longer at dawn than noon;
   `nightAmbient = 1` → `ambient = 1` all day.
3. `fallback.test.ts` (L1): `overlayPlan(sunAt(1:00), nightAmbient 0)` reproduces today's `(nightTint, nightAlpha)`; day → alpha 0.
4. `occluders.test.ts` (L2): a `tilesFrom` fixture (reuse `themes/dual/__tests__/fixtures.ts#tilesFrom`): a 5 x 5 walled room
   yields exactly 4 boundary runs (+ door gaps); segments never on void; a bookcase adds 4 segments, a rug none, a pinned
   half-tile bookcase adds its real rect; `segmentsNear` ⊆ all and ⊇ brute-force within radius.
5. `visibility.test.ts` (L2): a light in a closed room: every polygon vertex inside the room's interior rect (+1 px); with
   one door the polygon crosses the door tile and nothing else; `clipToRadius` vertices ≤ r; `containsPoint` on a square;
   determinism (two runs equal); a light inside a wall tile is nudged onto its floor side; 300 random (origin, segment set)
   cases: no vertex further than `radius + 1e-6`, vertices angle-sorted.
6. `plan.test.ts` (L2): bands count per quality; windows get shafts only when `windowShafts`; shaft quads inside the room's
   interior; shaft lean sign flips across noon; `darkRegions` on a Multiverse plan; intensities (lamp ≈ 0.15 at noon, 1 at night;
   window = daylight; moon shaft at night); `lightScale` scales `reach`; truncation keeps room lights.
7. `shadows.test.ts` (L2): shadow quads start on the footprint's south edge; day vector = `sunShadowVector`; at night the
   vector points away from the nearest light; `blob` = unskewed; alpha within [0, shadowAlpha]; `characterShadow` is
   allocation-free (the same `out` object) and `{0,0,0,0}` in blob mode; `buildLightIndex` returns the nearest light.
8. `roomLights.test.ts` (L3): one light for a 4 x 3 room at its centre; `ceil(area / 24)` lights on a grid for 300 BSP seeds; every
   light inside its interior; deterministic; `generate` emits `lights` and `walkable`/`seats`/`furniture` are byte-identical
   to before (parity fixture `m15-parity.json` untouched).
9. `sources.test.ts` (L2): room lights first; every `extractLightSources` entry present with `kind`; reach table; cap order.
10. `lights.test.ts` (W0, existing): every entry has a `kind`; order and cap unchanged.
11. `LightingController.test.ts` (L4, stub scene with fake RT/Graphics/Image): mode table of §3.1; a sun step change bakes
    exactly once; `applySettings` with equal inputs does not bake; `update` with 60 fake characters calls `setCastShadow` on each
    and allocates nothing after warm-up (`performance.memory` not available: assert via a counting `out` object).
12. `displayPrefsStore.test.ts` (L5): `lightingHour` persisted/validated (NaN, 25 → null); `resolveLightingOverride`.
13. Server `snapshot/__tests__/socket.test.ts` (S1): the ack carries `clock` with `serverNow` within ±1 s and `tzOffsetMin` =
    `-new Date().getTimezoneOffset()`; `GET /api/snapshot` too.
14. PM smoke (`?demo=1`, modern, guild, Multiverse): slider at 06, 12, 18, 23 → screenshots; rooms lit at night with pools
    stopping at walls; shafts lean west in the morning and east in the evening; shadows follow; `shadows: off/blob/cast`;
    `lightmap: false` = the old overlay; canvas renderer (`?renderer=canvas` if the demo supports it, else Chrome's WebGL
    disabled flag) = the old overlay; toggling the ☰ row live; sfx ambient flips with the phase.

---

## 7. PM wiring (Wave 3, the only edits to hot files)

`OfficeScene.ts`:
1. Fields: `private lighting!: LightingController;` remove `private night`, `themeTimer`, `applyLighting()`.
2. `create()`: construct after `this.postFx = ...` with the host of §3.1 (`characters: () => [...this.characters.values(), ...npcs, receptionist]`,
   `onPhase: (phase) => sfxBus.setAmbient({ style, night: phase === 'night' })`); remove the `this.night = ...` and `themeTimer`
   lines; SHUTDOWN: `this.lighting.destroy()`.
3. `buildWorld` (after `renderVisuals`) and `applySkin`: `this.lighting.setMap()`; remove `this.night.setSize(...)`.
4. `setOfficeState`: replace `this.applyLighting()` with `this.lighting.applySettings(office, state.clock, state.lightingOverride)`
   after `this.postFx.applySettings(...)` (quality must be resolved first).
5. `update`: `this.lighting.update(time, delta)` after the characters loop.
6. `NpcDirector` host: `hour: () => this.lighting.sun.hour` (the host's hour, not the browser's; `npcDirector.ts` unchanged).

`OfficeView.tsx`: the two `game.setState` fields of §4 and the `useDisplayPrefsStore` subscription.
`lib/connection.ts` + `stores/officeStore.ts`: `clockSync` (§1.4) (small; PM or S1's developer, not in a hot file).
`docker-compose.yml`, `.env.example`: `TZ` (§1.1).

---

## 8. Combined M16 wave plan (lighting + furnishing)

Paths under `apps/web/src/` unless they start with `packages/` or `apps/server/`. **File-disjoint within a wave**; a file
may change owner between waves. Hot files (`OfficeScene.ts`, `OfficeView.tsx`, `OfficeGame.ts`) are PM-only.
`themes/renderTheme.ts` is edited by nobody in M16 (painters keep their signature; `facing` is read from `f`).
`themes/paint/furniture.ts` and `riftFurniture.ts` belong to the furnishing painter tasks (F3 in W1, F6 in W2); lighting
touches `themes/paint/decor.ts` only (L6, W2) and the three `themes/{modern,guild,rift}.ts` files only in W2 (L6), when no
furnishing task edits them. Every developer runs the ROOT `pnpm typecheck` and the web tests before hand-off; the PM commits
after each verified wave.

### Wave 0 (contract; architect docs in parallel)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| W0-L | developer (contract) | `packages/shared/src/domain.ts` (`HostClock`, `clock?`), `packages/shared/src/settings.ts` (`office.lighting`), `features/settings/meta.ts` + `meta.test.ts`, `config/office.yaml`, `postfx/types.ts` (`kind`), `postfx/lights.ts` (+ `postfx/__tests__/lights.test.ts`), `themes/types.ts` (lighting fields), `procgen/types.ts` (`RoomLight`, `lights`), `procgen/generate.ts` (one line: `lights: []` until L3), `game/lighting/{types,index}.ts`, `lib/mock.ts` (demo `clock`) | none | §1.1, 1.2, 1.6, 1.7, 1.8 verbatim; hints for every new key; ROOT typecheck + tests green; PM commits before W1. |
| W0-F | developer (contract) | `packages/shared/src/layout.ts` + `__tests__/layout.test.ts`, `procgen/types.ts` (shared with W0-L: one developer does both W0 tasks, sequentially), `procgen/facingSpec.ts` (new, data), `features/editor/pins.ts` (type plumbing only) | none | furnishing.md §1 verbatim; superset schema tests (old rows parse; `w: 2.5`, `facing`, `fromSlot`, `suppressed` accepted; bad `fromSlot` rejected). |
| S1 | developer (server) | `apps/server/src/modules/snapshot/snapshot.service.ts`, `snapshot/__tests__/socket.test.ts`, `docker-compose.yml`, `.env.example` | W0-L | test 13; compose passes `TZ`. |
| PM | PM | `game/scenes/OfficeScene.ts` (`OfficeState` fields only) | W0-L | §1.5. |

### Wave 1 (parallel, pure modules and the editor)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| L1 | developer (lighting) | `game/lighting/{clock,sun,fallback,palette}.ts`, `game/lighting/__tests__/{clock,sun,fallback}.test.ts` | W0-L | §1.3-1.4, §2.2, §2.4; tests 1-3. |
| L2 | developer (lighting) | `game/lighting/{heights,occluders,visibility,sources,plan,shadows}.ts`, `game/lighting/__tests__/{occluders,visibility,plan,shadows,sources}.test.ts`, `game/lighting/__tests__/lighting.perf.test.ts` | W0-L (codes against L1's `SunState` type from `types.ts`; builds `SunState` literals in tests) | §1.8, §2.3, 2.5, 2.6; tests 4-7, 9; §5 budgets. |
| L3 | developer (procgen) | `procgen/roomLights.ts`, `procgen/generate.ts` (the `lights` call only), `game/multiverse/*` slice helper (one line), `procgen/__tests__/roomLights.test.ts` | W0-L | §1.7; test 8; parity fixture unchanged. **The only W1 owner of `generate.ts`.** |
| F1 | developer (procgen) | `procgen/harmony.ts`, `procgen/recipes.ts`, `procgen/__tests__/{harmony,furnish}.test.ts` | W0-F | furnishing.md §2-3 (groups, slot ids, decor ctx, half-gap pitches behind a constant); `furnish.test.ts` re-baselined with the same coverage bands. Does **not** edit `generate.ts` (F5, W2). |
| F2 | developer (nav) | `game/nav/shapes.ts`, `game/nav/__tests__/shapes.test.ts`, `game/nav/__tests__/navigator.test.ts` (insets cases) | W0-F | furnishing.md §4; navigation.md properties 1, 5, 6, 10 green. |
| F3 | developer (themes) | `themes/paint/furniture.ts`, `themes/paint/riftFurniture.ts`, `themes/paint/facing.ts` (new), `themes/__tests__/{painters,riftPainters}.test.ts`, `themes/__tests__/testUtils.ts` (rect-recording harness: fractional footprints) | W0-F | furnishing.md §5 (painter audit: half-tile w/h, clipping); facing helper landed; no `renderTheme.ts` edit. |
| F4 | developer (editor) | `features/editor/{pins.ts,snap.ts,glyphs.ts,FurniturePalette.tsx,PlanCanvas.tsx,Inspector.tsx,OfficeEditor.tsx,shortcuts.ts}` + tests, `stores/editorStore.ts` + test | W0-F | furnishing.md §6 (fromSlot on drag, suppress, rotate, palette, snap guides, glyphs/labels); the duplicate-on-drag regression test passes once F5 lands (until then `slotId` is absent and the old behaviour holds, test marked `todo` → enabled in W2). |

### Wave 2 (parallel: Phaser layers, HUD, themes, generator integration, painter facing)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| L4 | developer (game) | `game/lighting/{LightmapLayer,ShadowLayer,LightingController}.ts`, `game/lighting/__tests__/LightingController.test.ts`, `game/actors/Character.ts` (§3.4 only), `game/textures.ts` + `textures.test.ts` (`ch-shadow-cast`) | L1, L2 | §3; test 11; the stub-scene frame budget. |
| L5 | developer (web) | `app/MenuSheet.tsx`, `stores/displayPrefsStore.ts` + test, `features/office/useLightingPrefs.ts` + test, `lib/connection.ts`, `stores/officeStore.ts` + test (`clockSync`) | L1 | §4; test 12; `resync` re-measures skew. |
| L6 | developer (themes) | `themes/modern.ts`, `themes/guild.ts`, `themes/rift.ts` (lighting blocks; guild `animate` adds a chandelier image per `map.lights` under `ambient`), `themes/paint/decor.ts` (chandelier texture), `themes/__tests__/data.test.ts`, `themes/__tests__/guildAnimate.test.ts` | W0-L | colours of §1.6; chandelier count = `map.lights` in guild rooms, none on modern/rift; `riftAnimate.test.ts` green. |
| F5 | developer (procgen) | `procgen/generate.ts`, `procgen/pins.ts`, `procgen/__tests__/{pins,generate,backWall,triggers}.test.ts` as needed, `procgen/__tests__/fixtures/m15-parity.json` (re-captured once, documented), `procgen/__tests__/generate.perf.test.ts` (budget check only) | F1, F2, L3 | furnishing.md §3.4-3.6 (slot consumption, displaced items, pinned-blocks keep + warn, decor ctx, harmony ctx); procgen median ≤ 1.3 x today's; property suite green. **The only W2 owner of `generate.ts`.** |
| F6 | developer (themes) | `themes/paint/furniture.ts`, `themes/paint/riftFurniture.ts`, painter tests | F3 | furnishing.md §5.3 facing variants for the asymmetric kinds; bounds harness with rotated rects. |

### Wave 3 (sequential: PM wiring, then the gate)

| id | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|
| W3-PM | PM | `game/scenes/OfficeScene.ts`, `features/office/OfficeView.tsx`, `game/npc/npcDirector.ts` (hour source, if needed) | L4, L5, F5 | §7 applied; ROOT typecheck/test/build + `pnpm test:perf`; smoke 14; furnishing.md smoke. |
| Gate | qa-engineer, code-reviewer, security-engineer, tech-writer (parallel) | qa: tests only; tech-writer: `docs/guide/display.md`, `docs/guide/office.md`, `docs/guide/configuration.md`, `docs/architecture.md`, `CHANGELOG.md` | W3-PM | QA on desktop + phone, every style, Multiverse, canvas fallback, Docker `TZ`; review of the depth table (§3.5) and determinism; security: the new input surface is `HostClock` (server → client only; the client never sends time) and the widened pin schema (furnishing.md §1); then `pnpm release minor` → v0.10.0. |

---

## 9. Risks and trade-offs

- **Multiply on canvas.** The canvas renderer supports `multiply` compositing, but the per-bake polygon drawing into a
  `RenderTexture` is slow there; the decision table keeps canvas on the flat overlay. Accepted.
- **Stepped rings vs a smooth gradient.** Six bands can show as rings on large pools at `lightScale > 2`. The lever: raise
  `BANDS_HIGH` to 8 (cost is linear in bands) or pick `quarter` + `LINEAR`. Tuned by QA screenshots within the budget.
- **Polygon cost on the Multiverse.** The Nexus plan (up to 1920 x 1408 px) has more lights and more segments; the one-off
  `bakePolygons` may reach 100 ms there. It runs once per map build (already a 20 ms base-texture bake plus procgen), is
  logged, and can be chunked over two frames behind `requestAnimationFrame` if QA sees a hitch (open point, not blocking).
- **Shadows under the depth invariant.** Furniture shadows at depth -5 fall *under* characters; a character standing in a
  bookcase's shadow is not darkened (the lightmap darkens it uniformly instead). Correct for 3/4 top-down; M17 revisits with
  y-sorting.
- **Shafts ignore furniture.** A desk in front of a window does not block its shaft (the shaft clips to the room only). Accepted.
- **Wall-light origins.** A torch sits *in* the wall face tile; the half-tile nudge towards the floor puts it just inside the
  room. Rooms sharing a wall never see each other's torch (the segment between them is opaque).
- **Clock trust.** `HostClock` is server → client only and is rendered as a number; a bogus `serverNow` can only make the
  office think it is a different hour (`syncClock` clamps `|skew|` to 48 h and falls back to the browser clock beyond it).
- **`office.theme` semantics.** `day`/`night` used to be a binary; now they pin the hour (13:00 / 01:00), so `night` renders
  the full lightmap night rather than just the blue rectangle. The guide says so.
- **Flicker sprites double up with bloom.** The flicker glow lives in the lightmap container (small, alpha ≤ 0.08) and the
  bloom sprite in `LightLayer`; both exist for the same torch, on purpose (one darkens-less, one glows). Capped at 24.
- **Baseline churn.** `lights` is a new map field; every snapshot-style procgen test that stringifies the whole map needs the
  field (L3 updates those; `m15-parity.json` compares `furniture` and seats only and is untouched here).
