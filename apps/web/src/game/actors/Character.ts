import * as Phaser from 'phaser';
import type { Activity, AgentStatus } from '@tagconn/shared';
import type { ActorKey } from '../cast';
import { INITIAL_LIFECYCLE, type LifecycleFrame } from '../actorLifecycle';
import { DIZZY_FRAMES, EMOTE_ICON, STRAIN_ICON } from '../drama';
import type { Point } from '../procgen/types';
import type { Size } from '../labels';
import { HAIR_COLORS, HAIR_STYLES, SKIN_TONES } from '../textures';
import { CLOAK_TEXTURE, GOGGLES_TEXTURE, createActivityFx, hatTextureKey, prefersReducedMotion, staffTextureKey, type ActivityFxKind, type Costume, type DramaEmote, type StrainKind } from '../themes';
import type { CreatureId, LifePose } from '../themes/types';
import { SHADES_TEXTURE, creatureTextureKey } from '../npc/types';
import { clipDisplayText } from '../../lib/displayText';
import { PIXEL_FONT_KEYS, ensurePixelFonts, hasGlyphs } from '../text/pixelFont';
import { PIXEL_METRICS, layoutPlate, pixelMeasure, plateGlyphScale, taskVisible, type MeasureFn, type PlateLayout, type PlateOptions, type PlateStyle } from './namePlate';
import { POSE_ANIM, POSE_PROP } from './poses';

export interface CharacterLook {
  color: number;
  /** M13: plate line 1 (a hero's name). Without it line 1 is `title` and there is no line 2. */
  name?: string;
  title: string;
  description?: string;
  sprite: number;
}

/** M8 8i: a hero's skin/hair on top of the agent-hash placeholder look; `null` keeps the hash look
 *  (`setAppearance`'s only caller, `OfficeScene`, already re-runs `setLook` whenever a hero binds or
 *  unbinds, which repaints the hash/role defaults this overlays). */
export interface CharacterAppearance {
  skin: number;
  hair: number;
  hairStyle: number;
}

/** M8 8b: the Guild Master's session-count chip ("+2"), red when one of the other sessions needs you. */
export interface SessionsChip {
  count: number;
  attention: boolean;
}

