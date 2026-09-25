import * as Phaser from 'phaser';
import type { Activity, AgentStatus } from '@tagconn/shared';
import type { Point } from '../procgen/types';
import { HAIR_COLORS, HAIR_STYLES, SKIN_TONES } from '../textures';
import { CLOAK_TEXTURE, GOGGLES_TEXTURE, createActivityFx, hatTextureKey, staffTextureKey, type Costume } from '../themes';

export interface CharacterLook {
  color: number;
  title: string;
  description?: string;
  sprite: number;
}

const TEXT_RES = 4;
const SIT_ACTIVITIES: ReadonlySet<Activity> = new Set(['typing', 'reading', 'idle', 'thinking', 'running', 'meeting', 'waiting', 'blocked']);

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

function crisp(t: Phaser.GameObjects.Text) {
  t.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
  return t;
}

/**
 * A procedurally drawn pixel person. Origin is at the feet. The body lives in `this` (a container
 * depth-sorted by y); name tag and speech bubble live in `overlay` so they draw above everyone.
 */
export class Character extends Phaser.GameObjects.Container {
  readonly agentId: string;
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
  private cloak: Phaser.GameObjects.Image;
  private hat: Phaser.GameObjects.Image;
  private goggles: Phaser.GameObjects.Image;
  private fx: Phaser.GameObjects.Container;
  readonly overlay: Phaser.GameObjects.Container;
  private tag: Phaser.GameObjects.Text;
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
  private lastBubble = '';
  private lookKey = '';
  private costume: Costume = {};
  private costumeKey = '';
  private costumeProp: string | null = null;
  private fxKey = '';
  private phase: number;
  leaving = false;
  gone = false;

