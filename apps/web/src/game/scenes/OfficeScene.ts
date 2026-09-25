import * as Phaser from 'phaser';
import { ZONES, type Agent, type Role, type Settings, type Zone } from '@tagconn/shared';
import { buildOfficeMap, type OfficeMap, type Point } from '../map/officeMap';
import { BASE_TEXTURE, renderMap } from '../map/renderMap';
import { PathFinder } from '../pathfinding';
import { SeatAllocator } from '../seats';
import { Character } from '../actors/Character';
import { generateTextures } from '../textures';
import { prefersReducedMotion } from '../themes/fx';
import { ZERO_INSETS, centerInSafeRect, clampScrollToSafeBounds, type SafeInsets } from '../camera/insets';
import { zoomAboutPoint } from '../camera/zoom';
import { isDragMove } from '../camera/drag';

export interface OfficeState {
  agents: Agent[];
  settings: Settings;
  roles: Role[];
  /** Changing floors swaps the cast instantly instead of walking everyone out. */
  floorKey: string;
}

export const ZONE_LABELS: Record<Zone, string> = {
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

const parseColor = (c: string | undefined, fallback = 0x8e8e9e) => {
  const n = c && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : NaN;
  return Number.isNaN(n) ? fallback : n;
};

/** Main-session first, then by start time — decides who gets on the floor when over maxCharacters. */
export function visibleAgents(agents: Agent[], max: number): Agent[] {
  return [...agents].sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.startedAt - b.startedAt).slice(0, Math.max(0, max));
}

export class OfficeScene extends Phaser.Scene {
  private map!: OfficeMap;
  private finder!: PathFinder;
  private seats!: SeatAllocator;
  private worldLayer: Phaser.GameObjects.GameObject[] = [];
  private characters = new Map<string, Character>();
  private night!: Phaser.GameObjects.Rectangle;
  private leds: { g: Phaser.GameObjects.Rectangle; rate: number; phase: number }[] = [];
  private screens: Phaser.GameObjects.Rectangle[] = [];
  private state?: OfficeState;
  private zonesKey = '';
  private floorKey: string | null = null;
  private userZoom = 1;
  private panned = false;
  private drag: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
  private themeTimer?: Phaser.Time.TimerEvent;
  /** The safe-region insets currently applied to the camera (animated toward whatever React last reported). */
  private insets: SafeInsets = { ...ZERO_INSETS };
  private insetsTween?: Phaser.Tweens.Tween;
  /** Agent id the camera keeps centered while it moves, or null when nothing is being followed. */
  private followId: string | null = null;
  private endDragOnBlur = () => {
    this.drag = null;
  };

  constructor(private onReady?: (scene: OfficeScene) => void) {
    super('office');
  }

