import * as Phaser from 'phaser';
import {
  DEFAULT_LAYOUT,
  MULTIVERSE_LIMITS,
  MULTIVERSE_THEME_ID,
  type Agent,
  type Hero,
  type MultiversePlan,
  type MultiverseRealm,
  type OfficeLayout,
  type OfficeStyle,
  type Role,
  type Session,
  type Settings,
  type Zone,
} from '@tagconn/shared';
import { generateMap } from '../procgen';
import type { GeneratedMap, Point, Rect, StairsSpot } from '../procgen/types';
import { PathFinder } from '../pathfinding';
import { SeatAllocator, type SeatScope } from '../seats';
import { Character } from '../actors/Character';
import { generateTextures } from '../textures';
import { resolveCostume, resolveTitle } from '../lookResolver';
import { resolveHeroCostume } from '../heroLook';
import { resolveCast, type ActorKey, type Cast, type CastMember } from '../cast';
import { nextLifecycle, type ActorLifecycleState, type LifecycleFrame } from '../actorLifecycle';
import {
  getTheme,
  paintCostumeTextures,
  prefersReducedMotion,
  renderGeneratedMap,
  themedBubble,
  THEME_BASE_TEXTURE,
  type ThemeDefinition,
  type ThemeRegion,
} from '../themes';
import { ZERO_INSETS, centerInSafeRect, clampScrollToSafeBounds, type SafeInsets } from '../camera/insets';
import { zoomCameraAboutPoint } from '../camera/zoom';
import { isDragMove } from '../camera/drag';
import { counterScale, labelVisible, layoutLabels, type LabelSubject } from '../labels';
import { PostFxController } from '../postfx/PostFxController';

/** M8 8e: how often the bubble/label layout (`game/labels`) is recomputed — a throttle, not every
 *  frame, since it's a many-subject greedy placement and labels don't need to react per-pixel. */
const LABEL_REFRESH_MS = 120;

/** A neighboring floor reachable by the stairs, with its display label pre-formatted by the theme. */
export interface OfficeFloorNeighbor {
  id: string;
  label: string;
}

/**
 * Where the current floor sits in the stairs order (docs/design/guild-hall.md section 6). M8 8h:
 * the Multiverse is just another floor in that order (appended last by `lib/floors.ts`) — its `above`
 * is absent (its own up stairs are disabled) and `below` is the top project floor (section 6.3).
 */
export interface OfficeFloorInfo {
  index: number;
  count: number;
  above?: OfficeFloorNeighbor;
  below?: OfficeFloorNeighbor;
}

/**
 * The scene's input contract (docs/design/living-office.md section 7). `floorKey` stays; `heroes`,
 * `sessions`, `multiverse` and `pinnedPrimary` are additive (M8 8b/8c/8h/8i) on top of the pre-M8
 * shape — `OfficeView` (W7b) always populates them (including in demo mode), so they are required
 * here rather than optional. On the Multiverse floor `layout` is `multiverse.layout` and `style` is
 * `'rift'`; the host builds `multiverse` with `game/multiverse/plan.ts#planMultiverse` and this scene
 * only renders it (regions, realm-scoped seats/hit-zones — stairs already fall out of `floor` alone).
 */
export interface OfficeState {
  agents: Agent[];
  /** Heroes visible on this floor (every subscribed project's, on the Multiverse). */
  heroes: Hero[];
  /** Sessions visible on this floor — feeds Guild Master primary selection and its "+N" chip. */
  sessions: Session[];
  settings: Settings;
  roles: Role[];
  /** Changing floors swaps the cast instantly instead of walking everyone out. */
  floorKey: string;
  layout: OfficeLayout;
  /** Resolved style: `layout.style` wins over `settings.office.style`; `'rift'` on the Multiverse. */
  style: OfficeStyle | typeof MULTIVERSE_THEME_ID;
  floor: OfficeFloorInfo | null;
  /** Non-null exactly on the Multiverse floor. */
  multiverse: MultiversePlan | null;
  /** M8 8b: web-local "pin this session as Guild Master" overrides, by projectId (`GmSessionsPopover`).
   *  Seeded into the Guild Master hysteresis every call, the same convention `Roster`'s own
   *  `resolveCast` call uses — a pin isn't absolute (a challenger that needs you can still preempt it
   *  for one cycle), but it is fed back in every frame, so it wins back the next one. */
  pinnedPrimary: Record<string, string>;
}

const parseColor = (c: string | undefined, fallback = 0x8e8e9e) => {
  const n = c && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : NaN;
  return Number.isNaN(n) ? fallback : n;
};

/** Main-session first, then by start time. Pre-M8 helper, kept for compatibility; the scene itself
 *  now orders and caps through `resolveCast` (docs/design/living-office.md section 4.1), which also
 *  accounts for heroes, the Guild Master merge and "needs you" preemption. */
export function visibleAgents(agents: Agent[], max: number): Agent[] {
  return [...agents].sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.startedAt - b.startedAt).slice(0, Math.max(0, max));
}

interface StairsSprite {
  spot: StairsSpot;
  zone: Phaser.GameObjects.Zone;
  ring: Phaser.GameObjects.Arc;
}

interface RealmZoneSprite {
  zone: Phaser.GameObjects.Zone;
  outline: Phaser.GameObjects.Graphics;
}

function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The drawn footprint of a realm's rooms (excludes the void margin in its 30x22 cell), used both
 *  as the theme region's `rect` and as the floating-island edge boundary (section 6.2). */
function realmBlockRect(map: GeneratedMap, realm: MultiverseRealm): Rect {
  let rect: Rect | undefined;
  for (const id of realm.roomIds) {
    const room = map.rooms.find((r) => r.id === id);
    if (!room) continue;
    rect = rect ? unionRect(rect, room.footprint) : room.footprint;
  }
  return rect ?? realm.cell;
}

/** The realm floor tile nearest the Nexus that is reachable from the spawn (section 6.3): new
 *  characters walk in from the Nexus spawn, and `entrance`/leave targets inside a realm resolve
 *  here instead of the whole map's single `entrance` room (which the Multiverse doesn't scope to a realm). */