const TEXT_RES = 4;
/** M13 name plate: its bottom edge in local y, 2 px above the tallest hat (wizard, top at -21). */
const PLATE_BOTTOM_Y = -23;
/** While a status/emote/strain icon shows (slot -19..-26) the plate rides this much higher, clear of it. */
const PLATE_ICON_LIFT = 7;
const PLATE_BACK = 0x15121e;
const PLATE_TITLE = 0xb8b0c8;
const PLATE_TASK = 0xe8e2f0;
const PLATE_FONT = 'ui-monospace, Menlo, monospace';
const DEFAULT_PLATE_OPTIONS: PlateOptions = { showTask: 'focus', taskLines: 2, maxWidthChars: 24, showTitle: true, pixelFont: true };
const SIT_ACTIVITIES: ReadonlySet<Activity> = new Set(['typing', 'reading', 'idle', 'thinking', 'running', 'meeting', 'waiting', 'blocked']);
/** M8 8d selection glow: base Pre/canvas glow strength; selected pulses wider than a plain hover. */
const GLOW_SELECTED = 6;
const GLOW_HOVER = 3;
/** M8 8c: resting heroes read as visibly "away" without disappearing. */
const RESTING_ALPHA = 0.85;
/** M12 selection beacon: pixel size of the chevron's rows (in beacon units, before `beaconScale`). */
const BEACON_PX = 2;
const BEACON_ROWS = 5;
/** Extra overlay depth while the beacon shows, so it is never hidden under a neighbour's tag/bubble. */
const BEACON_DEPTH_BOOST = 40_000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function lighten(c: number, t: number): number {
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  const m = (v: number) => Math.round(v + (255 - v) * t);
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function crisp<T extends Phaser.GameObjects.Text>(t: T): T {
  t.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
  return t;
}

/**
 * A procedurally drawn pixel person. Origin is at the feet. The body lives in `this` (a container
 * depth-sorted by y); name tag and speech bubble live in `overlay` so they draw above everyone.
 *
 * M8 8c: `key` is the actor's stable identity (`hero:<id>` / `agent:<id>` / `gm:<projectId>`, see
 * `game/cast.ts`) and never changes for this instance's lifetime — it is what lets the scene "find"
 * the same Character across a reuse/rebind instead of spawning a new sprite. `boundAgentId` is the
 * live agent currently driving it, and is mutable: it changes on a rebind (a new subagent takes over
 * a resting hero, or a new session becomes the Guild Master) with no new sprite created.
 */
export class Character extends Phaser.GameObjects.Container {
  readonly key: ActorKey;
  /** The live agent this actor is currently drawing (null while resting/leaving with nobody bound). */
  boundAgentId: string | null = null;
  /** The hero this actor is bound to, if any (null for an anonymous `agent:` actor). */
  heroId: string | null = null;
  kind: 'guild-master' | 'member' = 'member';
  /** M8 8h: which Multiverse realm this actor belongs to (`MultiverseRealm.index`), or `null` on a
   *  normal floor. Kept even while resting/leaving (when there is no `CastMember` to read it from
   *  this frame) so the scene knows which realm's lounge/gate to walk it to. */
  realmIndex: number | null = null;
  /** M8 8c actor lifecycle (`game/actorLifecycle.ts`); the scene reads/writes this every `setOfficeState`. */
  lifecycleFrame: LifecycleFrame = INITIAL_LIFECYCLE;
  private shadow: Phaser.GameObjects.Image;
  private legs: Phaser.GameObjects.Image;
  private upper: Phaser.GameObjects.Container;
  private body_: Phaser.GameObjects.Image;
  private badge: Phaser.GameObjects.Image;
  private head: Phaser.GameObjects.Image;
  private hair: Phaser.GameObjects.Image;
  private handL: Phaser.GameObjects.Image;
  private handR: Phaser.GameObjects.Image;
  private prop: Phaser.GameObjects.Image;
  private icon: Phaser.GameObjects.Image;
  /** M12 strain overlay (dizzy/sweat/yawn/flame), beside the head so it shows with a `?` / `!`. */
  private strainIcon: Phaser.GameObjects.Image;
  /** M12 "on a roll" sparks (a second fx container beside the activity `fx`). */
  private strainFx: Phaser.GameObjects.Container;
  private cloak: Phaser.GameObjects.Image;
  private hat: Phaser.GameObjects.Image;
  /** An icon/strain badge is up this frame, so the plate sits `PLATE_ICON_LIFT` higher. */
  private plateIconUp = false;
  private goggles: Phaser.GameObjects.Image;
  private fx: Phaser.GameObjects.Container;
  /** Canvas-renderer fallback for the selection/hover glow (Pre FX is WebGL-only) — a soft ring
   *  plus outline drawn under the feet, in the same place `preFX.addGlow` highlights on WebGL. */
  private canvasGlow: Phaser.GameObjects.Graphics;
  readonly overlay: Phaser.GameObjects.Container;
  /** M12 selection beacon (overlay layer, counter-scaled by the scene via `setBeaconScale`): a
   *  bobbing chevron above the head and a ring at the feet, both in the role colour. */
  private beaconArrow: Phaser.GameObjects.Graphics;
  private beaconRing: Phaser.GameObjects.Graphics;
  private beaconEnabled = false;
  private beaconSize = 1;
  private beaconStatic = false;
  /** M13 name plate (overlay layer): backing + one BitmapText/Text per line, in plate pixels, scaled by `plateScale`. */
  private plate: Phaser.GameObjects.Container;
  private plateBack: Phaser.GameObjects.Graphics;
  private plateLayout: PlateLayout | null = null;
  private plateKey = '';
  private plateScale = 1;
  private plateOptions: PlateOptions = DEFAULT_PLATE_OPTIONS;
  private plateLook: CharacterLook | null = null;
  private plateText = '';
  private plateMeasureText?: Phaser.GameObjects.Text;
  /** M8 8b: the Guild Master's session-count chip, next to the tag. Created lazily (only GMs get one). */
  private chip?: Phaser.GameObjects.Text;
  private chipOnClick?: () => void;
  private chipAttention = false;
  private chipTagVisible = true;
  /** A short line from the character to its bubble once the bubble/label engine (`game/labels`)
   *  has displaced it off the plain "above" slot to dodge a neighbor. */
  private leaderLine: Phaser.GameObjects.Graphics;
  private bubble: Phaser.GameObjects.Container;
  private bubbleText: Phaser.GameObjects.Text;
  private bubbleBg: Phaser.GameObjects.Graphics;

  private path: Point[] = [];
  private onArrive?: () => void;
  private activity: Activity = 'idle';
  private status: AgentStatus = 'active';
  private seated = false;
  private waveUntil = 0;
  private bubbleUntil = 0;
  /** What is drawn in the bubble right now (server text or a drama line). */
  private lastBubble = '';
  /** M12: the last text the server sent, so a re-sent unchanged server bubble does not wipe a drama line. */
  private lastServerBubble = '';
  /** M12: the visible bubble is a drama line (`sayDrama`); the label engine ranks it last. */
  private dramaBubble = false;
  private dramaEmote: DramaEmote | null = null;
  private strainKind: StrainKind | null = null;
  private strainAnimated = false;
  /** Whichever of `setBubble`'s own timer logic currently wants the bubble on screen, independent
   *  of the M8 8e LOD gate below — the two are ANDed together in `applyBubbleVisible`. */
  private bubbleWantsShow = false;
  private bubbleAllowedByLod = true;
  /** Measured content box of the current bubble (or the collapsed badge's, when collapsed) — read
   *  by `OfficeScene` to build this frame's `LabelSubject` for `layoutLabels`. */
  private bubbleW = 0;
  private bubbleH = 0;
  private lookKey = '';
  private costume: Costume = {};
  private costumeKey = '';
  private costumeProp: string | null = null;
  private shades: Phaser.GameObjects.Image;
  private creatureImg: Phaser.GameObjects.Image;
  private creature: CreatureId | null = null;
  private pose: LifePose | null = null;
  private faceX: number | null = null;
  private appearanceKey = '';
  private fxKey = '';
  private phase: number;
  /** M9 8f: the base 14×20 interactive hit rect (`setHitScale`'s scale-1 shape), kept live so
   *  `setHitScale` can grow it around the same centre without recreating the interactive area. */
  private hitRect: Phaser.Geom.Rectangle;
  /** M9 8f: current scale applied to `hitRect` (1..8); tracked so `setHitScale` is a no-op when unchanged. */
  private hitScale = 1;
  /** The role color, remembered so selection/hover glow can use it without the scene passing it
   *  again on every hover/select toggle. */
  private roleColor = 0x8e8e9e;
  private selected = false;
  private hovered = false;
  /** `office.focusDim`-driven alpha (`setDim`) and the M8 8c resting alpha (`setResting`) combine
   *  multiplicatively — both the body and the overlay (tag/bubble/chip) dim while resting, per the
   *  design doc's "name tag dimmed". */
  private focusAlpha = 1;
  private restingAlpha = 1;
  private glow: Phaser.FX.Glow | null = null;
  private glowPulse?: Phaser.Tweens.Tween;
  /** M8 8e: name tag visibility is `office.showBubbles`-ish "look" flag AND the zoom-based LOD gate. */
  private tagAllowedByLook = true;
  private tagAllowedByLod = true;
  /** What `layoutLabels` decided this frame — `collapsed` (the effective, hover-overridden value
   *  actually drawn) can differ while hovered, which expands a collapsed bubble back to full size. */
  private wantCollapsed = false;
  private collapsed = false;
  private labelDx = 0;
  private labelDy = 0;
  private labelLeader = false;
  private labelScale = 1;
  /** M8 8c: fade-out tween from `leave()`, kept so a rebind (see `cancelLeave`) can stop it mid-flight. */
  private fadeTween?: Phaser.Tweens.Tween;
  leaving = false;
  gone = false;

  constructor(scene: Phaser.Scene, key: ActorKey, x: number, y: number) {
    super(scene, x, y);
    this.key = key;
    const h = hash(key);
    this.phase = (h % 1000) / 1000;
    const skin = SKIN_TONES[h % SKIN_TONES.length]!;
    const hairColor = HAIR_COLORS[(h >>> 3) % HAIR_COLORS.length]!;

    this.canvasGlow = scene.add.graphics().setVisible(false);
    this.shadow = scene.add.image(0, 1, 'ch-shadow').setOrigin(0.5, 1);
    this.legs = scene.add.image(0, 0, 'ch-legs-0').setOrigin(0.5, 1);
    this.body_ = scene.add.image(0, -3, 'ch-body').setOrigin(0.5, 1);
    this.badge = scene.add.image(2, -6, 'ch-badge').setOrigin(0.5, 0.5);
    this.head = scene.add.image(0, -9, 'ch-head').setOrigin(0.5, 1).setTint(skin);
    this.hair = scene.add.image(0, -15, 'ch-hair-0').setOrigin(0.5, 0).setTint(hairColor);
    this.handL = scene.add.image(-4, -4, 'px').setScale(0.5).setTint(skin);
    this.handR = scene.add.image(4, -4, 'px').setScale(0.5).setTint(skin);
    this.prop = scene.add.image(0, -3, 'prop-laptop').setOrigin(0.5, 1).setVisible(false);
    // Guild costume overlays (docs/design/guild-hall.md section 3): a cloak strip behind the body,
    // a hat above the hair, and a pair of goggles on the forehead. Invisible (and their textures
    // untouched) for the modern theme, whose costumes are all `{}`.
    this.cloak = scene.add.image(0, -2, CLOAK_TEXTURE).setOrigin(0.5, 1).setVisible(false);
    this.hat = scene.add.image(0, -15, hatTextureKey('wizard')).setOrigin(0.5, 1).setVisible(false);
    this.goggles = scene.add.image(0, -12, GOGGLES_TEXTURE).setOrigin(0.5, 0.5).setVisible(false);
    this.shades = scene.add.image(0, -12, SHADES_TEXTURE).setOrigin(0.5, 0.5).setVisible(false);
    this.upper = scene.add.container(0, 0, [
      this.cloak,
      this.body_,
      this.badge,
      this.handL,
      this.handR,
      this.head,
      this.hair,
      this.hat,
      this.goggles,
      this.shades,
      this.prop,
    ]);
    this.icon = scene.add.image(0, -19, 'icon-dots-3').setOrigin(0.5, 1).setVisible(false);
    this.fx = scene.add.container(0, -8);
    this.strainIcon = scene.add.image(6, -17, STRAIN_ICON.dizzy).setOrigin(0.5, 1).setVisible(false);
    this.strainFx = scene.add.container(0, -8);
    this.creatureImg = scene.add.image(0, 0, creatureTextureKey('dog', 0)).setOrigin(0.5, 1).setVisible(false);
    this.add([this.canvasGlow, this.shadow, this.legs, this.upper, this.creatureImg, this.icon, this.strainIcon, this.fx, this.strainFx]);

    this.plateBack = scene.add.graphics();
    this.plate = scene.add.container(0, PLATE_BOTTOM_Y, [this.plateBack]).setVisible(false);
    this.beaconRing = scene.add.graphics().setVisible(false);
    this.beaconArrow = scene.add.graphics().setVisible(false);
    this.leaderLine = scene.add.graphics();
    this.bubbleBg = scene.add.graphics();
    this.bubbleText = crisp(
      scene.add
        .text(0, 0, '', { fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: '6px', color: '#2a2233', wordWrap: { width: 90 }, resolution: TEXT_RES })
        .setOrigin(0.5, 1),
    );
    this.bubble = scene.add.container(0, -22, [this.bubbleBg, this.bubbleText]).setVisible(false);
    this.overlay = scene.add.container(x, y, [this.beaconRing, this.beaconArrow, this.plate, this.leaderLine, this.bubble]);

    this.hitRect = new Phaser.Geom.Rectangle(-7, -18, 14, 20);
    this.setInteractive(this.hitRect, Phaser.Geom.Rectangle.Contains);
    if (this.input) this.input.cursor = 'pointer';
    scene.add.existing(this);
  }

  setLook(look: CharacterLook, showTag: boolean) {
    if (look.color !== this.roleColor) {
      this.roleColor = look.color;
      if (this.selected || this.hovered) this.refreshSelectionFx();
      if (this.beaconEnabled && this.selected) this.paintBeacon();
    }
    if (showTag !== this.tagAllowedByLook) {
      this.tagAllowedByLook = showTag;
      this.applyTagVisible();
    }
    this.plateLook = look;
    this.refreshPlate();
    const k = `${look.color}|${look.title}|${look.description ?? ''}|${look.sprite}`;
    if (k === this.lookKey) return;
    this.lookKey = k;
    this.body_.setTint(look.color);
    this.badge.setTint(lighten(look.color, 0.6));
    this.hair.setTexture(`ch-hair-${Math.abs(look.sprite) % HAIR_STYLES}`);
  }

  // ---------------------------------------------------------------- M13: name plate

  /** Plate settings (`plateOptions(settings.office.labels)`); idempotent, re-layouts only on change. */
  setPlateOptions(o: PlateOptions): void {
    const same = o.showTask === this.plateOptions.showTask && o.taskLines === this.plateOptions.taskLines
      && o.maxWidthChars === this.plateOptions.maxWidthChars && o.showTitle === this.plateOptions.showTitle
      && o.pixelFont === this.plateOptions.pixelFont;
    if (same) return;
    this.plateOptions = o;
    this.refreshPlate();
  }

  /** Camera zoom: the plate scales in whole screen pixels per font pixel (`plateGlyphScale`). */
  setPlateZoom(zoom: number): void {
    const s = plateGlyphScale(zoom);
    if (s === this.plateScale) return;
    this.plateScale = s;
    this.plate.setScale(s);
  }

  /** Text-backed measure (plate pixels) for the canvas / missing-glyph fallback. */
  private textMeasure(): MeasureFn {
    const probe = (this.plateMeasureText ??= this.scene.make.text({ style: { fontFamily: PLATE_FONT, resolution: TEXT_RES } }, false));
    return (text, style) => {
      probe.setFontSize(style === 'name' ? 5 : 4);
      probe.setText(text);
      return probe.width;
    };
  }

  /** Re-layouts and redraws the plate. Runs only on look/options/selection/hover change (keyed), never per frame. */
  private refreshPlate(): void {
    const look = this.plateLook;
    if (!look) return;
    const o = this.plateOptions;
    const showTask = taskVisible(o.showTask, this.selected, this.hovered);
    const named = !!look.name;
    const task = showTask ? look.description : undefined; // clipped below, before layout
    const webgl = this.scene.game.renderer.type === Phaser.WEBGL;
    const key = `${look.color}|${look.name ?? ''}|${look.title}|${task ?? ''}|${o.taskLines}|${o.maxWidthChars}|${o.showTitle}|${o.pixelFont}|${webgl}`;
    if (key === this.plateKey) return;
    this.plateKey = key;
    // Untrusted text: sanitize and clip by code point before any layout/measure work (M13 gate).
    const cap = o.maxWidthChars + 1;
    const line1 = clipDisplayText(named ? look.name! : look.title, cap);
    const title = named && o.showTitle ? clipDisplayText(look.title, cap) : undefined;
    const taskClip = task ? clipDisplayText(task, o.maxWidthChars * Math.max(1, o.taskLines) + 1) : undefined;
    const maxW = o.maxWidthChars * 6;
    const maxLines = showTask ? o.taskLines : 0;
    this.plateText = named ? `${look.name} · ${look.title}` : look.title;

    // The small font is uppercase only: measure and check glyphs on the uppercased text.
    let layout = layoutPlate(line1, title?.toUpperCase(), taskClip?.toUpperCase(), maxW, maxLines, pixelMeasure());
    const bitmap = o.pixelFont && webgl && ensurePixelFonts(this.scene)
      && layout.lines.every((l) => hasGlyphs(l.text, l.style === 'name' ? 'big' : 'small'));
    if (!bitmap) layout = layoutPlate(line1, title, taskClip, maxW, maxLines, this.textMeasure());
    this.plateLayout = layout;

    for (const c of this.plate.list.slice(1)) c.destroy();
    this.plate.removeBetween(1);
    const back = this.plateBack;
    back.clear();
    back.fillStyle(PLATE_BACK, 0.8);
    back.fillRoundedRect(-layout.w / 2, -layout.h, layout.w, layout.h, 1);
    let top = -layout.h + PIXEL_METRICS.pad;
    for (const l of layout.lines) {
      const color = l.style === 'name' ? lighten(look.color, 0.55) : l.style === 'title' ? PLATE_TITLE : PLATE_TASK;
      const x = -l.w / 2;
      let obj: Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text;
      if (bitmap) {
        const big = l.style === 'name';
        obj = this.scene.make.bitmapText({ x, y: top, font: big ? PIXEL_FONT_KEYS.big : PIXEL_FONT_KEYS.small, text: l.text }, false);
        obj.setOrigin(0, 0).setTint(color);
      } else {
        obj = crisp(
          this.scene.make.text({ x, y: top, text: l.text, style: { fontFamily: PLATE_FONT, fontSize: l.style === 'name' ? '5px' : '4px', color: hex(color), resolution: TEXT_RES } }, false),
        ).setOrigin(0, 0);
      }
      if (l.style === 'task') obj.setAlpha(0.9);
      this.plate.add(obj);
      top += PIXEL_METRICS.lineH[l.style as PlateStyle] + PIXEL_METRICS.gap;
    }
    this.applyTagVisible();
  }

  /** World height of the shown plate above `PLATE_BOTTOM_Y` (0 while hidden). */
  private get plateWorldH(): number {
    return (this.plateLayout?.h ?? 0) * this.plateScale;
  }

  /** Plate bottom edge in local y: hugs the head, lifted above the icon while one shows (set by `animate`). */
  private get plateBottomY(): number {
    return PLATE_BOTTOM_Y - (this.plateIconUp ? PLATE_ICON_LIFT : 0);
  }

  private get plateShown(): boolean {
    return !!this.plateLayout && this.tagAllowedByLook && this.tagAllowedByLod;
  }

  /** Guild costume for this role (hat/cloak/staff/goggles); a no-op `{}` under the modern theme.
   *  When a hero is bound, the scene passes `resolveHeroCostume`'s merged result instead of the
   *  theme's plain role costume, so hero overrides (explicit hat/prop/accessory/colours) win. */
  setCostume(costume: Costume, roleColor: number) {
    const key = `${costume.robe ?? ''}|${costume.cloak ?? ''}|${costume.hat ?? ''}|${costume.hatColor ?? ''}|${costume.staff ?? ''}|${costume.goggles ?? ''}|${costume.shades ?? ''}|${roleColor}`;
    if (key === this.costumeKey) return;
    this.costumeKey = key;
    this.costume = costume;
    if (costume.robe !== undefined) this.body_.setTint(costume.robe);
    if (costume.cloak !== undefined) this.cloak.setTexture(CLOAK_TEXTURE).setTint(costume.cloak).setVisible(true);
    else this.cloak.setVisible(false);
    if (costume.hat && costume.hat !== 'none') this.hat.setTexture(hatTextureKey(costume.hat)).setTint(costume.hatColor ?? roleColor).setVisible(true);
    else this.hat.setVisible(false);
    this.goggles.setVisible(!!costume.goggles);
    this.shades.setVisible(!!costume.shades);
    this.costumeProp = costume.staff && costume.staff !== 'none' ? staffTextureKey(costume.staff) : null;
  }

  /** M8 8i: a bound hero's skin/hair on top of the agent-hash placeholder (`null` keeps the hash
   *  look — `setLook` above already repaints it whenever a hero binds/unbinds, since the tag text
   *  changes too, so there is nothing to actively "revert" here). */
  setAppearance(look: CharacterAppearance | null) {
    const key = look ? `${look.skin}|${look.hair}|${look.hairStyle}` : '';
    if (key === this.appearanceKey) return;
    this.appearanceKey = key;
    if (!look) return;
    this.head.setTint(look.skin);
    this.handL.setTint(look.skin);
    this.handR.setTint(look.skin);
    const style = ((look.hairStyle % HAIR_STYLES) + HAIR_STYLES) % HAIR_STYLES;
    this.hair.setTexture(`ch-hair-${style}`).setTint(look.hair);
  }

  /** Particle effect for the current activity (docs/design/guild-hall.md "Magic activity effects"). */
  setActivityFx(kind: ActivityFxKind | undefined, enabled: boolean) {
    const key = `${kind ?? ''}|${enabled}`;
    if (key === this.fxKey) return;
    this.fxKey = key;
    this.fx.removeAll(true);
    this.fx.add(createActivityFx(this.scene, kind, 0, 0, enabled));
  }

  setActivity(activity: Activity, status: AgentStatus) {
    const becameDone = status === 'done' && this.status !== 'done';
    this.activity = activity;
    this.status = status;
    if (becameDone) this.waveUntil = this.scene.time.now + 1600;
  }

  // ---------------------------------------------------------------- M8 8b: Guild Master chip

  /** The Guild Master's session-count chip ("+2", red when `attention`); `null` removes it (a
   *  per-session floor, or a Guild Master with no other live sessions right now). `onClick` fires
   *  `scene.events.emit('gmSessions', ...)` — set fresh every call since it closes over `projectId`. */
  setSessionsChip(chip: SessionsChip | null, onClick?: () => void) {
    this.chipOnClick = onClick;
    if (!chip) {
      this.chip?.setVisible(false);
      this.chipAttention = false;
      return;
    }
    this.chipAttention = chip.attention;
    if (!this.chip) {
      this.chip = crisp(
        this.scene.add
          .text(0, 3, '', {
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: '5px',
            padding: { x: 2, y: 1 },
            resolution: TEXT_RES,
          })
          .setOrigin(0, 0.5),
      );
      this.chip.setInteractive({ cursor: 'pointer' });
      this.chip.on('pointerup', () => this.chipOnClick?.());
      this.overlay.add(this.chip);
    }
    this.chip.setText(`+${chip.count}`);
    this.chip.setColor(chip.attention ? '#fff2f2' : '#1c1430');
    // M9 8f: the attention chip's old #e5484dee background only reached ~3.6:1 against #fff2f2
    // text (WCAG needs 4.5:1 for normal-size text). #b3242a is a darker, still-clearly-urgent red
    // that reaches ~6.0:1 against the same text color. The non-attention chip is unchanged.
    this.chip.setBackgroundColor(chip.attention ? '#b3242aee' : '#f3c94dcc');
    this.chip.setVisible(this.chipTagVisible);
  }

  // ---------------------------------------------------------------- M8 8d: selection glow

  /** Drawer open on this agent (ROADMAP.md M8 8d): a pulsing glow in the role color, plus focus
   *  mode dims everyone else via `setDim`. Idempotent — safe to call every `setOfficeState` pass. */
  setSelected(selected: boolean) {
    if (this.selected === selected) return;
    this.selected = selected;
    this.refreshPlate();
    this.refreshSelectionFx();
    this.refreshBeacon();
  }

  /** Subtle hover highlight for discoverability — a fainter, non-pulsing version of the same glow,
   *  and it also expands any collapsed ("…" badge) bubble back to full size (see `applyCollapse`). */
  setHovered(hovered: boolean) {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.refreshPlate();
    this.refreshSelectionFx();
    this.applyCollapse();
  }

  /** `office.selectionBeacon` gate: the beacon shows while this is on AND the character is selected. */
  setBeaconEnabled(enabled: boolean) {
    if (this.beaconEnabled === enabled) return;
    this.beaconEnabled = enabled;
    this.refreshBeacon();
  }

  /** Local scale of the beacon pieces (`game/camera/beacon.ts#beaconScale`, 1/zoom without a cap). */
  setBeaconScale(scale: number) {
    if (scale === this.beaconSize) return;
    this.beaconSize = scale;
    this.beaconArrow.setScale(scale);
    this.beaconRing.setScale(scale);
  }

  /** Live reduced-motion state, pushed per frame by the scene (its cached watcher), so toggling the
   *  OS setting mid-session takes effect without a reselect. */
  setBeaconStatic(isStatic: boolean) {
    this.beaconStatic = isStatic;
  }

  private get beaconVisible(): boolean {
    return this.beaconEnabled && this.selected;
  }

  private refreshBeacon() {
    const on = this.beaconVisible;
    this.beaconArrow.setVisible(on);
    this.beaconRing.setVisible(on);
    if (on) this.paintBeacon();
  }

  /** Pixel-art downward chevron (tip at the origin, rows grow upward) with a dark outline, plus a
   *  feet ring; drawn once per role colour at beacon scale 1. */
  private paintBeacon() {
    const a = this.beaconArrow;
    a.clear();
    const px = BEACON_PX;
    for (let i = 0; i < BEACON_ROWS; i++) {
      const w = (1 + 2 * i) * px;
      a.fillStyle(0x15121e, 0.9);
      a.fillRect(-w / 2 - 1, -(i + 1) * px - 1, w + 2, px + 2);
    }
    for (let i = 0; i < BEACON_ROWS; i++) {
      const w = (1 + 2 * i) * px;
      a.fillStyle(i === BEACON_ROWS - 1 ? lighten(this.roleColor, 0.35) : this.roleColor, 1);
      a.fillRect(-w / 2, -(i + 1) * px, w, px);
    }
    const r = this.beaconRing;
    r.clear();
    r.lineStyle(4, 0x15121e, 0.55);
    r.strokeEllipse(0, 1, 22, 12);
    r.lineStyle(2, this.roleColor, 1);
    r.strokeEllipse(0, 1, 22, 12);
  }

  /** Per-frame beacon placement: bob (static under reduced motion) and lift above a bubble that
   *  sits right over the head. `baseY`/`bx`/`by` are `animate()`'s head/bubble anchors. */
  private updateBeacon(now: number, iconUp: boolean, bubbleX: number, bubbleY: number) {
    if (!this.beaconVisible) return;
    const s = this.beaconSize;
    let tip = this.plateShown ? this.plateBottomY - this.plateWorldH - 2 : iconUp ? -35 : -27;
    if (this.bubbleWantsShow && this.bubbleAllowedByLod) {
      const ls = this.labelScale;
      if (Math.abs(bubbleX) < (this.bubbleW * ls) / 2 + BEACON_PX * BEACON_ROWS * s) tip = Math.min(tip, bubbleY - this.bubbleH * ls - 2);
    }
    const phase = this.beaconStatic ? 0 : Math.sin(now / 1000 * 5);
    this.beaconArrow.setPosition(0, tip - 2 * s * (phase * 0.5 + 0.5));
    this.beaconRing.setAlpha(this.beaconStatic ? 1 : 0.7 + 0.3 * Math.sin(now / 1000 * 3));
  }

  /** Role colour (the beacon, glow and tag all use it); the scene tints the off-screen arrow with it. */
  get accent(): number {
    return this.roleColor;
  }

  /** The name-tag text ("Name · Title"); the scene's off-screen arrow labels the selection with it. */
  get tagText(): string {
    return this.plateText;
  }

  get currentActivity(): Activity {
    return this.activity;
  }

  get currentStatus(): AgentStatus {
    return this.status;
  }

  // ---------------------------------------------------------------- M13: cosmetic hooks

  /** Overrides the activity animation while standing still and not waiting/blocked; null restores. Prop from POSE_PROP. */
  setPose(pose: LifePose | null): void {
    this.pose = pose;
  }

  /** Non-human body: hides legs/upper/cloak/hat/props, shows `creature-<id>-<0|1>` (frame 1 alternates while walking). */
  setCreature(id: CreatureId | null): void {
    if (id === this.creature) return;
    this.creature = id;
    this.upper.setVisible(!id);
    this.legs.setVisible(!id);
    this.creatureImg.setVisible(!!id);
    if (id) this.creatureImg.setTexture(creatureTextureKey(id, 0));
  }

  /** Face toward a world x while standing (null = default); survives animate()'s scaleX reset. */
  face(worldX: number | null): void {
    this.faceX = worldX;
  }

  /** Shows/hides the body AND its overlay (tag/bubble/beacon) together. */
  setShown(shown: boolean) {
    this.setVisible(shown);
    this.overlay.setVisible(shown);
  }

  /** Focus mode (`office.focusDim`): everyone but the selected character dims by this much while
   *  a drawer is open; 1 = no dimming. Left alone (not tweened) — it changes rarely enough (only on
   *  select/deselect) that a snap read as intentional rather than as a stutter. */
  setDim(alpha: number) {
    if (this.focusAlpha === alpha) return;
    this.focusAlpha = alpha;
    this.applyAlpha();
  }

  /** M8 8c: resting heroes read at 0.85 alpha (body + tag/bubble/chip) even with no focus-dim in
   *  effect; combines multiplicatively with `setDim`'s focus-mode alpha. */
  setResting(resting: boolean) {
    const a = resting ? RESTING_ALPHA : 1;
    if (a === this.restingAlpha) return;
    this.restingAlpha = a;
    this.applyAlpha();
  }

  private applyAlpha() {
    const a = this.focusAlpha * this.restingAlpha;
    this.setAlpha(a);
    this.overlay.setAlpha(a);
  }

  private refreshSelectionFx() {
    this.glowPulse?.remove();
    this.glowPulse = undefined;
    if (this.glow) {
      this.shadow.preFX?.remove(this.glow);
      this.glow = null;
    }
    const active = this.selected || this.hovered;
    if (!active) {
      this.canvasGlow.clear().setVisible(false);
      return;
    }
    const strength = this.selected ? GLOW_SELECTED : GLOW_HOVER;
    // Pre FX only works on Image/Sprite/Text/etc — never a Container — and only under WebGL
    // (docs: "preFX.addGlow on WebGL, with a canvas-renderer fallback"). `shadow` is the character's
    // own Image, so glowing it reads as a soft ring at the feet rather than distorting the sprite.
    const webgl = this.scene.game.renderer.type === Phaser.WEBGL;
    if (webgl && this.shadow.preFX) {
      // The glow source is only the 10x3 shadow image: without padding the post-FX framebuffer
      // clips the glow at the image's own box and it is invisible when zoomed out.
      this.shadow.preFX.setPadding(16);
      this.glow = this.shadow.preFX.addGlow(this.roleColor, strength, 0, false, 0.15, 12);
      this.canvasGlow.setVisible(false);
      if (this.selected && !prefersReducedMotion()) {
        this.glowPulse = this.scene.tweens.add({
          targets: this.glow,
          outerStrength: strength * 1.7,
          duration: 700,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }
    } else {
      this.paintCanvasGlow(strength);
    }
  }

  /** Canvas-renderer fallback: a soft filled ellipse plus a stroked outline ring under the feet,
   *  tinted to the role color — Pre FX has no Canvas counterpart at all. */
  private paintCanvasGlow(strength: number) {
    const g = this.canvasGlow;
    const r = 8 + strength;
    g.clear();
    g.fillStyle(this.roleColor, this.selected ? 0.22 : 0.12);
    g.fillEllipse(0, 1, r * 2, r * 1.15);
    g.lineStyle(1.5, this.roleColor, this.selected ? 0.85 : 0.45);
    g.strokeEllipse(0, 1, r * 1.6, r * 0.9);
    g.setAlpha(1).setVisible(true);
    if (this.selected && !prefersReducedMotion()) {
      this.glowPulse = this.scene.tweens.add({ targets: g, alpha: { from: 0.55, to: 1 }, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
  }

  // ---------------------------------------------------------------- M8 8e: bubble/label declutter

  /** This frame's placement from `layoutLabels` (world px at zoom 1, relative to `labelAnchor`) —
   *  `OfficeScene` calls this on its throttled label-refresh pass, not every frame. */
  setLabelPlacement(dx: number, dy: number, leader: boolean, collapsed: boolean) {
    this.labelDx = dx;
    this.labelDy = dy;
    this.labelLeader = leader;
    this.wantCollapsed = collapsed;
    this.applyCollapse();
  }

  /** Screen-space readability (M8 8e): a local scale that counteracts the camera's zoom so the tag
   *  and bubble never read smaller than they do at zoom 1. See `game/labels/lod.ts#counterScale`. */
  setLabelScale(scale: number) {
    if (scale === this.labelScale) return;
    this.labelScale = scale;
    this.bubble.setScale(scale);
    this.chip?.setScale(scale);
  }

  /** Zoom-based level of detail for the name tag (`office.labelMinZoom`); ANDed with the "look"
   *  flag (`setLook`'s `showTag`) so either one hiding it is enough. The Guild Master's chip follows
   *  the tag too, except it stays visible regardless of LOD while `attention` is set (M8 8e/8b). */
  setTagVisible(visible: boolean) {
    if (this.tagAllowedByLod === visible) return;
    this.tagAllowedByLod = visible;
    this.applyTagVisible();
  }

  /** Same LOD gate for the speech bubble — ANDed with whatever `setBubble`'s own show/fade timer wants. */
  setBubbleLod(visible: boolean) {
    if (this.bubbleAllowedByLod === visible) return;
    this.bubbleAllowedByLod = visible;
    this.applyBubbleVisible();
  }

  private applyTagVisible() {
    const visible = this.tagAllowedByLook && this.tagAllowedByLod;
    this.plate.setVisible(visible && !!this.plateLayout);
    this.chipTagVisible = visible;
    this.chip?.setVisible(visible || this.chipAttention);
  }

  private applyBubbleVisible() {
    this.bubble.setVisible(this.bubbleWantsShow && this.bubbleAllowedByLod);
  }

  /** Hovering expands a collapsed ("…" badge) bubble back to its full content (docs: "collapse to
   *  a small '…' dot badge that expands on hover"). */
  private applyCollapse() {
    const effective = this.wantCollapsed && !this.hovered;
    if (effective === this.collapsed) return;
    this.collapsed = effective;
    if (this.bubbleWantsShow) this.renderBubbleContent();
  }

  /** Whether this character currently has a bubble worth including in this frame's `LabelSubject`
   *  set (`OfficeScene` builds these for `layoutLabels`). */
  get hasBubble(): boolean {
    return this.bubbleWantsShow;
  }

  /** The measured content box of the current bubble (or the small badge box, if collapsed). */
  get bubbleSize(): Size {
    return { w: this.bubbleW, h: this.bubbleH };
  }

  /** World-space point `layoutLabels` treats as this character's anchor: the top of the plate while it
   *  is shown, else roughly head height. */
  get labelAnchor(): Point {
    if (this.plateShown) return { x: this.x, y: this.y + this.plateBottomY - this.plateWorldH };
    return { x: this.x, y: this.y - 18 };
  }

  /** World-space box of the name plate while it is drawn (scaled), else null.
   *  The label layout treats it as an obstacle so no bubble covers a plate. */
  get tagRect(): { left: number; right: number; top: number; bottom: number } | null {
    if (!this.plateShown || this.gone || this.leaving) return null;
    const w = (this.plateLayout?.w ?? 0) * this.plateScale;
    const bottom = this.y + this.plateBottomY;
    return { left: this.x - w / 2, right: this.x + w / 2, top: bottom - this.plateWorldH, bottom };
  }

  get isWaiting(): boolean {
    return this.status === 'waiting' || this.status === 'blocked';
  }

  /** Show `text` for `seconds` when it changes. */
  setBubble(text: string | undefined, seconds: number, enabled: boolean) {
    if (!enabled) {
      this.bubbleWantsShow = false;
      this.dramaBubble = false;
      this.applyBubbleVisible();
      this.bubbleUntil = 0;
      return;
    }
    const t = (text ?? '').trim();
    if (!t || t === this.lastServerBubble) return;
    this.lastServerBubble = t;
    this.lastBubble = t;
    this.dramaBubble = false;
    this.renderBubbleContent();
    this.bubble.setAlpha(1);
    this.bubbleWantsShow = true;
    this.applyBubbleVisible();
    this.bubbleUntil = this.scene.time.now + seconds * 1000;
  }

  // ---------------------------------------------------------------- M12 G1: drama

  /** Strain overlay: `null` clears. `animated` false = static frame, no sway/droop, no streak fx. */
  setStrain(kind: StrainKind | null, animated: boolean): void {
    if (kind === this.strainKind && animated === this.strainAnimated) return;
    const kindChanged = kind !== this.strainKind;
    this.strainKind = kind;
    this.strainAnimated = animated;
    if (kindChanged || !animated) {
      this.strainFx.removeAll(true);
      if (kind === 'on-a-roll' && animated) this.strainFx.add(createActivityFx(this.scene, 'streak', 0, 0, true));
    } else if (kind === 'on-a-roll' && this.strainFx.length === 0) this.strainFx.add(createActivityFx(this.scene, 'streak', 0, 0, true));
    if (kind) this.strainIcon.setTexture(STRAIN_ICON[kind]).setAlpha(1).setPosition(6, -17).setVisible(true);
    else this.strainIcon.setVisible(false);
  }

  /** Emote in the main head-icon slot during an antic; `null` clears. */
  setDramaEmote(emote: DramaEmote | null): void {
    this.dramaEmote = emote;
  }

  /** A drama bubble: shown like `setBubble`, but flagged so the label engine ranks it last. Skipped
   *  while a waiting/blocked agent's real bubble is up (the line must never hide "needs you"). */
  sayDrama(text: string, seconds: number): void {
    const t = text.trim();
    if (!t) return;
    if (this.bubbleWantsShow && !this.dramaBubble && this.isWaiting) return;
    this.scene.tweens.killTweensOf(this.bubble);
    this.lastBubble = t;
    this.dramaBubble = true;
    this.renderBubbleContent();
    this.bubble.setAlpha(1);
    this.bubbleWantsShow = true;
    this.applyBubbleVisible();
    this.bubbleUntil = this.scene.time.now + seconds * 1000;
  }

  /** Clears the drama emote and a still-visible drama bubble. */
  clearDrama(): void {
    this.dramaEmote = null;
    if (!this.dramaBubble) return;
    this.dramaBubble = false;
    this.scene.tweens.killTweensOf(this.bubble);
    this.bubbleWantsShow = false;
    this.bubbleUntil = 0;
    this.applyBubbleVisible();
  }

  get hasDramaBubble(): boolean {
    return this.dramaBubble && this.bubbleWantsShow;
  }

  /** Draws the bubble's current content: the real text box, or — while a lower-priority bubble has
   *  collapsed under `office.maxBubbles` and isn't hovered — a small "…" dot badge instead. Also
   *  records the measured box in `bubbleW`/`bubbleH` for the next `layoutLabels` pass. */
  private renderBubbleContent() {
    const g = this.bubbleBg;
    g.clear();
    if (this.collapsed) {
      g.fillStyle(0x1c1826, 0.35);
      g.fillCircle(0, -3, 4.5);
      g.fillStyle(0xfdf6e3, 1);
      g.fillCircle(0, -3, 3.6);
      this.bubbleText.setOrigin(0.5, 0.5).setPosition(0, -3).setText('…');
      this.bubbleW = 9;
      this.bubbleH = 9;
      return;
    }
    const t = this.lastBubble.length > 60 ? `${this.lastBubble.slice(0, 59)}…` : this.lastBubble;
    this.bubbleText.setOrigin(0.5, 1).setPosition(0, -1.5).setText(t);
    const w = Math.ceil(this.bubbleText.width) + 6;
    const h = Math.ceil(this.bubbleText.height) + 3;
    g.fillStyle(0x1c1826, 0.35);
    g.fillRoundedRect(-w / 2 + 1, -h + 1, w, h, 3);
    g.fillStyle(0xfdf6e3, 1);
    g.fillRoundedRect(-w / 2, -h, w, h, 3);
    g.fillTriangle(-2, -0.5, 2, -0.5, 0, 3);
    this.bubbleW = w;
    this.bubbleH = h;
  }

  get tile(): Point {
    return { x: Math.floor(this.x / 16), y: Math.floor((this.y - 1) / 16) };
  }

  get walking() {
    return this.path.length > 0;
  }

  teleport(p: Point) {
    this.path = [];
    this.setPosition(p.x * 16 + 8, p.y * 16 + 14);
  }

  walk(path: Point[], seated: boolean, onArrive?: () => void) {
    // Drop the tile we're standing on.
    this.path = path.slice(1).map((p) => ({ x: p.x * 16 + 8, y: p.y * 16 + 14 }));
    this.seated = seated;
    this.onArrive = onArrive;
    if (!this.path.length) this.arrive();
  }

  setSeated(seated: boolean) {
    this.seated = seated;
  }

  private arrive() {
    const cb = this.onArrive;
    this.onArrive = undefined;
    cb?.();
  }

  /** Starts (or restarts) the leave fade: walk `path` (if any) then fade to alpha 0 over 700ms.
   *  M9 8f: under `prefersReducedMotion()` the fade itself is skipped — alpha jumps straight to 0
   *  and `gone` is set immediately, reaching the same end state without the 700ms tween. */
  leave(path: Point[] | null) {
    this.leaving = true;
    const fade = () => {
      if (prefersReducedMotion()) {
        this.setAlpha(0);
        this.overlay.setAlpha(0);
        this.gone = true;
        return;
      }
      this.fadeTween = this.scene.tweens.add({
        targets: [this, this.overlay],
        alpha: 0,
        duration: 700,
        onComplete: () => {
          this.gone = true;
        },
      });
    };
    if (path && path.length > 1) this.walk(path, false, fade);
    else fade();
  }

  /** M8 8c: a rebind cancels a pending leave — stop the fade tween mid-flight and restore full
   *  alpha (subject to whatever `setDim`/resting alpha currently apply) so the walk to the new zone
   *  reads as a continuous "turned around" motion rather than a fresh spawn. */
  cancelLeave() {
    if (!this.leaving) return;
    this.leaving = false;
    this.fadeTween?.remove();
    this.fadeTween = undefined;
    this.onArrive = undefined;
    this.applyAlpha();
  }

  /**
   * M9 8f: grows (or shrinks back down) ONLY the interactive hit rectangle — the 14×20 world-px
   * rect this character was made interactive with — around its unchanged centre, by `scale`
   * (clamped to 1..8). Purely a hit-testing aid for click/tap targeting (e.g. when zoomed out);
   * it never touches anything visual. Cheap and idempotent: a no-op when `scale` (after clamping)
   * matches the current one. Used by `OfficeScene` to widen small/distant characters' click targets.
   */
  setHitScale(scale: number): void {
    const clamped = Math.min(8, Math.max(1, scale));
    if (clamped === this.hitScale) return;
    this.hitScale = clamped;
    const w = 14 * clamped;
    const h = 20 * clamped;
    // Base rect (-7, -18, 14, 20) is centred at (0, -8); keep that centre as it grows.
    this.hitRect.setTo(-w / 2, -8 - h / 2, w, h);
  }

  update(now: number, dt: number, speed: number) {
    if (this.path.length) {
      let step = (speed * dt) / 1000;
      while (step > 0 && this.path.length) {
        const next = this.path[0]!;
        const dx = next.x - this.x;
        const dy = next.y - this.y;
        const d = Math.hypot(dx, dy);
        if (d <= step) {
          this.setPosition(next.x, next.y);
          this.path.shift();
          step -= d;
          if (!this.path.length) this.arrive();
        } else {
          this.setPosition(this.x + (dx / d) * step, this.y + (dy / d) * step);
          if (Math.abs(dx) > 0.5) this.upper.scaleX = dx < 0 ? -1 : 1;
          step = 0;
        }
      }
    }
    this.animate(now);
    this.setDepth(this.y);
    this.overlay.setPosition(this.x, this.y);
    this.overlay.setDepth(100_000 + this.y + (this.beaconVisible ? BEACON_DEPTH_BOOST : 0));
    if (this.bubbleUntil && now > this.bubbleUntil) {
      this.bubbleUntil = 0;
      this.bubbleWantsShow = false;
      this.scene.tweens.add({ targets: this.bubble, alpha: 0, duration: 400, onComplete: () => this.applyBubbleVisible() });
    }
  }

  private animate(now: number) {
    const t = now / 1000 + this.phase * 10;
    const walking = this.path.length > 0;
    const pose = !walking && !this.isWaiting ? this.pose : null;
    const poseAnim = pose ? POSE_ANIM[pose] : null;
    const sitting = !walking && (pose === 'sit' || (this.seated && SIT_ACTIVITIES.has(this.activity)));
    let bob = 0;
    let icon: string | null = null;
    let prop: string | null = null;
    let propX = 0;
    let propY = -3;
    let handLY = -4;
    let handRY = -4;
    let handLX = -4;
    let handRX = 4;
    let iconY = -19;
    let iconAlpha = 1;
    let shakeX = 0;

    if (walking) {
      const f = Math.floor(t * 8) % 4;
      this.legs.setTexture(f === 1 ? 'ch-legs-1' : f === 3 ? 'ch-legs-2' : 'ch-legs-0');
      bob = f % 2 === 1 ? -1 : 0;
      handLY = -4 + (f === 1 ? -1 : 0);
      handRY = -4 + (f === 3 ? -1 : 0);
    } else {
      this.legs.setTexture(sitting ? 'ch-legs-sit' : 'ch-legs-0');
      bob = sitting ? 1 : Math.sin(t * 2) > 0.95 ? -1 : 0;
      if (this.faceX === null) this.upper.scaleX = 1;
      else {
        const fx = this.faceX - this.x;
        if (Math.abs(fx) > 0.5) this.upper.scaleX = fx < 0 ? -1 : 1;
      }
      if (poseAnim && pose) {
        const flick = Math.floor(t * 5) % 2;
        if (poseAnim.bob > 0) bob -= flick * poseAnim.bob;
        [handLX, handLY] = poseAnim.handL;
        [handRX, handRY] = poseAnim.handR;
        if (poseAnim.bob > 0) {
          handLY -= flick;
          handRY -= 1 - flick;
        }
        if (poseAnim.sway) shakeX = Math.round(Math.sin(t * 3) * poseAnim.sway);
        const pp = POSE_PROP[pose];
        if (pp && this.scene.textures.exists(pp)) {
          prop = pp;
          propX = 5;
          propY = -3;
        }
        if (pose === 'nap') {
          icon = 'icon-zz';
          iconAlpha = 0.8;
        }
      } else switch (this.activity) {
        case 'typing': {
          prop = 'prop-laptop';
          propY = -1;
          const flick = Math.floor(t * 10) % 2;
          handLY = -3 - flick;
          handRY = -4 + flick;
          handLX = -2;
          handRX = 2;
          break;
        }
        case 'running':
          prop = 'prop-terminal';
          propY = -1;
          icon = 'icon-term';
          handLX = -2;
          handRX = 2;
          handRY = -3 - (Math.floor(t * 6) % 2);
          break;
        case 'reading':
          prop = 'prop-book';
          propY = -3;
          handLX = -3;
          handRX = 3;
          handLY = handRY = -4;
          if (Math.floor(t / 2) % 3 === 0) this.prop.setFlipX(Math.floor(t * 4) % 2 === 0);
          break;
        case 'searching':
          prop = 'prop-magnifier';
          propX = Math.round(Math.sin(t * 2.5) * 3);
          propY = -6;
          handRX = propX + 2;
          handRY = -6;
          break;
        case 'browsing':
          prop = 'prop-globe';
          propX = 4;
          propY = -5;
          handRY = -6;
          break;
        case 'testing':
          prop = 'prop-flask';
          propX = 4;
          propY = -4 + Math.round(Math.sin(t * 5));
          handRX = 4;
          handRY = -5;
          icon = 'icon-sparkle';
          iconAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t * 4));
          break;
        case 'thinking':
        case 'meeting':
          icon = `icon-dots-${(Math.floor(t * 2.5) % 3) + 1}`;
          handRY = -7;
          handRX = 2;
          break;
        case 'delegating':
          prop = 'prop-clipboard';
          propX = -4;
          propY = -3;
          icon = 'icon-arrow';
          iconY = -19 + Math.round(Math.sin(t * 4));
          handRY = -6 - (Math.floor(t * 3) % 2);
          handRX = 5;
          break;
        case 'waiting':
          icon = 'icon-question';
          iconY = -19 + Math.round(Math.sin(t * 3) * 1.5);
          break;
        case 'blocked':
          icon = 'icon-bang';
          iconAlpha = Math.floor(t * 3) % 2 ? 1 : 0.35;
          shakeX = Math.floor(t * 12) % 4 === 0 ? 1 : 0;
          break;
        case 'idle':
          if (Math.floor(t / 3) % 2 === 0) {
            icon = 'icon-zz';
            iconAlpha = 0.8;
          } else prop = 'prop-cup';
          propX = 4;
          propY = -4;
          break;
        case 'done':
          icon = 'icon-check';
          break;
      }
      // Guild costume prop (staff/wand/hammer/quill/lute/shield): a default held item for whatever
      // activity didn't already pick a themed one, e.g. thinking, waiting, blocked or half of idle
      // (docs/design/guild-hall.md: "hand props ... replacing the laptop when not typing" — typing
      // already claimed `prop` above, so this only ever fills the gap).
      if (!prop && !poseAnim && this.costumeProp) prop = this.costumeProp;
      if (this.status === 'waiting' && !icon) icon = 'icon-question';
      if (this.status === 'blocked' && !icon) icon = 'icon-bang';
      // M12 antic emote: only where no activity/status icon was picked (or the idle zz); `?` / `!` always win.
      if (this.dramaEmote && (!icon || icon === 'icon-zz')) {
        icon = EMOTE_ICON[this.dramaEmote];
        iconAlpha = 1;
        iconY = -19 + Math.round(Math.sin(t * 4));
      }
      if (now < this.waveUntil) {
        handRX = 5;
        handRY = -9 - (Math.floor(t * 8) % 2) * 2;
      }
    }

    // M12 strain: motion only when animated (off under reduced motion / ambientEffects off).
    const strain = this.strainKind;
    if (strain && !walking) {
      if (this.strainAnimated) {
        if (strain === 'tired') {
          bob += 1;
          handRY += 1;
        } else if (strain === 'dizzy') shakeX += Math.round(Math.sin(t * Math.PI * 2));
        if (strain === 'dizzy') this.strainIcon.setTexture(DIZZY_FRAMES[Math.floor(t * 6) % DIZZY_FRAMES.length]!);
      }
    }
    if (strain) {
      const anim = this.strainAnimated;
      const drip = strain === 'sweating' && anim ? Math.floor(((t * 1.5) % 1) * 4) : 0;
      this.strainIcon.setPosition(6, -17 + drip + bob);
      this.strainIcon.setAlpha(strain === 'tired' && anim ? 0.65 + 0.35 * Math.abs(Math.sin(t * 1.5)) : 1);
    }

    const lie = !!poseAnim?.lie;
    this.upper.setPosition(shakeX + (lie ? -8 : 0), bob + (lie ? -1 : 0));
    this.upper.setRotation(lie ? Math.PI / 2 : 0);
    this.legs.setRotation(lie ? -Math.PI / 2 : 0).setPosition(lie ? -8 : 0, lie ? -1 : 0);
    if (this.creature) {
      const alt = walking && Math.floor(t * 8) % 2 === 1;
      this.creatureImg.setTexture(creatureTextureKey(this.creature, alt ? 1 : 0)).setPosition(shakeX, bob).setScale(this.upper.scaleX, 1);
    }
    this.handL.setPosition(handLX, handLY);
    this.handR.setPosition(handRX, handRY);
    if (prop) {
      if (this.prop.texture.key !== prop) this.prop.setTexture(prop).setFlipX(false);
      this.prop.setVisible(true).setPosition(propX, propY);
    } else this.prop.setVisible(false);
    if (icon) {
      if (this.icon.texture.key !== icon) this.icon.setTexture(icon);
      this.icon.setVisible(true).setPosition(0, iconY + bob).setAlpha(iconAlpha);
    } else this.icon.setVisible(false);
    const hasIcon = !!icon || strain !== null;
    this.plateIconUp = hasIcon;
    this.plate.setY(this.plateBottomY);
    // The GM chip sits just past the right end of the name line.
    if (this.chip) {
      const s = this.plateScale;
      const h = this.plateLayout?.h ?? 0;
      const nameMid = PIXEL_METRICS.pad + PIXEL_METRICS.lineH.name / 2;
      this.chip.setPosition(((this.plateLayout?.w ?? 0) * s) / 2 + 2, this.plateBottomY - (h - nameMid) * s);
    }
    // Base "above the head" position (a bit higher when an icon badge is up there too), plus this
    // frame's `layoutLabels` offset (0,0 until the first label refresh has run) — see `labelAnchor`.
    const baseY = (this.plateShown ? this.plateBottomY - this.plateWorldH : hasIcon ? -26 : -18) + bob;
    const bx = this.labelDx;
    const by = baseY + this.labelDy;
    this.bubble.setPosition(bx, by);
    this.updateBeacon(now, hasIcon, bx, by);
    this.leaderLine.clear();
    if (this.labelLeader && this.bubbleWantsShow && this.bubbleAllowedByLod) {
      this.leaderLine.lineStyle(1, 0xfdf6e3, 0.5);
      this.leaderLine.beginPath();
      this.leaderLine.moveTo(0, baseY + 2);
      this.leaderLine.lineTo(bx, by);
      this.leaderLine.strokePath();
    }
  }

  destroyAll() {
    this.glowPulse?.remove();
    this.fadeTween?.remove();
    this.scene.tweens.killTweensOf(this.bubble);
    this.strainFx.removeAll(true);
    this.dramaEmote = null;
    this.dramaBubble = false;
    this.plateMeasureText?.destroy();
    this.overlay.destroy();
    this.destroy();
  }
}