  create() {
    generateTextures(this);
    this.cameras.main.setBackgroundColor('#15121e');
    this.buildWorld({});
    this.night = this.add.rectangle(0, 0, this.worldW, this.worldH, 0x0b1030, 0).setOrigin(0).setDepth(90_000);
    this.setupCamera();
    this.themeTimer = this.time.addEvent({ delay: 60_000, loop: true, callback: () => this.applyTheme() });
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

  private buildWorld(zones: Record<string, unknown>) {
    for (const o of this.worldLayer) o.destroy();
    this.worldLayer = [];
    this.leds = [];
    this.screens = [];
    this.map = buildOfficeMap(zones);
    this.finder = new PathFinder(this.map.walkable);
    this.seats = new SeatAllocator(this.map);
    const T = this.map.tileSize;
    renderMap(this, this.map);
    this.worldLayer.push(this.add.image(0, 0, BASE_TEXTURE).setOrigin(0).setDepth(-10));

    for (const zone of ZONES) {
      const r = this.map.zones[zone].rect;
      const label = this.add
        .text(r.x * T + 3, (r.y + r.h) * T - 2, ZONE_LABELS[zone].toUpperCase(), {
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontSize: '6px',
          color: '#f3e9d2',
          resolution: 4,
        })
        .setOrigin(0, 1)
        .setAlpha(0.6)
        .setDepth(1);
      label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
      this.worldLayer.push(label);
    }

    // Small animated details: rack LEDs, monitor glow, coffee steam.
    for (const f of this.map.furniture) {
      if (f.kind === 'rack') {
        for (let y = f.y * T + 3; y < (f.y + f.h) * T - 3; y += 4) {
          const colors = [0x6cf08a, 0x4ab5ff, 0xffc34a];
          const led = this.add.rectangle(f.x * T + 4 + ((y / 4) % 3) * 3, y, 1, 1, colors[(y / 4) % 3]!).setOrigin(0).setDepth(-4);
          this.leds.push({ g: led, rate: 1.5 + Math.random() * 4, phase: Math.random() * 10 });
          this.worldLayer.push(led);
        }
      }
      if (f.kind === 'desk') {
        for (let i = 0; i < f.w; i++) {
          const s = this.add.rectangle((f.x + i) * T + 4, f.y * T - 2, 8, 5, 0xbfe6ff, 0).setOrigin(0).setDepth(-4);
          this.screens.push(s);
          this.worldLayer.push(s);
        }
      }
      if (f.kind === 'coffee') {
        const steam = this.add.rectangle(f.x * T + 8, f.y * T + 8, 1, 3, 0xffffff, 0.5).setDepth(-4);
        this.tweens.add({ targets: steam, y: f.y * T + 2, alpha: 0, duration: 1600, repeat: -1 });
        this.worldLayer.push(steam);
      }
    }
    if (this.night) this.night.setSize(this.worldW, this.worldH);
  }

  // ---------------------------------------------------------------- camera

  private setupCamera() {
    const cam = this.cameras.main;
    this.fitCamera();
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
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
      const oldZoom = cam.zoom;
      this.userZoom = Phaser.Math.Clamp(this.userZoom * (dy > 0 ? 0.88 : 1.12), 0.4, 6);
      const newZoom = this.targetZoom();
      cam.setZoom(newZoom);
      const { scrollX, scrollY } = zoomAboutPoint({ pointerX: p.x, pointerY: p.y, scrollX: cam.scrollX, scrollY: cam.scrollY, oldZoom, newZoom });
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

  private applyTheme() {
    const theme = this.state?.settings.office.theme ?? 'auto';
    const hour = new Date().getHours();
    const isNight = theme === 'night' || (theme === 'auto' && (hour >= 19 || hour < 7));
    this.night.setFillStyle(0x0b1030, isNight ? 0.42 : 0);
    for (const s of this.screens) s.setFillStyle(0xbfe6ff, isNight ? 0.35 : 0);
  }

  setOfficeState(state: OfficeState) {
    const prevZoom = this.state?.settings.office.zoom;
    this.state = state;
    const office = state.settings.office;

    const zonesKey = JSON.stringify(office.zones ?? {});
    const rebuild = zonesKey !== this.zonesKey;
    if (rebuild) {
      this.zonesKey = zonesKey;
      this.buildWorld(office.zones ?? {});
    }
    if (prevZoom !== office.zoom) this.fitCamera();
    this.applyTheme();

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
      c.setLook(
        {
          color: parseColor(role?.color),
          title: role?.title ?? (agent.isMain ? 'PM' : agent.role),
          description: agent.isMain ? undefined : agent.description,
          sprite: role?.sprite ?? 0,
        },
        true,
      );
      c.setActivity(agent.activity, agent.status);
      c.setBubble(agent.bubble, office.bubbleSeconds, office.showBubbles);
    }
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
    const t = time / 1000;
    for (const l of this.leds) l.g.setAlpha(Math.sin(t * l.rate + l.phase) > -0.2 ? 1 : 0.15);
  }
}