function realmGate(map: GeneratedMap, realm: MultiverseRealm, nexusCenter: Point): Point {
  const roomIds = new Set(realm.roomIds);
  let best: Point | undefined;
  let bestDist = Infinity;
  for (const room of map.rooms) {
    if (!roomIds.has(room.id)) continue;
    for (const t of room.tiles) {
      if (map.walkable[t.y]?.[t.x] !== 0) continue;
      const d = Math.abs(t.x - nexusCenter.x) + Math.abs(t.y - nexusCenter.y);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
  }
  return best ?? map.spawn;
}

/** A `GeneratedMap` restricted to one realm's decor/furniture/stairs (section 6.2: "the scene calls
 *  each realm theme with a map slice"), so a realm's own `animate()` call never double-paints
 *  objects that belong to a neighboring realm or the Nexus. Geometry fields are shared references —
 *  `animate()` only reads, never mutates, its `map` argument. */
function sliceMapForRect(map: GeneratedMap, rect: Rect): GeneratedMap {
  return {
    ...map,
    decor: map.decor.filter((d) => rectContains(rect, d.x, d.y)),
    furniture: map.furniture.filter((f) => rectContains(rect, f.x, f.y)),
    stairs: map.stairs.filter((s) => rectContains(rect, s.x, s.y)),
  };
}

/**
 * M8 8h fair-share cap across realms (section 6.3): each realm gets `floor(cap/n)`, and the leftover
 * is handed out one at a time to realms with a live Guild Master first, then in realm order — a
 * simple, deterministic split rather than a fully demand-aware one (a realm's own `resolveCast` call
 * still puts its Guild Master first within whatever share it gets, so a GM is never the one dropped).
 */
function splitMultiverseCap(total: number, realms: readonly MultiverseRealm[], agents: readonly Agent[]): Map<number, number> {
  const n = realms.length;
  const caps = new Map<number, number>();
  if (n === 0) return caps;
  const base = Math.floor(total / n);
  let leftover = Math.max(0, total - base * n);
  for (const r of realms) caps.set(r.index, base);
  const hasLiveGm = (r: MultiverseRealm): boolean => {
    const ids = new Set(r.projectIds);
    return agents.some((a) => a.isMain && a.status !== 'done' && ids.has(a.projectId));
  };
  const order = [...realms].sort((a, b) => Number(hasLiveGm(b)) - Number(hasLiveGm(a)) || a.index - b.index);
  for (const r of order) {
    if (leftover <= 0) break;
    caps.set(r.index, (caps.get(r.index) ?? 0) + 1);
    leftover--;
  }
  return caps;
}

/** What this frame wants an actor to be doing, before the pure `nextLifecycle` reducer applies the
 *  `idleLeaveSec` timer (docs/design/living-office.md section 4.2). A rebind (the key is back and,
 *  for a persistent actor, its agent isn't `done`) always wins; otherwise an actor already mid-fade
 *  (`alreadyLeaving` — whether from `idleLeaveSec` expiring or `enforceCaps`' eviction) stays
 *  `leaving` rather than flip-flopping back to `resting` for one more frame. */
function desiredLifecycle(persistent: boolean, member: CastMember | undefined, alreadyLeaving: boolean): ActorLifecycleState {
  const rebind = !!member && !(persistent && member.agent.status === 'done');
  if (rebind) return 'quest';
  if (alreadyLeaving) return 'leaving';
  return persistent ? 'resting' : 'leaving';
}

export class OfficeScene extends Phaser.Scene {
  private map!: GeneratedMap;
  private theme!: ThemeDefinition;
  private finder!: PathFinder;
  private seats!: SeatAllocator;
  /** Static world art (base texture, room labels/realm banners) — rebuilt on any geometry or style
   *  change and never touched by anything else. */
  private worldLayer: Phaser.GameObjects.GameObject[] = [];
  /** `theme.animate()`'s objects (torches, motes, ...) — split out from `worldLayer` so toggling
   *  `office.ambientEffects` can refresh just these live, without a geometry rebuild (bug: it used
   *  to take effect only after the next rebuild/reskin). */
  private ambientLayer: Phaser.GameObjects.GameObject[] = [];
  private stairsSprites: StairsSprite[] = [];
  /** M8 8h: one realm per Multiverse cell, `[]` on a normal floor. Rebuilt only on `buildWorld`. */
  private regions: ThemeRegion[] = [];
  private multiversePlan: MultiversePlan | null = null;
  private realmScopes = new Map<number, SeatScope>();
  private realmZoneSprites: RealmZoneSprite[] = [];
  /** M8 8o: color grading/vignette/scanlines/bloom-light-layer, see `game/postfx/PostFxController`. */
  private postFx!: PostFxController;
  private tooltip!: Phaser.GameObjects.Text;
  private characters = new Map<ActorKey, Character>();
  private night!: Phaser.GameObjects.Rectangle;
  private state?: OfficeState;
  /** `layout.id + updatedAt` (+ the Multiverse plan's own key) — a full geometry rebuild only
   *  happens when this changes (D2: a style switch alone re-skins the same geometry, so seats and
   *  characters never move). */
  private layoutKey = '';
  private appliedStyle: OfficeStyle | typeof MULTIVERSE_THEME_ID | null = null;
  private floorKey: string | null = null;
  private userZoom = 1;
  private panned = false;
  private drag: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
  private inputLocked = false;
  private themeTimer?: Phaser.Time.TimerEvent;
  /** The safe-region insets currently applied to the camera (animated toward whatever React last reported). */
  private insets: SafeInsets = { ...ZERO_INSETS };
  private insetsTween?: Phaser.Tweens.Tween;
  /** Agent id the camera keeps centered while it moves, or null when nothing is being followed. */
  private followId: string | null = null;
  /** Zoom/scroll saved by `runTransition` so `finishTransition` can restore them instead of leaving
   *  the +6% transition bump applied forever (docs/design/guild-hall.md section 6). `null` when no
   *  transition is in flight. */
  private preTransitionZoom: number | null = null;
  private preTransitionScrollY: number | null = null;
  /** M8 8d: the agent whose drawer is open (glow + focus dim) and the one currently hovered
   *  (subtle highlight + expands a collapsed bubble badge) — both tracked by `ActorKey` internally;
   *  `selectedAgentId` is the external (agent-id) handle `OfficeGame.setSelected` is called with. */
  private selectedAgentId: string | null = null;
  private selectedKey: ActorKey | null = null;
  private hoveredKey: ActorKey | null = null;
  /** Countdown to the next throttled `refreshLabels()` pass (M8 8e); `<= 0` due next `update()`. */
  private labelTimer = 0;
  /** M8 8b/8c: Guild Master hysteresis (`cast.ts`'s `prevPrimary`, seeded every call with
   *  `OfficeState.pinnedPrimary`) and the agent-id -> `ActorKey` index rebuilt every
   *  `setOfficeState` pass (external selection looks agents up by id; everything internal is keyed
   *  by `ActorKey`). */
  private prevPrimary = new Map<string, string>();
  private agentIndex = new Map<string, ActorKey>();
  private endDragOnBlur = () => {
    this.drag = null;
  };

  constructor(private onReady?: (scene: OfficeScene) => void) {
    super('office');
  }

  create() {
    generateTextures(this);
    paintCostumeTextures(this);
    this.tooltip = this.add
      .text(0, 0, '', {
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '11px',
        color: '#1c1430',
        backgroundColor: '#f3e9d2',
        padding: { x: 6, y: 3 },
        resolution: 2,
      })
      .setOrigin(0, 1)
      .setScrollFactor(0)
      .setDepth(200_000)
      .setVisible(false);
    this.cameras.main.setBackgroundColor('#15121e');
    // M8 8o: grading/vignette/scanlines attach to the main camera and the light layer is created
    // here, before the first `buildWorld` — its `renderVisuals()` already tries to seed the light
    // layer (a no-op until `setOfficeState`'s first pass has settings to read).
    this.postFx = new PostFxController(this);
    this.buildWorld(DEFAULT_LAYOUT, 'guild', null);
    this.night = this.add.rectangle(0, 0, this.worldW, this.worldH, 0x0b1030, 0).setOrigin(0).setDepth(90_000);
    this.setupCamera();
    this.themeTimer = this.time.addEvent({ delay: 60_000, loop: true, callback: () => this.applyLighting() });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.tooltip.visible) this.tooltip.setPosition(p.x + 14, p.y - 10);
    });
    this.scale.on('resize', () => this.fitCamera());
    window.addEventListener('blur', this.endDragOnBlur);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.themeTimer?.remove();
      window.removeEventListener('blur', this.endDragOnBlur);
      this.postFx.destroy();
    });
    this.onReady?.(this);
  }

  get worldW() {
    return this.map.cols * this.map.tileSize;
  }
  get worldH() {
    return this.map.rows * this.map.tileSize;
  }

  /** Full geometry rebuild: a new map, seats, pathfinding grid and stairs. Characters keep their
   *  world position unless `setOfficeState` also decides to reseat them (a real layout change).
   *  `multiverse` is non-null exactly when this is the Multiverse floor (M8 8h). */
  private buildWorld(layout: OfficeLayout, style: OfficeStyle | typeof MULTIVERSE_THEME_ID, multiverse: MultiversePlan | null) {
    this.map = generateMap(layout);
    this.theme = getTheme(style);
    this.appliedStyle = style;
    this.multiversePlan = multiverse;
    this.regions = multiverse ? this.buildRegions(multiverse) : [];
    this.realmScopes = multiverse ? this.buildRealmScopes(multiverse) : new Map();
    this.finder = new PathFinder(this.map.walkable);
    this.seats = new SeatAllocator(this.map);
    this.renderVisuals();
    this.buildStairsInteractive();
    this.buildRealmZones();
    if (this.night) this.night.setSize(this.worldW, this.worldH);
  }

  private buildRegions(plan: MultiversePlan): ThemeRegion[] {
    return plan.realms.filter((r) => !r.overflow && r.style).map((r) => ({ rect: realmBlockRect(this.map, r), theme: getTheme(r.style!) }));
  }

  private buildRealmScopes(plan: MultiversePlan): Map<number, SeatScope> {
    const nexusCenter = { x: plan.nexus.x + Math.floor(plan.nexus.w / 2), y: plan.nexus.y + Math.floor(plan.nexus.h / 2) };
    const scopes = new Map<number, SeatScope>();
    for (const realm of plan.realms) {
      const roomIds = new Set(realm.roomIds);
      const rooms = this.map.rooms.filter((r) => roomIds.has(r.id));
      scopes.set(realm.index, { roomIds, types: new Set(rooms.map((r) => r.type)), gate: realmGate(this.map, realm, nexusCenter) });
    }
    return scopes;
  }

  /** Same geometry, new skin: repaint the texture, room decor and lighting only. Never reached on
   *  the Multiverse (its `layoutKey` includes the plan key, so any realm-set change is a `rebuild`). */
  private applySkin(style: OfficeStyle | typeof MULTIVERSE_THEME_ID) {
    this.theme = getTheme(style);
    this.appliedStyle = style;
    this.renderVisuals();
    this.refreshStairsAvailability();
  }

  private renderVisuals() {
    for (const o of this.worldLayer) o.destroy();
    this.worldLayer = [];
    const T = this.map.tileSize;
    renderGeneratedMap(this, this.map, this.theme, this.regions);
    this.worldLayer.push(this.add.image(0, 0, THEME_BASE_TEXTURE).setOrigin(0).setDepth(-10));

    if (this.multiversePlan) {
      // Room labels are hidden on the Multiverse (section 6.3) — the realm banners below replace them.
      for (const realm of this.multiversePlan.realms) {
        const label = this.add
          .text(realm.bannerAt.x * T + T / 2, realm.bannerAt.y * T + T, realm.name, {
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: '7px',
            color: '#ece6ff',
            backgroundColor: '#100c22cc',
            padding: { x: 3, y: 1.5 },
            resolution: 4,
          })
          .setOrigin(0.5, 1)
          .setDepth(50_000);
        label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
        this.worldLayer.push(label);
      }
    } else {
      for (const room of this.map.rooms) {
        if (room.type === 'hall') continue;
        const name = (room.name ?? this.theme.roomNames[room.type]).toUpperCase();
        const label = this.add
          .text(room.labelAt.x * T + 3, room.labelAt.y * T - 2, name, {
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: '6px',
            color: this.theme.palette.text,
            resolution: 4,
          })
          .setOrigin(0, 1)
          .setAlpha(0.6)
          .setDepth(1);
        label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
        this.worldLayer.push(label);
      }
    }

    this.refreshAmbient();

    // M8 8o: the light layer only needs the geometry/style this pass just (re)painted, plus
    // whatever `office.shaders` currently says — `this.state` is still unset on the very first
    // call (the `create()`-time `buildWorld`); `setOfficeState`'s own `applySettings` call below
    // seeds the light layer for real once settings exist.
    const shaders = this.state?.settings.office.shaders;
    if (shaders) this.postFx.setMap(this.map, shaders, this.appliedStyle!, prefersReducedMotion());
  }

  /** (Re)runs `theme.animate()` — used on a full `renderVisuals()` pass and, live, whenever
   *  `office.ambientEffects` changes (bug fix: it used to need a rebuild/reskin to take effect).
   *  On the Multiverse (`this.regions` non-empty), each realm's own theme animates its own map slice
   *  with no motes, and the base rift theme animates the whole map once with the global motes —
   *  section 6.2, budget split per `MULTIVERSE_LIMITS.maxAmbientObjects`. */
  private refreshAmbient() {
    for (const o of this.ambientLayer) o.destroy();
    const ambient = this.state?.settings.office.ambientEffects ?? true;
    if (this.regions.length) {
      const total = MULTIVERSE_LIMITS.maxAmbientObjects;
      const riftBudget = Math.floor(total / 3);
      const perRealm = Math.floor((total - riftBudget) / this.regions.length);
      const layer: Phaser.GameObjects.GameObject[] = [];
      for (const region of this.regions) {
        const slice = sliceMapForRect(this.map, region.rect);
        layer.push(...region.theme.animate(this, slice, { ambient, motes: false, budget: perRealm }));
      }
      layer.push(...this.theme.animate(this, this.map, { ambient, motes: true, budget: riftBudget }));
      this.ambientLayer = layer;
    } else {
      this.ambientLayer = this.theme.animate(this, this.map, { ambient });
    }
  }

  // ---------------------------------------------------------------- stairs

  private buildStairsInteractive() {
    for (const s of this.stairsSprites) {
      s.zone.destroy();
      s.ring.destroy();
    }
    this.stairsSprites = [];
    const T = this.map.tileSize;
    for (const spot of this.map.stairs) {
      const cx = spot.x * T + T / 2;
      const cy = spot.y * T + T / 2;
      const ring = this.add
        .circle(cx, cy, T * 0.55)
        .setStrokeStyle(2, spot.dir === 'up' ? 0x4ff0d0 : 0xb07aff, 0.9)
        .setDepth(spot.y * T + 3);
      const zone = this.add.zone(cx, cy, T, T).setDepth(spot.y * T + 4).setInteractive({ cursor: 'pointer' });
      zone.on('pointerover', () => this.hoverStairs(spot, ring));
      zone.on('pointerout', () => this.unhoverStairs(ring));
      zone.on('pointerup', () => {
        if (!this.inputLocked) this.events.emit('stairs', spot.dir);
      });
      this.stairsSprites.push({ spot, zone, ring });
    }
    this.refreshStairsAvailability();
  }

  private hoverStairs(spot: StairsSpot, ring: Phaser.GameObjects.Arc) {
    ring.setScale(1.15);
    const floor = this.state?.floor ?? null;
    const target = spot.dir === 'up' ? floor?.above : floor?.below;
    const text = floor === null ? 'Open the floor picker' : target ? `${spot.dir === 'up' ? 'Up to' : 'Down to'} ${target.label}` : 'No floor this way';
    this.tooltip.setText(text).setVisible(true);
  }

  private unhoverStairs(ring: Phaser.GameObjects.Arc) {
    ring.setScale(1);
    this.tooltip.setVisible(false);
  }

  /** Grey out a direction with no floor to reach; a floor with no `OfficeFloorInfo` at all (only
   *  the pre-M8 "All floors" view had this — the Multiverse always has one) leaves both lit. */
  private refreshStairsAvailability() {
    const floor = this.state?.floor ?? null;
    for (const { spot, ring } of this.stairsSprites) {
      const target = spot.dir === 'up' ? floor?.above : floor?.below;
      const enabled = floor === null || !!target;
      ring.setStrokeStyle(2, enabled ? (spot.dir === 'up' ? 0x4ff0d0 : 0xb07aff) : 0x666666, enabled ? 0.9 : 0.4);
    }
  }

  // ---------------------------------------------------------------- M8 8h: realm hit zones

  /** One static interactive zone per realm cell (section 6.3), rebuilt only on `buildWorld` — no
   *  per-frame work. Depth sits well below any character or stairs zone, so characters always win
   *  the hit test (Phaser's default `topOnly`) and a click on empty realm ground still travels. */
  private buildRealmZones() {
    for (const z of this.realmZoneSprites) {
      z.zone.destroy();
      z.outline.destroy();
    }
    this.realmZoneSprites = [];
    const plan = this.multiversePlan;
    if (!plan) return;
    const T = this.map.tileSize;
    for (const realm of plan.realms) {
      const { x, y, w, h } = realm.cell;
      const px = x * T;
      const py = y * T;
      const pw = w * T;
      const ph = h * T;
      const accent = !realm.overflow && realm.style ? getTheme(realm.style).palette.wallEdge : 0x9fd8ff;
      const outline = this.add.graphics().setDepth(-2).setVisible(false);
      const zone = this.add.zone(px + pw / 2, py + ph / 2, pw, ph).setDepth(-3).setInteractive({ cursor: 'pointer' });
      zone.on('pointerover', () => {
        outline.clear().lineStyle(2, accent, 0.85).strokeRect(px + 1, py + 1, pw - 2, ph - 2);
        outline.setVisible(true);
        this.tooltip.setText(realm.overflow ? `Open the floor picker · ${realm.name}` : `Travel to ${realm.name}`).setVisible(true);
      });
      zone.on('pointerout', () => {
        outline.setVisible(false);
        this.tooltip.setVisible(false);
      });
      zone.on('pointerup', () => {
        if (this.inputLocked || this.drag?.moved) return;
        this.events.emit('realmClick', realm.overflow ? null : (realm.projectIds[0] ?? null));
      });
      this.realmZoneSprites.push({ zone, outline });
    }
  }

  /**
   * The stairs transition (docs/design/guild-hall.md section 6): fade the camera out (with a
   * slight zoom-in and a 12px directional scroll), resolve so the caller can swap floors, then the
   * caller calls `finishTransition` to fade back in. Instant (no visual) under reduced motion or
   * `ms <= 0`. `dir` is which way the viewer is climbing, for the directional scroll only — omit it
   * for a jump that isn't "up" or "down" (e.g. the floor picker).
   */
  runTransition(ms: number, dir?: 'up' | 'down'): Promise<void> {
    this.inputLocked = true;
    const cam = this.cameras.main;
    // Saved so `finishTransition` can restore them instead of leaving the bump/nudge applied.
    this.preTransitionZoom = cam.zoom;
    this.preTransitionScrollY = cam.scrollY;
    if (prefersReducedMotion() || ms <= 0) return Promise.resolve();
    const half = Math.max(1, Math.floor(ms / 2));
    const c = this.theme.palette.transition;
    const shift = dir === 'up' ? -12 : dir === 'down' ? 12 : 0;
    this.tweens.add({
      targets: cam,
      zoom: cam.zoom * 1.06,
      scrollY: cam.scrollY + shift,
      duration: half,
      ease: 'Sine.easeIn',
      onUpdate: () => this.clampCamera(),
    });
    return new Promise((resolve) => {
      cam.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => resolve());
      cam.fadeOut(half, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
    });
  }

  /** Fades back in, restoring the zoom/scroll `runTransition` saved (from the opposite scroll
   *  offset, so the 12px nudge reads as a single continuous motion). `onComplete` fires once the
   *  fade-in has actually finished (immediately under reduced motion or `ms <= 0`) — the host uses
   *  it to release its own re-entrancy lock. */
  finishTransition(ms: number, dir?: 'up' | 'down', onComplete?: () => void) {
    this.inputLocked = false;
    const cam = this.cameras.main;
    const zoom = this.preTransitionZoom;
    const scrollY = this.preTransitionScrollY;
    this.preTransitionZoom = null;
    this.preTransitionScrollY = null;
    if (zoom !== null) cam.setZoom(zoom);
    if (prefersReducedMotion() || ms <= 0) {
      if (scrollY !== null) {
        cam.setScroll(cam.scrollX, scrollY);
        this.clampCamera();
      }
      onComplete?.();
      return;
    }
    const half = Math.max(1, Math.floor(ms / 2));
    if (scrollY !== null) {
      const shift = dir === 'up' ? -12 : dir === 'down' ? 12 : 0;
      cam.setScroll(cam.scrollX, scrollY - shift);
      this.clampCamera();
      this.tweens.add({ targets: cam, scrollY, duration: half, ease: 'Sine.easeOut', onUpdate: () => this.clampCamera() });
    }
    if (onComplete) cam.once(Phaser.Cameras.Scene2D.Events.FADE_IN_COMPLETE, onComplete);
    cam.fadeIn(half);
  }

  // ---------------------------------------------------------------- camera

  private setupCamera() {
    const cam = this.cameras.main;
    this.fitCamera();
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (this.inputLocked) return;
      this.drag = { x: p.x, y: p.y, sx: cam.scrollX, sy: cam.scrollY, moved: false };
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.drag || !p.isDown) return;
      const dx = p.x - this.drag.x;
      const dy = p.y - this.drag.y;
      if (!this.drag.moved && !isDragMove(dx, dy)) return;
      if (!this.drag.moved) this.cancelFollow();
      this.drag.moved = true;
      this.panned = true;
      cam.setScroll(this.drag.sx - dx / cam.zoom, this.drag.sy - dy / cam.zoom);
      this.clampCamera();
    });
    this.input.on('pointerup', (_p: Phaser.Input.Pointer, hitObjects: Phaser.GameObjects.GameObject[]) => {
      // A plain click (no drag) that hit nothing dismisses the panel; a click on a Character or a
      // realm zone is handled by its own listener (see attachCharacterHandlers/buildRealmZones),
      // which runs before this one.
      const wasEmptyClick = !!this.drag && !this.drag.moved && hitObjects.length === 0;
      this.drag = null;
      if (wasEmptyClick) this.events.emit('emptyClick');
    });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => {
      if (this.inputLocked) return;
      const oldZoom = cam.zoom;
      this.userZoom = Phaser.Math.Clamp(this.userZoom * (dy > 0 ? 0.88 : 1.12), 0.4, 6);
      const newZoom = this.targetZoom();
      cam.setZoom(newZoom);
      const { scrollX, scrollY } = zoomCameraAboutPoint({ pointerX: p.x, pointerY: p.y, scrollX: cam.scrollX, scrollY: cam.scrollY, oldZoom, newZoom, camWidth: cam.width, camHeight: cam.height });
      cam.setScroll(scrollX, scrollY);
      this.panned = true;
      this.clampCamera();
    });
  }

  private targetZoom() {
    const cam = this.cameras.main;
    const fit = Math.min(cam.width / this.worldW, cam.height / this.worldH);
    const cfg = this.state?.settings.office.zoom ?? 1;
    return Math.max(0.2, fit * cfg * this.userZoom);
  }

  fitCamera() {
    const cam = this.cameras.main;
    cam.setZoom(this.targetZoom());
    if (!this.panned) cam.centerOn(this.worldW / 2, this.worldH / 2);
    this.clampCamera();
  }

  resetView() {
    this.userZoom = 1;
    this.panned = false;
    this.fitCamera();
  }

  zoomBy(factor: number) {
    this.userZoom = Phaser.Math.Clamp(this.userZoom * factor, 0.4, 6);
    this.fitCamera();
  }

  /** Keep the map reachable: clamp so any tile can still be panned into the unobscured safe rect. */
  private clampCamera() {
    const cam = this.cameras.main;
    const { scrollX, scrollY } = clampScrollToSafeBounds(cam.scrollX, cam.scrollY, {
      camWidth: cam.width,
      camHeight: cam.height,
      zoom: cam.zoom,
      worldW: this.worldW,
      worldH: this.worldH,
      insets: this.insets,
    });
    cam.scrollX = scrollX;
    cam.scrollY = scrollY;
  }

  // -------------------------------------------------------------- safe region

  /** Called by the host whenever a floating overlay (the agent panel, ...) resizes or closes. */
  setSafeInsets(target: SafeInsets) {
    this.insetsTween?.remove();
    if (prefersReducedMotion()) {
      this.insets = { ...target };
      this.clampCamera();
      if (this.followId) this.recenterFollow(true);
      return;
    }
    const from = { ...this.insets };
    this.insetsTween = this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 220,
      ease: 'Sine.easeOut',
      onUpdate: (tw) => {
        const t = tw.getValue() ?? 1;
        this.insets = {
          top: Phaser.Math.Linear(from.top, target.top, t),
          right: Phaser.Math.Linear(from.right, target.right, t),
          bottom: Phaser.Math.Linear(from.bottom, target.bottom, t),
          left: Phaser.Math.Linear(from.left, target.left, t),
        };
        this.clampCamera();
        if (this.followId) this.recenterFollow(true);
      },
    });
  }

  /** Keep `agentId` centered in the safe rect while it moves; any manual drag cancels this. */
  setFollow(agentId: string | null) {
    this.followId = agentId;
    if (agentId) this.recenterFollow(prefersReducedMotion());
  }

  private cancelFollow() {
    if (!this.followId) return;
    this.followId = null;
    this.events.emit('followChanged', null);
  }

  private characterForAgent(agentId: string): Character | undefined {
    const key = this.agentIndex.get(agentId);
    return key ? this.characters.get(key) : undefined;
  }

  private recenterFollow(instant: boolean) {
    const c = this.followId ? this.characterForAgent(this.followId) : undefined;
    if (!c) {
      this.cancelFollow();
      return;
    }
    const cam = this.cameras.main;
    const target = centerInSafeRect(c.x, c.y - 8, cam.width, cam.height, cam.zoom, this.insets);
    if (instant) {
      cam.setScroll(target.scrollX, target.scrollY);
    } else {
      cam.scrollX = Phaser.Math.Linear(cam.scrollX, target.scrollX, 0.25);
      cam.scrollY = Phaser.Math.Linear(cam.scrollY, target.scrollY, 0.25);
    }
    this.clampCamera();
  }

  // ---------------------------------------------------------------- state

  private applyLighting() {
    if (!this.theme) return;
    const mode = this.state?.settings.office.theme ?? 'auto';
    const hour = new Date().getHours();
    const isNight = mode === 'night' || (mode === 'auto' && (hour >= 19 || hour < 7));
    const lighting = this.theme.lighting;
    this.night.setFillStyle(lighting.nightTint, isNight ? lighting.nightAlpha : 0);
  }

  setOfficeState(state: OfficeState) {
    const prevZoom = this.state?.settings.office.zoom;
    const prevAmbient = this.state?.settings.office.ambientEffects;
    this.state = state;
    const office = state.settings.office;
    const multiverse = state.multiverse;
    const effectiveStyle: OfficeStyle | typeof MULTIVERSE_THEME_ID = multiverse ? MULTIVERSE_THEME_ID : (state.layout.style ?? state.style);

    const layoutKey = `${state.layout.id}|${state.layout.updatedAt}|${multiverse?.key ?? ''}`;
    const rebuild = layoutKey !== this.layoutKey;
    const reskin = !rebuild && effectiveStyle !== this.appliedStyle;
    if (rebuild) {
      this.layoutKey = layoutKey;
      this.buildWorld(state.layout, effectiveStyle, multiverse);
    } else if (reskin) {
      this.applySkin(effectiveStyle);
    } else if (prevAmbient !== undefined && prevAmbient !== office.ambientEffects) {
      // Bug fix: the ambient toggle used to only take effect on the next rebuild/reskin. Refresh
      // just the theme's animated objects — no geometry rebuild — when only this flag changed.
      this.refreshAmbient();
    }
    this.refreshStairsAvailability();
    if (prevZoom !== office.zoom) this.fitCamera();
    this.applyLighting();
    this.postFx.applySettings(office.shaders, effectiveStyle);

    const instant = this.floorKey !== state.floorKey;
    if (instant) {
      for (const c of this.characters.values()) c.destroyAll();
      this.characters.clear();
      this.seats.clear();
      this.floorKey = state.floorKey;
    }

    this.updateCast(state, rebuild || instant);
    this.applyFocusDim();
    this.refreshLabels();
  }

  /**
   * The heart of M8 8b/8c/8h: resolves this frame's cast (once for a normal floor, once per
   * Multiverse realm with its own fair-share cap — section 6.3), then drives every tracked actor's
   * lifecycle (`game/actorLifecycle.ts`) and Phaser side effects (spawn/walk/rest/leave/rebind) from
   * whether its `ActorKey` is present this frame — see docs/design/living-office.md section 4.2.
   */
  private updateCast(state: OfficeState, forceReseat: boolean) {
    const office = state.settings.office;
    const heroesEnabled = state.settings.heroes.enabled;
    const now = Date.now();
    const heroById = new Map(state.heroes.map((h) => [h.id, h] as const));

    const { cast, realmIndexByKey, realmThemeByIndex } = this.buildCast(state, heroesEnabled, now);
    this.prevPrimary = cast.primary;
    const memberByKey = new Map(cast.members.map((m) => [m.key, m] as const));
    this.agentIndex = new Map(cast.members.map((m) => [m.agent.id, m.key] as const));

    const allKeys = new Set<ActorKey>([...this.characters.keys(), ...memberByKey.keys()]);
    const ambientForCharacters = office.ambientEffects && !prefersReducedMotion();

    for (const key of allKeys) {
      const member = memberByKey.get(key);
      const persistent = key.startsWith('hero:') || key.startsWith('gm:');
      const existing = this.characters.get(key);
      const prevFrame: LifecycleFrame | undefined = existing?.lifecycleFrame;
      const desired = desiredLifecycle(persistent, member, existing?.leaving ?? false);
      const next = nextLifecycle({ desired, prev: prevFrame, now, idleLeaveSec: office.idleLeaveSec });
      const cameFromRestOrLeave = !!prevFrame && prevFrame.state !== 'quest' && next.state === 'quest';

      let c = existing;
      const realmIdx = member ? realmIndexByKey.get(key) : (c?.realmIndex ?? undefined);
      const scope = realmIdx !== undefined ? this.realmScopes.get(realmIdx) : undefined;

      if (member) {
        if (!c) {
          c = new Character(this, key, 0, 0);
          this.attachCharacterHandlers(c);
          this.characters.set(key, c);
          c.teleport(this.map.spawn);
        }
        c.realmIndex = realmIdx ?? null;
        c.kind = member.kind;
        c.boundAgentId = member.agent.id;
        c.heroId = member.hero?.id ?? null;

        if (next.state === 'quest') {
          if (cameFromRestOrLeave) c.cancelLeave();
          c.setResting(false);
          const zone: Zone = member.agent.zone;
          const current = this.seats.get(key);
          const zoneChanged = !current || current.zone !== zone;
          if (forceReseat || cameFromRestOrLeave || zoneChanged) {
            this.seats.release(key);
            const seat = this.seats.assign(key, zone, scope);
            if (forceReseat && !cameFromRestOrLeave) {
              c.teleport(seat);
              c.setSeated(seat.seated);
            } else {
              this.walk(c, seat, seat.seated);
            }
          }
          const memberTheme = (realmIdx !== undefined ? realmThemeByIndex.get(realmIdx) : undefined) ?? this.theme;
          this.applyMemberLook(c, member, state, memberTheme, ambientForCharacters);
          if (member.kind === 'guild-master') {
            const projectId = key.slice('gm:'.length);
            c.setSessionsChip(member.sessionsChip ? { count: member.sessionsChip.count, attention: member.sessionsChip.attention } : null, () =>
              this.events.emit('gmSessions', projectId),
            );
          } else {
            c.setSessionsChip(null);
          }
        } else if (next.state === 'resting') {
          // Present in the cast but its agent finished (`done`): a hero/GM actor heads to the lounge
          // instead of vanishing (section 4.2's "done agent's hero actor goes to the lounge").
          this.enterResting(c, key, scope, heroById);
        }
        // else: 'leaving' — already fading from before it reappeared in the cast (as `done`); let
        // the fade finish rather than restart resting (`boundAgentId`/`heroId` above are already
        // current for whenever it's next rebound).
      } else if (c) {
        if (next.state === 'resting') {
          this.enterResting(c, key, scope, heroById);
        } else if (next.state === 'leaving' && !c.leaving) {
          this.seats.release(key);
          const target = scope?.gate ?? this.map.spawn;
          c.leave(this.finder.find(c.tile, target));
        }
        c.boundAgentId = null;
      }
      if (c) c.lifecycleFrame = next;
    }

    this.enforceCaps(office.maxCharacters, this.buildCapByRealm(state));

    for (const [key, c] of this.characters) if (c.gone) this.characters.delete(key);
    this.syncSelectedKey();
  }

  private buildCapByRealm(state: OfficeState): Map<number, number> | null {
    if (!state.multiverse) return null;
    return splitMultiverseCap(state.settings.office.multiverseMaxCharacters, state.multiverse.realms, state.agents);
  }

  /** Builds this frame's `Cast`: once for a normal floor, or merged across every Multiverse realm
   *  (each realm resolved independently with its own agents/heroes/sessions and fair-share cap, per
   *  section 6.3/7 — `resolveCast`'s own scope note). `pinnedPrimary` is seeded into the Guild
   *  Master hysteresis every call (the same convention `Roster`'s own `resolveCast` call uses). */
  private buildCast(
    state: OfficeState,
    heroesEnabled: boolean,
    now: number,
  ): { cast: Cast; realmIndexByKey: Map<ActorKey, number>; realmThemeByIndex: Map<number, ThemeDefinition> } {
    const office = state.settings.office;
    const castOffice = { pmMode: office.pmMode, pmSwitchCooldownSec: office.pmSwitchCooldownSec };
    const seededPrimary = new Map(this.prevPrimary);
    for (const [projectId, agentId] of Object.entries(state.pinnedPrimary)) seededPrimary.set(projectId, agentId);

    const plan = state.multiverse;
    if (!plan) {
      const cast = resolveCast({
        agents: state.agents,
        heroes: state.heroes,
        sessions: state.sessions,
        office: castOffice,
        heroesEnabled,
        prevPrimary: seededPrimary,
        now,
        maxCharacters: office.maxCharacters,
      });
      return { cast, realmIndexByKey: new Map(), realmThemeByIndex: new Map() };
    }

    const capByRealm = this.buildCapByRealm(state)!;
    const realmThemeByIndex = new Map<number, ThemeDefinition>();
    for (const realm of plan.realms) if (!realm.overflow && realm.style) realmThemeByIndex.set(realm.index, getTheme(realm.style));

    const members: CastMember[] = [];
    const hidden: string[] = [];
    const mergedPrimary = new Map(this.prevPrimary);
    const realmIndexByKey = new Map<ActorKey, number>();
    for (const realm of plan.realms) {
      const projectIds = new Set(realm.projectIds);
      const realmCast = resolveCast({
        agents: state.agents.filter((a) => projectIds.has(a.projectId)),
        heroes: state.heroes.filter((h) => projectIds.has(h.projectId)),
        sessions: state.sessions.filter((s) => projectIds.has(s.projectId)),
        office: castOffice,
        heroesEnabled,
        prevPrimary: seededPrimary,
        now,
        maxCharacters: capByRealm.get(realm.index) ?? 0,
      });
      for (const m of realmCast.members) {
        members.push(m);
        realmIndexByKey.set(m.key, realm.index);
      }
      hidden.push(...realmCast.hidden);
      for (const [pid, aid] of realmCast.primary) mergedPrimary.set(pid, aid);
    }
    return { cast: { members, primary: mergedPrimary, hidden }, realmIndexByKey, realmThemeByIndex };
  }

  /** Wires the pointer handlers a Character needs exactly once, at creation — everything they read
   *  (`boundAgentId`, `heroId`, `lifecycleFrame`) is mutable on the instance, so a rebind or a
   *  resting/on-quest switch needs no re-registration. */
  private attachCharacterHandlers(c: Character) {
    c.on('pointerup', () => {
      if (this.drag?.moved) return;
      if (c.lifecycleFrame.state === 'quest' && c.boundAgentId) this.events.emit('agentClick', c.boundAgentId);
      else if (c.heroId) this.events.emit('heroClick', c.heroId);
    });
    c.on('pointerover', () => this.setHovered(c.key));
    c.on('pointerout', () => this.setHovered(null));
  }

  /** Section 4.2: a resting actor walks to (and idles at) a lounge seat in its own realm, drawn at
   *  0.85 alpha with a dimmed "Resting · <name>" tag — entered either because its key left the cast,
   *  or because its bound agent finished while it's a persistent (hero/GM) actor. */
  private enterResting(c: Character, key: ActorKey, scope: SeatScope | undefined, heroById: ReadonlyMap<string, Hero>) {
    if (c.leaving) c.cancelLeave();
    const alreadyResting = c.lifecycleFrame.state === 'resting';
    c.setResting(true);
    if (!alreadyResting) {
      this.seats.release(key);
      const seat = this.seats.assign(key, 'lounge', scope);
      this.walk(c, seat, seat.seated);
      const name = (c.heroId && heroById.get(c.heroId)?.name) || (c.kind === 'guild-master' ? 'Guild Master' : 'Someone');
      c.setLook({ color: 0x8e8e9e, title: 'Resting', description: name, sprite: 0 }, true);
      c.setActivity('idle', 'active');
    }
  }

  /** Caps drawn actors (quest + resting) at `office.maxCharacters` on a normal floor, or at each
   *  realm's own fair share on the Multiverse (section 4.2's last bullet / section 6.3's cap): the
   *  longest-resting actor(s) over the cap are pushed into `leaving`; an on-quest actor is never evicted. */
  private enforceCaps(maxCharacters: number, capByRealm: Map<number, number> | null) {
    const groups = new Map<number | null, Character[]>();
    for (const c of this.characters.values()) {
      if (c.gone || c.leaving) continue;
      const g = capByRealm ? (c.realmIndex ?? null) : null;
      const list = groups.get(g);
      if (list) list.push(c);
      else groups.set(g, [c]);
    }
    for (const [g, list] of groups) {
      const cap = capByRealm ? (capByRealm.get(g ?? -1) ?? 0) : maxCharacters;
      const resting = list.filter((c) => c.lifecycleFrame.state === 'resting').sort((a, b) => (a.lifecycleFrame.restingSince ?? 0) - (b.lifecycleFrame.restingSince ?? 0));
      let over = list.length - cap;
      for (const c of resting) {
        if (over <= 0) break;
        this.seats.release(c.key);
        const scope = c.realmIndex !== null ? this.realmScopes.get(c.realmIndex) : undefined;
        c.leave(this.finder.find(c.tile, scope?.gate ?? this.map.spawn));
        c.lifecycleFrame = { state: 'leaving', restingSince: c.lifecycleFrame.restingSince };
        over--;
      }
    }
  }

  private applyMemberLook(c: Character, member: CastMember, state: OfficeState, theme: ThemeDefinition, ambientForCharacters: boolean) {
    const agent = member.agent;
    const role = state.roles.find((r) => r.name === agent.role);
    const color = parseColor(role?.color);
    const themedTitle = resolveTitle(theme, agent.role, role?.title ?? (agent.isMain ? 'PM' : agent.role));
    const hero = member.hero;
    const title = hero ? `${hero.name} · ${hero.title ?? themedTitle}` : themedTitle;
    c.setLook({ color, title, description: agent.isMain ? undefined : agent.description, sprite: role?.sprite ?? 0 }, true);

    const themeCostume = resolveCostume(theme, agent.role);
    if (hero) {
      const resolved = resolveHeroCostume(themeCostume, hero.appearance, color);
      c.setCostume(resolved.costume, color);
      c.setAppearance({ skin: resolved.skin, hair: resolved.hair, hairStyle: resolved.hairStyle });
    } else {
      c.setCostume(themeCostume, color);
      c.setAppearance(null);
    }
    c.setActivity(agent.activity, agent.status);
    c.setBubble(themedBubble(theme, agent.activity, agent.bubble, agent.currentTool), state.settings.office.bubbleSeconds, state.settings.office.showBubbles);
    c.setActivityFx(theme.activityFx?.[agent.activity], ambientForCharacters);
  }

  private walk(c: Character, to: Point, seated: boolean) {
    const path = this.finder.find(c.tile, to);
    if (path) c.walk(path, seated);
    else {
      c.teleport(to);
      c.setSeated(seated);
    }
  }

  // ---------------------------------------------------------------- M8 8d/8e: selection, hover, labels

  /** The agent whose drawer is open in the host UI (ROADMAP.md M8 8d) — glows, and everyone else
   *  dims by `office.focusDim`. `null` when the panel is closed. Looked up by agent id (the external
   *  contract), resolved internally to whichever `ActorKey` currently draws that agent. */
  setSelected(agentId: string | null) {
    if (this.selectedAgentId === agentId) return;
    this.selectedAgentId = agentId;
    this.syncSelectedKey();
  }

  private syncSelectedKey() {
    const key = this.selectedAgentId ? (this.agentIndex.get(this.selectedAgentId) ?? null) : null;
    if (key === this.selectedKey) return;
    if (this.selectedKey) this.characters.get(this.selectedKey)?.setSelected(false);
    this.selectedKey = key;
    if (key) this.characters.get(key)?.setSelected(true);
    this.applyFocusDim();
    this.refreshLabels();
  }

  private setHovered(key: ActorKey | null) {
    if (this.hoveredKey === key) return;
    if (this.hoveredKey) this.characters.get(this.hoveredKey)?.setHovered(false);
    this.hoveredKey = key;
    if (key) this.characters.get(key)?.setHovered(true);
    this.refreshLabels();
  }

  /** `office.focusDim` (0 disables): every character but the selected one dims while a drawer is open. */
  private applyFocusDim() {
    const dim = this.state?.settings.office.focusDim ?? 0.35;
    const alpha = this.selectedKey ? 1 - dim : 1;
    for (const [key, c] of this.characters) c.setDim(key === this.selectedKey ? 1 : alpha);
  }

  /**
   * Bubble/name-tag declutter (ROADMAP.md M8 8e): zoom-based level of detail
   * (`office.labelMinZoom`) hides everyone's tag/bubble but the selected/waiting/hovered
   * characters', then `layoutLabels` places the remaining bubbles with greedy collision avoidance,
   * capped at `office.maxBubbles` (extras collapse to a small "…" badge). Throttled via
   * `LABEL_REFRESH_MS` from `update()`, and also run immediately on anything that changes who's
   * important (selection, hover, a fresh `setOfficeState`).
   */
  private refreshLabels() {
    const office = this.state?.settings.office;
    if (!office) return;
    const zoom = this.cameras.main.zoom;
    const scale = counterScale(zoom);
    const subjects: LabelSubject[] = [];
    for (const [key, c] of this.characters) {
      if (c.leaving) continue;
      c.setLabelScale(scale);
      const waiting = c.isWaiting;
      const important = key === this.selectedKey || waiting || key === this.hoveredKey;
      const visible = labelVisible({ zoom, minZoom: office.labelMinZoom, important });
      c.setTagVisible(visible);
      c.setBubbleLod(visible);
      if (!visible || !c.hasBubble) continue;
      subjects.push({
        id: key,
        anchor: c.labelAnchor,
        box: c.bubbleSize,
        selected: key === this.selectedKey,
        waiting,
        recency: c.boundAgentId ? (this.state?.agents.find((a) => a.id === c.boundAgentId)?.updatedAt ?? 0) : 0,
      });
    }
    for (const p of layoutLabels(subjects, { maxBubbles: office.maxBubbles })) {
      this.characters.get(p.id as ActorKey)?.setLabelPlacement(p.dx, p.dy, p.leader, p.collapsed);
    }
  }

  /** Smoothly pan (or jump, under reduced motion) so the agent's actor is centered in the safe rect. */
  focusAgent(id: string) {
    const c = this.characterForAgent(id);
    if (!c) return;
    this.panned = true;
    const cam = this.cameras.main;
    const target = centerInSafeRect(c.x, c.y - 8, cam.width, cam.height, cam.zoom, this.insets);
    if (prefersReducedMotion()) {
      cam.setScroll(target.scrollX, target.scrollY);
      this.clampCamera();
      return;
    }
    this.tweens.add({
      targets: cam,
      scrollX: target.scrollX,
      scrollY: target.scrollY,
      duration: 400,
      ease: 'Sine.easeInOut',
      onUpdate: () => this.clampCamera(),
    });
  }

  update(time: number, delta: number) {
    this.postFx.sampleFrame(delta);
    const speed = this.state?.settings.office.walkSpeed ?? 120;
    for (const [key, c] of this.characters) {
      c.update(time, delta, speed);
      if (c.gone) {
        c.destroyAll();
        this.characters.delete(key);
      }
    }
    if (this.followId) this.recenterFollow(false);
    this.labelTimer -= delta;
    if (this.labelTimer <= 0) {
      this.labelTimer = LABEL_REFRESH_MS;
      this.refreshLabels();
    }
  }
}