  constructor(scene: Phaser.Scene, agentId: string, x: number, y: number) {
    super(scene, x, y);
    this.agentId = agentId;
    const h = hash(agentId);
    this.phase = (h % 1000) / 1000;
    const skin = SKIN_TONES[h % SKIN_TONES.length]!;
    const hairColor = HAIR_COLORS[(h >>> 3) % HAIR_COLORS.length]!;

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
      this.prop,
    ]);
    this.icon = scene.add.image(0, -19, 'icon-dots-3').setOrigin(0.5, 1).setVisible(false);
    this.fx = scene.add.container(0, -8);
    this.add([this.shadow, this.legs, this.upper, this.icon, this.fx]);

    this.tag = crisp(
      scene.add
        .text(0, 3, '', { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '5px', color: '#ffffff', backgroundColor: '#15121ecc', padding: { x: 1.5, y: 0.5 }, resolution: TEXT_RES })
        .setOrigin(0.5, 0),
    );
    this.bubbleBg = scene.add.graphics();
    this.bubbleText = crisp(
      scene.add
        .text(0, 0, '', { fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: '6px', color: '#2a2233', wordWrap: { width: 90 }, resolution: TEXT_RES })
        .setOrigin(0.5, 1),
    );
    this.bubble = scene.add.container(0, -22, [this.bubbleBg, this.bubbleText]).setVisible(false);
    this.overlay = scene.add.container(x, y, [this.tag, this.bubble]);

    this.setInteractive(new Phaser.Geom.Rectangle(-7, -18, 14, 20), Phaser.Geom.Rectangle.Contains);
    if (this.input) this.input.cursor = 'pointer';
    scene.add.existing(this);
  }

  setLook(look: CharacterLook, showTag: boolean) {
    const k = `${look.color}|${look.title}|${look.description ?? ''}|${look.sprite}|${showTag}`;
    if (k === this.lookKey) return;
    this.lookKey = k;
    this.body_.setTint(look.color);
    this.badge.setTint(lighten(look.color, 0.6));
    this.hair.setTexture(`ch-hair-${Math.abs(look.sprite) % HAIR_STYLES}`);
    const desc = look.description ? ` · ${look.description.length > 22 ? `${look.description.slice(0, 21)}…` : look.description}` : '';
    this.tag.setText(`${look.title}${desc}`);
    this.tag.setColor(hex(lighten(look.color, 0.55)));
    this.tag.setVisible(showTag);
  }

  /** Guild costume for this role (hat/cloak/staff/goggles); a no-op `{}` under the modern theme. */
  setCostume(costume: Costume, roleColor: number) {
    const key = `${costume.robe ?? ''}|${costume.cloak ?? ''}|${costume.hat ?? ''}|${costume.hatColor ?? ''}|${costume.staff ?? ''}|${costume.goggles ?? ''}|${roleColor}`;
    if (key === this.costumeKey) return;
    this.costumeKey = key;
    this.costume = costume;
    if (costume.robe !== undefined) this.body_.setTint(costume.robe);
    if (costume.cloak !== undefined) this.cloak.setTexture(CLOAK_TEXTURE).setTint(costume.cloak).setVisible(true);
    else this.cloak.setVisible(false);
    if (costume.hat && costume.hat !== 'none') this.hat.setTexture(hatTextureKey(costume.hat)).setTint(costume.hatColor ?? roleColor).setVisible(true);
    else this.hat.setVisible(false);
    this.goggles.setVisible(!!costume.goggles);
    this.costumeProp = costume.staff && costume.staff !== 'none' ? staffTextureKey(costume.staff) : null;
  }

  /** Particle effect for the current activity (docs/design/guild-hall.md "Magic activity effects"). */
  setActivityFx(kind: 'sparkles' | 'bubbles' | 'rune' | 'channel' | 'none' | undefined, enabled: boolean) {
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

  /** Show `text` for `seconds` when it changes. */
  setBubble(text: string | undefined, seconds: number, enabled: boolean) {
    if (!enabled) {
      this.bubble.setVisible(false);
      this.bubbleUntil = 0;
      return;
    }
    const t = (text ?? '').trim();
    if (!t || t === this.lastBubble) return;
    this.lastBubble = t;
    this.bubbleText.setText(t.length > 60 ? `${t.slice(0, 59)}…` : t);
    const w = Math.ceil(this.bubbleText.width) + 6;
    const h = Math.ceil(this.bubbleText.height) + 3;
    const g = this.bubbleBg;
    g.clear();
    g.fillStyle(0x1c1826, 0.35);
    g.fillRoundedRect(-w / 2 + 1, -h + 1, w, h, 3);
    g.fillStyle(0xfdf6e3, 1);
    g.fillRoundedRect(-w / 2, -h, w, h, 3);
    g.fillTriangle(-2, -0.5, 2, -0.5, 0, 3);
    this.bubbleText.setPosition(0, -1.5);
    this.bubble.setVisible(true).setAlpha(1);
    this.bubbleUntil = this.scene.time.now + seconds * 1000;
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

  leave(path: Point[] | null) {
    this.leaving = true;
    const fade = () => {
      this.scene.tweens.add({
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
    this.overlay.setDepth(100_000 + this.y);
    if (this.bubbleUntil && now > this.bubbleUntil) {
      this.bubbleUntil = 0;
      this.scene.tweens.add({ targets: this.bubble, alpha: 0, duration: 400, onComplete: () => this.bubble.setVisible(false) });
    }
  }

  private animate(now: number) {
    const t = now / 1000 + this.phase * 10;
    const walking = this.path.length > 0;
    const sitting = !walking && this.seated && SIT_ACTIVITIES.has(this.activity);
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
      this.upper.scaleX = 1;
      switch (this.activity) {
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
      if (!prop && this.costumeProp) prop = this.costumeProp;
      if (this.status === 'waiting' && !icon) icon = 'icon-question';
      if (this.status === 'blocked' && !icon) icon = 'icon-bang';
      if (now < this.waveUntil) {
        handRX = 5;
        handRY = -9 - (Math.floor(t * 8) % 2) * 2;
      }
    }

    this.upper.setPosition(shakeX, bob);
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
    this.tag.setY(sitting ? 2 : 3);
    this.bubble.setY((icon ? -26 : -18) + bob);
  }

  destroyAll() {
    this.overlay.destroy();
    this.destroy();
  }
}
