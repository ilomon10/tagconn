import * as Phaser from 'phaser';
import { DEFAULT_LAYOUT, type Agent, type OfficeLayout, type OfficeStyle, type Role, type Settings, type Zone } from '@tagconn/shared';
import { generateMap } from '../procgen';
import type { GeneratedMap, Point, StairsSpot } from '../procgen/types';
import { PathFinder } from '../pathfinding';
import { SeatAllocator } from '../seats';
import { Character } from '../actors/Character';
import { generateTextures } from '../textures';
import { resolveCostume, resolveTitle } from '../lookResolver';
import { getTheme, paintCostumeTextures, prefersReducedMotion, renderGeneratedMap, themedBubble, THEME_BASE_TEXTURE, type ThemeDefinition } from '../themes';
import { ZERO_INSETS, centerInSafeRect, clampScrollToSafeBounds, type SafeInsets } from '../camera/insets';
import { zoomCameraAboutPoint } from '../camera/zoom';
import { isDragMove } from '../camera/drag';
import { counterScale, labelVisible, layoutLabels, type LabelSubject } from '../labels';

/** M8 8e: how often the bubble/label layout (`game/labels`) is recomputed — a throttle, not every
 *  frame, since it's a many-subject greedy placement and labels don't need to react per-pixel. */
const LABEL_REFRESH_MS = 120;

/** A neighboring floor reachable by the stairs, with its display label pre-formatted by the theme. */
export interface OfficeFloorNeighbor {
  id: string;
  label: string;
}

/**
 * Where the current floor sits in the stairs order (docs/design/guild-hall.md section 6). `null`
 * in "All floors" mode: there is no single floor to move relative to, and stairs open the picker.
 */
export interface OfficeFloorInfo {
  index: number;
  count: number;
  above?: OfficeFloorNeighbor;
  below?: OfficeFloorNeighbor;
}

export interface OfficeState {
  agents: Agent[];
  settings: Settings;
  roles: Role[];
  /** Changing floors swaps the cast instantly instead of walking everyone out. */
  floorKey: string;
  layout: OfficeLayout;
  /** Resolved style: `layout.style` wins over `settings.office.style`. */
  style: OfficeStyle;
  floor: OfficeFloorInfo | null;
}

const parseColor = (c: string | undefined, fallback = 0x8e8e9e) => {
  const n = c && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : NaN;
  return Number.isNaN(n) ? fallback : n;
};

/** Main-session first, then by start time — decides who gets on the floor when over maxCharacters. */
export function visibleAgents(agents: Agent[], max: number): Agent[] {
  return [...agents].sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.startedAt - b.startedAt).slice(0, Math.max(0, max));
}

interface StairsSprite {
  spot: StairsSpot;
  zone: Phaser.GameObjects.Zone;
  ring: Phaser.GameObjects.Arc;
}

export class OfficeScene extends Phaser.Scene {
  private map!: GeneratedMap;
  private theme!: ThemeDefinition;
  private finder!: PathFinder;
  private seats!: SeatAllocator;
  /** Static world art (base texture, room labels) — rebuilt on any geometry or style change and
   *  never touched by anything else. */
  private worldLayer: Phaser.GameObjects.GameObject[] = [];
  /** `theme.animate()`'s objects (torches, motes, ...) — split out from `worldLayer` so toggling
   *  `office.ambientEffects` can refresh just these live, without a geometry rebuild (bug: it used
   *  to take effect only after the next rebuild/reskin). */
  private ambientLayer: Phaser.GameObjects.GameObject[] = [];
  private stairsSprites: StairsSprite[] = [];
  private tooltip!: Phaser.GameObjects.Text;
  private characters = new Map<string, Character>();
  private night!: Phaser.GameObjects.Rectangle;
  private state?: OfficeState;
  /** `layout.id + updatedAt` — a full geometry rebuild only happens when this changes (D2: a style
   *  switch alone re-skins the same geometry, so seats and characters never move). */
  private layoutKey = '';
  private appliedStyle: OfficeStyle | null = null;
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
   *  (subtle highlight + expands a collapsed bubble badge). */
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  /** Countdown to the next throttled `refreshLabels()` pass (M8 8e); `<= 0` due next `update()`. */
  private labelTimer = 0;
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
    this.buildWorld(DEFAULT_LAYOUT, 'guild');
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
   *  world position unless `setOfficeState` also decides to reseat them (a real layout change). */
  private buildWorld(layout: OfficeLayout, style: OfficeStyle) {
    this.map = generateMap(layout);
    this.theme = getTheme(style);
    this.appliedStyle = style;
    this.finder = new PathFinder(this.map.walkable);
    this.seats = new SeatAllocator(this.map);
    this.renderVisuals();
    this.buildStairsInteractive();
    if (this.night) this.night.setSize(this.worldW, this.worldH);
  }

