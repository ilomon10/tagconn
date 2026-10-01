import * as Phaser from 'phaser';
import { hitScaleFor } from '../camera/hitsize';
import { createSeenStore, triggerTooltip, triggersOf } from '../furnitureTriggers';
import type { FurnitureAction, GeneratedMap, PlacedFurniture } from '../procgen/types';
import type { ThemeDefinition } from '../themes/types';

/** What the scene gives the layer (docs/design/game-office.md section 4.2). The layer imports no OfficeScene internals. */
export interface TriggerHost {
  showTooltip(text: string): void;
  hideTooltip(): void;
  /** False while inputLocked, mid-drag, pinching or pressing the edge arrow (same guard as OfficeScene's click handlers). */
  canClick(): boolean;
  emit(action: FurnitureAction): void;
  reducedMotion(): boolean;
  /** The style an item is drawn in (the realm's inside a Multiverse realm block); default: the layer's style. */
  styleFor?(f: PlacedFurniture): ThemeDefinition['id'];
}

const RING_COLOR = 0xf3c94d;
const RING_DEPTH = 0.5;
/** Above realm zones (-3), below characters; stairs zones sit at -1 so they never tie. */
const TRIGGER_DEPTH = -1.5;
const PULSE_THROTTLE_MS = 500;
const PULSE_MS = 600;
const PULSE_COUNT = 3;
const STATIC_RING_MS = 2000;

interface Entry {
  furniture: PlacedFurniture;
  zone: Phaser.GameObjects.Zone;
  /** Shown on hover. Drawn around (0,0) and positioned at the footprint centre, so a scale pulses from the middle. */
  ring: Phaser.GameObjects.Graphics;
  pulse: Phaser.GameObjects.Graphics;
  baseW: number;
  baseH: number;
  tween: Phaser.Tweens.Tween | null;
  timer: Phaser.Time.TimerEvent | null;
  hovered: boolean;
}

export class FurnitureTriggerLayer {
  private entries: Entry[] = [];
  private styleId: ThemeDefinition['id'] = 'modern';
  private enabled = true;
  private lastCheck = Number.NEGATIVE_INFINITY;
  private zoom = 1;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly host: TriggerHost,
    private readonly seen: ReturnType<typeof createSeenStore> = createSeenStore(),
  ) {}

  /** Destroy + recreate zones and rings for `triggersOf(map)`. Called from buildWorld. */
  build(map: GeneratedMap, styleId: ThemeDefinition['id'], enabled: boolean): void {
    this.clear();
    this.styleId = styleId;
    this.enabled = enabled;
    const T = map.tileSize;
    for (const f of triggersOf(map)) {
      const action = f.trigger!;
      const w = f.w * T;
      const h = f.h * T;
      const cx = f.x * T + w / 2;
      const cy = f.y * T + h / 2;
      const entry: Entry = {
        furniture: f,
        zone: this.scene.add.zone(cx, cy, w, h).setDepth(TRIGGER_DEPTH),
        ring: this.makeRing(cx, cy, w, h).setVisible(false),
        pulse: this.makeRing(cx, cy, w, h).setVisible(false),
        baseW: w,
        baseH: h,
        tween: null,
        timer: null,
        hovered: false,
      };
      entry.zone.on('pointerover', () => {
        entry.hovered = true;
        entry.ring.setVisible(true);
        this.host.showTooltip(triggerTooltip(this.styleOf(f), action));
      });
      entry.zone.on('pointerout', () => this.unhover(entry));
      entry.zone.on('pointerup', () => {
        if (!this.host.canClick()) return;
        this.host.hideTooltip();
        this.host.emit(action);
      });
      this.entries.push(entry);
    }
    this.setEnabled(enabled);
    this.updateHitSizes(this.zoom);
  }

  /** Reskin: tooltips only (geometry unchanged). */
  setStyle(styleId: ThemeDefinition['id']): void {
    this.styleId = styleId;
    for (const e of this.entries) {
      if (e.hovered) this.host.showTooltip(triggerTooltip(this.styleOf(e.furniture, styleId), e.furniture.trigger!));
    }
  }

  /** `office.furnitureTriggers`: hides rings and disables zones, live. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const e of this.entries) {
      if (enabled) {
        e.zone.setInteractive({ cursor: 'pointer' });
      } else {
        const wasHovered = e.hovered;
        e.zone.disableInteractive();
        this.unhover(e);
        if (wasHovered) this.host.hideTooltip();
        this.stopPulse(e);
      }
    }
  }

  /** Keep each zone >= the WCAG 2.5.8 target (size * hitScaleFor, like OfficeScene.updateZoneHitSizes). */
  updateHitSizes(zoom: number): void {
    this.zoom = zoom;
    for (const e of this.entries) {
      const scale = hitScaleFor(Math.min(e.baseW, e.baseH), zoom);
      e.zone.setSize(e.baseW * scale, e.baseH * scale);
    }
  }

  /** 500 ms throttle: first-seen pulse for triggers inside cam.worldView. */
  update(time: number, cam: Phaser.Cameras.Scene2D.Camera): void {
    if (!this.enabled || this.entries.length === 0 || time - this.lastCheck < PULSE_THROTTLE_MS) return;
    this.lastCheck = time;
    const view = cam.worldView;
    for (const e of this.entries) {
      const action = e.furniture.trigger!;
      if (e.tween || e.timer || this.seen.has(action)) continue;
      if (view.contains(e.zone.x, e.zone.y)) this.startPulse(e, action);
    }
  }

  destroy(): void {
    this.clear();
  }

  private styleOf(f: PlacedFurniture, fallback: ThemeDefinition['id'] = this.styleId): ThemeDefinition['id'] {
    return this.host.styleFor?.(f) ?? fallback;
  }

  private makeRing(cx: number, cy: number, w: number, h: number): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics().setDepth(RING_DEPTH).setPosition(cx, cy);
    g.lineStyle(1, RING_COLOR, 1);
    g.strokeRoundedRect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2, 3);
    return g;
  }

  private unhover(e: Entry): void {
    if (!e.hovered) return;
    e.hovered = false;
    e.ring.setVisible(false);
    this.host.hideTooltip();
  }

  private startPulse(e: Entry, action: FurnitureAction): void {
    e.pulse.setVisible(true).setAlpha(1).setScale(1);
    if (this.host.reducedMotion()) {
      e.timer = this.scene.time.delayedCall(STATIC_RING_MS, () => {
        e.timer = null;
        e.pulse.setVisible(false);
        this.seen.mark(action);
      });
      return;
    }
    e.tween = this.scene.tweens.add({
      targets: e.pulse,
      scale: { from: 1, to: 1.25 },
      alpha: { from: 1, to: 0 },
      duration: PULSE_MS,
      repeat: PULSE_COUNT - 1,
      onComplete: () => {
        e.tween = null;
        e.pulse.setVisible(false);
        this.seen.mark(action);
      },
    });
  }

  private stopPulse(e: Entry): void {
    e.tween?.remove();
    e.tween = null;
    e.timer?.remove(false);
    e.timer = null;
    e.pulse.setVisible(false);
  }

  private clear(): void {
    if (this.entries.some((e) => e.hovered)) this.host.hideTooltip();
    for (const e of this.entries) {
      this.stopPulse(e);
      e.zone.destroy();
      e.ring.destroy();
      e.pulse.destroy();
    }
    this.entries = [];
  }
}