  /** Same geometry, new skin: repaint the texture, room decor and lighting only. */
  private applySkin(style: OfficeStyle) {
    this.theme = getTheme(style);
    this.appliedStyle = style;
    this.renderVisuals();
    this.refreshStairsAvailability();
  }

  private renderVisuals() {
    for (const o of this.worldLayer) o.destroy();
    this.worldLayer = [];
    const T = this.map.tileSize;
    renderGeneratedMap(this, this.map, this.theme);
    this.worldLayer.push(this.add.image(0, 0, THEME_BASE_TEXTURE).setOrigin(0).setDepth(-10));

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

    this.refreshAmbient();
  }

  /** (Re)runs `theme.animate()` alone — used on a full `renderVisuals()` pass and, live, whenever
   *  `office.ambientEffects` changes (bug fix: it used to need a rebuild/reskin to take effect). */
  private refreshAmbient() {
    for (const o of this.ambientLayer) o.destroy();
    const ambient = this.state?.settings.office.ambientEffects ?? true;
    this.ambientLayer = this.theme.animate(this, this.map, { ambient });
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

  /** Grey out a direction with no floor to reach; "All floors" mode leaves both lit (they open the picker). */
  private refreshStairsAvailability() {
    const floor = this.state?.floor ?? null;
    for (const { spot, ring } of this.stairsSprites) {
      const target = spot.dir === 'up' ? floor?.above : floor?.below;
      const enabled = floor === null || !!target;
      ring.setStrokeStyle(2, enabled ? (spot.dir === 'up' ? 0x4ff0d0 : 0xb07aff) : 0x666666, enabled ? 0.9 : 0.4);
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
      // A plain click (no drag) that hit nothing dismisses the panel; a click on a Character is
      // handled by its own listener (see setOfficeState), which runs before this one.
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

  private recenterFollow(instant: boolean) {
    const c = this.followId ? this.characters.get(this.followId) : undefined;
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
    const effectiveStyle = state.layout.style ?? state.style;

    const layoutKey = `${state.layout.id}|${state.layout.updatedAt}`;
    const rebuild = layoutKey !== this.layoutKey;
    const reskin = !rebuild && effectiveStyle !== this.appliedStyle;
    if (rebuild) {
      this.layoutKey = layoutKey;
      this.buildWorld(state.layout, effectiveStyle);
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

    const instant = this.floorKey !== state.floorKey;
    if (instant) {
      for (const c of this.characters.values()) c.destroyAll();
      this.characters.clear();
      this.seats.clear();
      this.floorKey = state.floorKey;
    }

    const shown = visibleAgents(state.agents, office.maxCharacters);
    const ids = new Set(shown.map((a) => a.id));
    for (const [id, c] of this.characters) {
      if (!ids.has(id) && !c.leaving) this.sendHome(c);
    }

    const ambientForCharacters = office.ambientEffects && !prefersReducedMotion();
    for (const agent of shown) {
      let c = this.characters.get(agent.id);
      const role = state.roles.find((r) => r.name === agent.role);
      const zone: Zone = agent.status === 'done' ? 'entrance' : agent.zone;
      if (c?.leaving) {
        // Came back (e.g. re-shown after a floor filter change): replace it.
        c.destroyAll();
        this.characters.delete(agent.id);
        c = undefined;
      }
      if (!c) {
        c = new Character(this, agent.id, 0, 0);
        c.on('pointerup', () => {
          if (!this.drag?.moved) this.events.emit('agentClick', agent.id);
        });
        // M8 8d: subtle hover highlight, and it also expands a collapsed ("…" badge) bubble.
        c.on('pointerover', () => this.setHovered(agent.id));
        c.on('pointerout', () => this.setHovered(null));
        c.setSelected(agent.id === this.selectedId);
        this.characters.set(agent.id, c);
        const seat = this.seats.assign(agent.id, zone);
        if (instant || rebuild) c.teleport(seat);
        else {
          c.teleport(this.map.spawn);
          this.walk(c, seat, seat.seated);
        }
        c.setSeated(seat.seated);
      } else if (rebuild) {
        this.seats.release(agent.id);
        const seat = this.seats.assign(agent.id, zone);
        c.teleport(seat);
        c.setSeated(seat.seated);
      } else {
        const current = this.seats.get(agent.id);
        if (!current || current.zone !== zone) {
          const seat = this.seats.assign(agent.id, zone);
          this.walk(c, seat, seat.seated);
        }
      }
      const color = parseColor(role?.color);
      c.setLook(
        {
          color,
          title: resolveTitle(this.theme, agent.role, role?.title ?? (agent.isMain ? 'PM' : agent.role)),
          description: agent.isMain ? undefined : agent.description,
          sprite: role?.sprite ?? 0,
        },
        true,
      );
      c.setCostume(resolveCostume(this.theme, agent.role), color);
      c.setActivity(agent.activity, agent.status);
      c.setBubble(themedBubble(this.theme, agent.activity, agent.bubble, agent.currentTool), office.bubbleSeconds, office.showBubbles);
      c.setActivityFx(this.theme.activityFx?.[agent.activity], ambientForCharacters);
    }
    this.applyFocusDim();
    this.refreshLabels();
  }

  private walk(c: Character, to: Point, seated: boolean) {
    const path = this.finder.find(c.tile, to);
    if (path) c.walk(path, seated);
    else {
      c.teleport(to);
      c.setSeated(seated);
    }
  }

  private sendHome(c: Character) {
    this.seats.release(c.agentId);
    c.leave(this.finder.find(c.tile, this.map.spawn));
  }

  // ---------------------------------------------------------------- M8 8d/8e: selection, hover, labels

  /** The agent whose drawer is open in the host UI (ROADMAP.md M8 8d) — glows, and everyone else
   *  dims by `office.focusDim`. `null` when the panel is closed. */
  setSelected(id: string | null) {
    if (this.selectedId === id) return;
    if (this.selectedId) this.characters.get(this.selectedId)?.setSelected(false);
    this.selectedId = id;
    if (id) this.characters.get(id)?.setSelected(true);
    this.applyFocusDim();
    this.refreshLabels();
  }

  private setHovered(id: string | null) {
    if (this.hoveredId === id) return;
    if (this.hoveredId) this.characters.get(this.hoveredId)?.setHovered(false);
    this.hoveredId = id;
    if (id) this.characters.get(id)?.setHovered(true);
    this.refreshLabels();
  }

  /** `office.focusDim` (0 disables): every character but the selected one dims while a drawer is open. */
  private applyFocusDim() {
    const dim = this.state?.settings.office.focusDim ?? 0.35;
    const alpha = this.selectedId ? 1 - dim : 1;
    for (const [id, c] of this.characters) c.setDim(id === this.selectedId ? 1 : alpha);
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
    const agentsById = new Map(this.state?.agents.map((a) => [a.id, a]) ?? []);
    const subjects: LabelSubject[] = [];
    for (const [id, c] of this.characters) {
      if (c.leaving) continue;
      c.setLabelScale(scale);
      const waiting = c.isWaiting;
      const important = id === this.selectedId || waiting || id === this.hoveredId;
      const visible = labelVisible({ zoom, minZoom: office.labelMinZoom, important });
      c.setTagVisible(visible);
      c.setBubbleLod(visible);
      if (!visible || !c.hasBubble) continue;
      subjects.push({
        id,
        anchor: c.labelAnchor,
        box: c.bubbleSize,
        selected: id === this.selectedId,
        waiting,
        recency: agentsById.get(id)?.updatedAt ?? 0,
      });
    }
    for (const p of layoutLabels(subjects, { maxBubbles: office.maxBubbles })) {
      this.characters.get(p.id)?.setLabelPlacement(p.dx, p.dy, p.leader, p.collapsed);
    }
  }

  /** Smoothly pan (or jump, under reduced motion) so `id` is centered in the unobscured safe rect. */
  focusAgent(id: string) {
    const c = this.characters.get(id);
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
    const speed = this.state?.settings.office.walkSpeed ?? 120;
    for (const [id, c] of this.characters) {
      c.update(time, delta, speed);
      if (c.gone) {
        c.destroyAll();
        this.characters.delete(id);
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
