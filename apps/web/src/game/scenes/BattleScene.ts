// M14 G2: the battle stage (docs/design/battles.md 3.5). Phaser draws backdrop, platforms, sprites, hit effects and the
// swirl transitions; the DOM HUD owns bars, log and commands. Both follow one BattleController.
import * as Phaser from 'phaser';
import type { BattleEvent, BattleNpcKind } from '@tagconn/shared';
import { getTheme, prefersReducedMotion } from '../themes';
import { resolveCostume } from '../lookResolver';
import { anonymousAppearance, paintPortrait } from '../heroPreview';
import { sfxBus, type SfxId } from '../sfxBus';
import { BATTLE_SCENE_KEY, BATTLE_TIMING, type BattleSceneHandle, type BattleSceneInput, type BattleStyle, type BattlerLook, type LaunchBattle, type StageInsets } from '../battle/types';
import { ENEMY_SPRITE_H, HERO_SPRITE_H, stageLayout, type Ellipse, type StageLayout } from '../battle/stageLayout';
import { irisFullRadius, irisPolygons, swirlWedges, type Polygon } from '../battle/swirl';
import { enemyTextureKey, paintEnemyTexture } from '../battle/enemyArt';
import { paintFxTextures } from '../battle/fxArt';
import { animFor, type AnimStep, type FxKind, type NumberTone, type Who } from '../battle/animations';

const HERO_TEX = (i: number): string => `battle-hero-${i}`;
const HERO_ORIGIN_Y = 22 / 32; // the feet row of `paintPortrait`'s 32x32 frame
const FX_GLYPH: Record<FxKind, string> = { slash: '/', sparkle: '+', shield: 'O', stun: '* *', conflict: '<<>>', burnout: '^', buff: '^', item: '+' };
const TONE_COLOR: Record<NumberTone, { fill: string; stroke: string }> = {
  dmg: { fill: '#ffffff', stroke: '#7a1d1d' },
  crit: { fill: '#ffd84a', stroke: '#7a1d1d' },
  super: { fill: '#ffb347', stroke: '#5a2a0a' },
  weak: { fill: '#9aa4b2', stroke: '#222a36' },
  heal: { fill: '#6be675', stroke: '#14501c' },
  miss: { fill: '#c8ccd6', stroke: '#222a36' },
  note: { fill: '#9ad7ff', stroke: '#16344d' },
};
const FX_TEX: Record<FxKind, string> = { slash: 'fx-slash', sparkle: 'fx-heal', shield: 'fx-shield', stun: 'fx-stun', conflict: 'fx-merge', burnout: 'fx-burnout', buff: 'fx-buff', item: 'fx-sparkle' };
const BLACK = 0x000000;

/** Cheap deterministic hash for the starfield and flagstones (no RNG: the same stage every time). */
const hash = (n: number): number => {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export interface BattleSceneHooks {
  resolveReady(): void;
  /** The entry transition may already be skipped by `close`/`destroy`. */
  closed(): void;
}

export class BattleScene extends Phaser.Scene {
  private input_: BattleSceneInput;
  private insets: StageInsets;
  private readonly hooks: BattleSceneHooks;
  private readonly reduced: boolean;
  private layout!: StageLayout;
  private stage!: Phaser.GameObjects.Container;
  private backdrop!: Phaser.GameObjects.Graphics;
  private platforms!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Graphics;
  private heroSprite!: Phaser.GameObjects.Image;
  private enemySprite!: Phaser.GameObjects.Image;
  private activeHero = 0;
  private lastSeq = -1;
  private unsub: (() => void) | null = null;
  private heroTextures: string[] = [];
  private musicOn = false;
  private offsetX = { hero: 0, enemy: 0 }; // entry/run slide offsets applied on top of the layout
  private enemyKey: { kind: BattleNpcKind; style: BattleStyle } | null = null;
  private idleTimer: Phaser.Time.TimerEvent | null = null;

  constructor(input: BattleSceneInput, hooks: BattleSceneHooks) {
    super({ key: BATTLE_SCENE_KEY });
    this.input_ = input;
    this.insets = input.insets;
    this.hooks = hooks;
    this.reduced = input.reducedMotion || prefersReducedMotion();
  }

  create(): void {
    const { controller, party, enemy } = this.input_;
    paintFxTextures(this);
    this.stage = this.add.container(0, 0).setVisible(false);
    this.backdrop = this.add.graphics();
    this.platforms = this.add.graphics();
    this.stage.add([this.backdrop, this.platforms]);

    party.forEach((look, i) => this.paintHeroTexture(i, look));
    this.activeHero = controller.view().state.active;
    this.heroSprite = this.add.image(0, 0, HERO_TEX(this.activeHero)).setOrigin(0.5, HERO_ORIGIN_Y).setFlipX(true);
    this.enemySprite = this.add.image(0, 0, this.enemyTexture(enemy)).setOrigin(0.5, 1);
    this.stage.add([this.heroSprite, this.enemySprite]);

    this.overlay = this.add.graphics().setDepth(1000);
    this.relayout();
    this.scale.on('resize', this.relayout, this);

    // Only items after the entry count; the stub controller may already hold a current item.
    this.lastSeq = controller.view().current?.seq ?? -1;
    this.unsub = controller.subscribe((v) => {
      const cur = v.current;
      if (cur && cur.seq !== this.lastSeq) {
        this.lastSeq = cur.seq;
        this.playEvent(cur.event);
      }
    });
    this.input.on('pointerdown', () => controller.skip());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);

    this.enter();
  }

  update(): void {
    this.input_.controller.tick(performance.now());
  }

  setInsets(i: StageInsets): void {
    this.insets = i;
    if (this.stage) this.relayout();
  }

  // ------------------------------------------------------------------ layout

  private relayout(): void {
    const { width: w, height: h } = this.scale;
    this.layout = stageLayout(w, h, this.insets.bottom);
    const l = this.layout;
    this.drawBackdrop(w, l.stageH, h, this.input_.style);
    this.platforms.clear();
    this.drawPlatform(l.enemyPlatform, this.input_.style);
    this.drawPlatform(l.heroPlatform, this.input_.style);
    this.heroSprite.setScale(l.hero.scale);
    this.enemySprite.setScale(l.enemy.scale);
    this.placeSprites();
  }

  private baseOf(who: Who): { x: number; y: number } {
    const p = who === 'hero' ? this.layout.hero : this.layout.enemy;
    return { x: p.x + this.offsetX[who], y: p.y };
  }

  private spriteOf(who: Who): Phaser.GameObjects.Image {
    return who === 'hero' ? this.heroSprite : this.enemySprite;
  }

  private placeSprites(): void {
    for (const who of ['hero', 'enemy'] as const) {
      const b = this.baseOf(who);
      this.spriteOf(who).setPosition(b.x, b.y);
    }
  }

  private drawPlatform(e: Ellipse, style: BattleStyle): void {
    const g = this.platforms;
    const [rim, top] = style === 'guild' ? [0x4a3b2a, 0x7a6448] : style === 'rift' ? [0x2a1f55, 0x5b46a8] : [0x39414f, 0x6d7a8f];
    g.fillStyle(BLACK, 0.3).fillEllipse(e.cx, e.cy + e.ry * 0.5, e.rx * 2, e.ry * 2);
    g.fillStyle(rim, 1).fillEllipse(e.cx, e.cy + e.ry * 0.25, e.rx * 2, e.ry * 2);
    g.fillStyle(top, 1).fillEllipse(e.cx, e.cy, e.rx * 2, e.ry * 2);
  }

  /** Painted down to the full canvas height `h`, so the translucent HUD panel never shows the void. */
  private drawBackdrop(w: number, stageH: number, h: number, style: BattleStyle): void {
    const g = this.backdrop;
    g.clear();
    const band = (y0: number, y1: number, steps: number, c0: number, c1: number, x0 = 0, x1 = w): void => {
      const c = Phaser.Display.Color.Interpolate;
      for (let i = 0; i < steps; i++) {
        const k = c.ColorWithColor(Phaser.Display.Color.ValueToColor(c0), Phaser.Display.Color.ValueToColor(c1), steps - 1, i);
        g.fillStyle(Phaser.Display.Color.GetColor(k.r, k.g, k.b), 1);
        const ya = y0 + ((y1 - y0) * i) / steps;
        g.fillRect(x0, Math.floor(ya), x1 - x0, Math.ceil((y1 - y0) / steps) + 1);
      }
    };
    const horizon = Math.floor(stageH * 0.52);
    if (style === 'rift') {
      band(0, h, 12, 0x0b0720, 0x2a1250);
      for (let i = 0; i < 4; i++) {
        g.fillStyle(0x6a3fd0, 0.07).fillEllipse(w * (0.25 + 0.2 * i), stageH * (0.3 + 0.12 * (i % 2)), w * (0.7 - 0.1 * i), stageH * 0.5);
      }
      const n = Math.min(160, Math.floor((w * stageH) / 2500));
      for (let i = 0; i < n; i++) {
        const big = hash(i * 7 + 3) > 0.9;
        g.fillStyle(big ? 0xffffff : 0xb9a6ff, 0.4 + hash(i * 13) * 0.6);
        const s = big ? 2 : 1;
        g.fillRect(Math.floor(hash(i * 3 + 1) * w), Math.floor(hash(i * 5 + 2) * stageH), s, s);
      }
      return;
    }
    if (style === 'guild') {
      band(0, horizon, 8, 0x2a2233, 0x4a3b3a); // stone wall
      band(horizon, h, 8, 0x6b5a48, 0x4a3d30); // flagstones
      g.lineStyle(1, 0x2a2018, 0.55);
      for (let y = horizon + 14, r = 0; y < h; y += 14 + r * 4, r++) {
        g.lineBetween(0, y, w, y);
        for (let x = (r % 2) * 24; x < w; x += 48) g.lineBetween(x, y, x, y + 14 + r * 4);
      }
      for (const bx of [0.12, 0.88]) { // banners
        g.fillStyle(0x8a1f2b, 1).fillRect(Math.floor(w * bx) - 10, 0, 20, Math.floor(horizon * 0.55));
        g.fillStyle(0xd9a441, 1).fillRect(Math.floor(w * bx) - 10, Math.floor(horizon * 0.55) - 3, 20, 3);
      }
      const tx = Math.floor(w * 0.5);
      const ty = Math.floor(horizon * 0.5);
      for (let r = 5; r >= 1; r--) g.fillStyle(0xffb347, 0.07).fillCircle(tx, ty, r * 14); // torch glow
      g.fillStyle(0x3a2a1a, 1).fillRect(tx - 2, ty, 4, 14);
      g.fillStyle(0xffd070, 1).fillRect(tx - 3, ty - 6, 6, 7);
      return;
    }
    // modern: carpet, a window band and a desk silhouette
    band(0, horizon, 6, 0x2c3350, 0x39426a);
    band(horizon, h, 8, 0x3f4a63, 0x2a3247);
    g.fillStyle(0x0d1226, 1).fillRect(0, horizon - 3, w, 3);
    const winY = Math.floor(horizon * 0.18);
    const winH = Math.floor(horizon * 0.42);
    band(winY, winY + winH, 6, 0x6fb4ee, 0xcfe9ff, Math.floor(w * 0.1), Math.floor(w * 0.9));
    g.fillStyle(0x1c2238, 1);
    for (let x = Math.floor(w * 0.1); x <= w * 0.9; x += Math.floor((w * 0.8) / 4)) g.fillRect(x - 1, winY, 3, winH);
    g.fillRect(Math.floor(w * 0.1), winY, Math.floor(w * 0.8), 2).fillRect(Math.floor(w * 0.1), winY + winH, Math.floor(w * 0.8), 2);
    g.fillStyle(0x161b2e, 1).fillRect(Math.floor(w * 0.02), horizon - 14, Math.floor(w * 0.34), 14);
    g.fillRect(Math.floor(w * 0.04), horizon - 28, 18, 14);
  }

  // ------------------------------------------------------------------ textures

  private paintHeroTexture(i: number, look: BattlerLook): void {
    if (look.kind === 'enemy') return;
    const key = HERO_TEX(i);
    if (this.textures.exists(key)) this.textures.remove(key);
    const tex = this.textures.createCanvas(key, 32, 32);
    if (!tex) return;
    const ctx = tex.getContext();
    const appearance = look.kind === 'hero' ? look.appearance : anonymousAppearance(`battle:${look.role}:${i}`, 0);
    paintPortrait(ctx, { appearance, themeCostume: resolveCostume(getTheme(look.style), look.role), roleColor: look.roleColor, crop: 'full' });
    tex.refresh();
    this.heroTextures.push(key);
  }

  private enemyTexture(look: BattlerLook): string {
    if (look.kind === 'enemy') {
      this.enemyKey = { kind: look.npcKind, style: look.style };
      const key = paintEnemyTexture(this, look.npcKind, look.style);
      if (this.textures.exists(key)) return key;
    }
    return this.placeholderTexture();
  }

  private placeholderTexture(): string {
    const key = 'battle-enemy-ph';
    if (!this.textures.exists(key)) {
      const tex = this.textures.createCanvas(key, 20, ENEMY_SPRITE_H);
      if (tex) {
        const ctx = tex.getContext();
        ctx.fillStyle = '#7a3b8f';
        ctx.fillRect(2, 8, 16, 20);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(5, 13, 3, 3);
        ctx.fillRect(12, 13, 3, 3);
        tex.refresh();
      }
    }
    return key;
  }

  // ------------------------------------------------------------------ transitions

  private fillPolys(polys: Polygon[]): void {
    this.overlay.clear().fillStyle(BLACK, 1);
    for (const p of polys) this.overlay.fillPoints(p, true);
  }

  private startMusic(): void {
    this.musicOn = true;
    sfxBus.setMusic({ kind: 'battle', style: this.input_.style, fadeMs: BATTLE_TIMING.musicFadeMs });
  }

  private enter(): void {
    const T = BATTLE_TIMING;
    const { width: w, height: h } = this.scale;
    if (this.reduced) {
      this.stage.setVisible(true);
      this.overlay.clear().fillStyle(BLACK, 1).fillRect(0, 0, w, h);
      sfxBus.emit({ id: 'battle-sting' });
      this.startMusic();
      this.startIdle();
      this.tweens.add({ targets: this.overlay, alpha: { from: 1, to: 0 }, duration: T.stingMs, onComplete: () => { this.overlay.clear().setAlpha(1); this.hooks.resolveReady(); } });
      return;
    }
    const sw = { t: 0 };
    this.tweens.add({
      targets: sw,
      t: 1,
      duration: T.swirlMs,
      ease: 'Sine.easeIn',
      onStart: () => sfxBus.emit({ id: 'battle-swirl' }),
      onUpdate: () => this.fillPolys(swirlWedges(sw.t, this.scale.width, this.scale.height)),
      onComplete: () => {
        this.stage.setVisible(true);
        this.offsetX.enemy = this.scale.width * 0.5;
        this.placeSprites();
        this.fillPolys(irisPolygons(0, this.scale.width, this.scale.height));
        this.time.delayedCall(T.holdMs, () => this.reveal());
      },
    });
  }

  private reveal(): void {
    const T = BATTLE_TIMING;
    const iris = { r: 0 };
    const full = irisFullRadius(this.scale.width, this.scale.height);
    this.startMusic();
    this.tweens.add({
      targets: this.offsetX,
      enemy: 0,
      duration: T.revealMs,
      ease: 'Cubic.easeOut',
      onUpdate: () => this.placeSprites(),
    });
    this.tweens.add({
      targets: iris,
      r: full,
      duration: T.revealMs,
      ease: 'Sine.easeOut',
      onUpdate: () => this.fillPolys(irisPolygons(iris.r, this.scale.width, this.scale.height)),
      onComplete: () => {
        this.overlay.clear();
        this.startIdle();
        this.hooks.resolveReady();
      },
    });
  }

  /** Return transition. Resolves when the stage is gone and the office is visible. */
  leave(): Promise<void> {
    const T = BATTLE_TIMING;
    return new Promise((resolve) => {
      const done = (): void => {
        this.stage.setVisible(false);
        this.hooks.closed();
        resolve();
      };
      this.tweens.killTweensOf(this.overlay);
      const start = (): void => {
        sfxBus.emit({ id: 'battle-return' });
        if (this.musicOn) sfxBus.setMusic(null, { fadeMs: BATTLE_TIMING.returnMs });
        this.musicOn = false;
      };
      if (this.reduced) {
        const { width: w, height: h } = this.scale;
        this.overlay.clear().fillStyle(BLACK, 1).fillRect(0, 0, w, h).setAlpha(0);
        this.tweens.add({ targets: this.overlay, alpha: 1, duration: T.stingMs, onStart: start, onComplete: done });
        return;
      }
      const iris = { r: irisFullRadius(this.scale.width, this.scale.height) };
      this.tweens.add({
        targets: iris,
        r: 0,
        duration: T.returnMs,
        ease: 'Sine.easeIn',
        onStart: start,
        onUpdate: () => this.fillPolys(irisPolygons(iris.r, this.scale.width, this.scale.height)),
        onComplete: () => {
          this.fillPolys(irisPolygons(0, this.scale.width, this.scale.height));
          done();
        },
      });
    });
  }

  private cleanup(): void {
    this.unsub?.();
    this.unsub = null;
    this.scale.off('resize', this.relayout, this);
    for (const key of this.heroTextures) if (this.textures.exists(key)) this.textures.remove(key);
    this.heroTextures = [];
    if (this.musicOn) sfxBus.setMusic(null);
    this.musicOn = false;
  }

  // ------------------------------------------------------------------ event animations

  private startIdle(): void {
    const k = this.enemyKey;
    if (this.reduced || this.idleTimer || !k) return;
    let frame: 0 | 1 = 0;
    // Two-frame idle: the enemy art's second frame, swapped on a slow beat.
    this.idleTimer = this.time.addEvent({
      delay: 520,
      loop: true,
      callback: () => {
        frame = frame === 0 ? 1 : 0;
        const key = enemyTextureKey(k.kind, k.style, frame);
        if (this.textures.exists(key)) this.enemySprite.setTexture(key);
      },
    });
  }

  private playEvent(e: BattleEvent): void {
    for (const step of animFor(e, this.reduced)) {
      if (step.at <= 0) this.runStep(step);
      else this.time.delayedCall(step.at, () => this.runStep(step));
    }
  }

  private emitSfx(sfx: SfxId | undefined): void {
    if (sfx) sfxBus.emit({ id: sfx });
  }

  /** Every step emits its sound in the `onStart` of the tween that begins its motion (same frame). */
  private runStep(s: AnimStep): void {
    const l = this.layout;
    switch (s.op) {
      case 'cue':
        this.emitSfx(s.sfx);
        return;
      case 'lunge': {
        const sp = this.spriteOf(s.who);
        const dir = s.who === 'hero' ? 1 : -1;
        const b = this.baseOf(s.who);
        this.tweens.add({ targets: sp, x: b.x + dir * s.px, y: b.y - dir * s.px * 0.5, duration: s.ms, yoyo: true, onStart: () => this.emitSfx(s.sfx), onComplete: () => sp.setPosition(b.x, b.y) });
        return;
      }
      case 'shake': {
        const sp = this.spriteOf(s.who);
        const b = this.baseOf(s.who);
        const k = { n: 0 };
        this.tweens.add({
          targets: k,
          n: 1,
          duration: s.ms,
          onUpdate: () => sp.setX(b.x + (Math.floor(k.n * 6) % 2 === 0 ? s.px : -s.px)),
          onComplete: () => sp.setX(b.x),
        });
        return;
      }
      case 'flash': {
        const sp = this.spriteOf(s.who);
        const k = { n: 0 };
        this.tweens.add({ targets: k, n: 1, duration: s.ms, onStart: () => { this.emitSfx(s.sfx); sp.setTintFill(0xffffff); }, onComplete: () => sp.clearTint() });
        return;
      }
      case 'number': {
        const a = s.who === 'hero' ? l.dmgAnchor.hero : l.dmgAnchor.enemy;
        const c = TONE_COLOR[s.tone];
        const size = Math.max(14, 4 * (s.who === 'hero' ? l.hero.scale : l.enemy.scale));
        const t = this.add.text(a.x, a.y, s.text, { fontFamily: 'monospace', fontStyle: 'bold', fontSize: `${size}px`, color: c.fill, stroke: c.stroke, strokeThickness: 3 }).setOrigin(0.5).setDepth(900);
        this.stage.add(t);
        this.tweens.add({
          targets: t,
          y: this.reduced ? a.y : a.y - 14,
          alpha: { from: 1, to: 0 },
          duration: 700,
          ease: 'Cubic.easeOut',
          onStart: () => this.emitSfx(s.sfx),
          onComplete: () => t.destroy(),
        });
        return;
      }
      case 'fx':
        this.runFx(s);
        return;
      case 'fade': {
        const sp = this.spriteOf(s.who);
        this.tweens.add({ targets: sp, alpha: 0, y: sp.y + s.drop, duration: s.ms, onStart: () => this.emitSfx(s.sfx) });
        return;
      }
      case 'slide': {
        const sp = this.spriteOf(s.who);
        this.tweens.add({ targets: sp, x: -sp.displayWidth, duration: s.ms, ease: 'Cubic.easeIn', onStart: () => this.emitSfx(s.sfx) });
        return;
      }
      case 'swap': {
        const to = Math.max(0, s.to);
        const sp = this.heroSprite;
        const b = this.baseOf('hero');
        const apply = (): void => {
          this.activeHero = to;
          if (this.textures.exists(HERO_TEX(to))) sp.setTexture(HERO_TEX(to));
          sp.setAlpha(1).clearTint();
        };
        if (s.ms <= 0) {
          this.emitSfx(s.sfx);
          apply();
          sp.setPosition(b.x, b.y);
          return;
        }
        const out = -sp.displayWidth;
        this.tweens.add({
          targets: sp,
          x: out,
          duration: s.ms / 2,
          ease: 'Cubic.easeIn',
          onStart: () => this.emitSfx(s.sfx),
          onComplete: () => {
            apply();
            this.tweens.add({ targets: sp, x: b.x, y: b.y, duration: s.ms / 2, ease: 'Cubic.easeOut' });
          },
        });
        return;
      }
    }
  }

  private runFx(s: Extract<AnimStep, { op: 'fx' }>): void {
    const l = this.layout;
    const sp = this.spriteOf(s.who);
    const scale = s.who === 'hero' ? l.hero.scale : l.enemy.scale;
    const spriteH = s.who === 'hero' ? HERO_SPRITE_H : ENEMY_SPRITE_H;
    const midY = sp.y - (spriteH * scale) / 2;
    const above = s.fx === 'slash' || s.fx === 'item' ? midY : sp.y - spriteH * scale - 6 * scale * 0.5;
    const key = FX_TEX[s.fx];
    let obj: Phaser.GameObjects.Image | Phaser.GameObjects.Text;
    if (this.textures.exists(key)) obj = this.add.image(sp.x, above, key).setScale(scale);
    else obj = this.add.text(sp.x, above, FX_GLYPH[s.fx], { fontFamily: 'monospace', fontStyle: 'bold', fontSize: `${Math.max(14, 4 * scale)}px`, color: '#ffe9a8', stroke: '#222a36', strokeThickness: 3 }).setOrigin(0.5);
    obj.setDepth(850);
    this.stage.add(obj);
    this.tweens.add({
      targets: obj,
      alpha: { from: 1, to: 0 },
      y: this.reduced ? above : above - 6,
      duration: s.fx === 'stun' || s.fx === 'shield' || s.fx === 'buff' || s.fx === 'burnout' || s.fx === 'conflict' ? 650 : 420,
      onStart: () => this.emitSfx(s.sfx),
      onComplete: () => obj.destroy(),
    });
  }
}

export const launchBattle: LaunchBattle = (game: Phaser.Game, input: BattleSceneInput, onClosed: () => void): BattleSceneHandle => {
  let closed = false;
  let removed = false;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => (resolveReady = r));
  let scene: BattleScene | null = null;
  let closing: Promise<void> | null = null;

  const removeScene = (): void => {
    if (removed) return;
    removed = true;
    try {
      if (game.scene.getScene(BATTLE_SCENE_KEY)) game.scene.remove(BATTLE_SCENE_KEY);
    } catch {
      /* the game is already gone */
    }
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    resolveReady();
    removeScene();
    onClosed();
  };

  try {
    if (game.scene.getScene(BATTLE_SCENE_KEY)) game.scene.remove(BATTLE_SCENE_KEY);
    scene = new BattleScene(input, { resolveReady: () => resolveReady(), closed: finish });
    game.scene.add(BATTLE_SCENE_KEY, scene, true);
  } catch {
    // No stage could be built: behave as an immediate close so the host never hangs.
    scene = null;
    finish();
  }

  return {
    ready,
    setInsets: (i) => scene?.setInsets(i),
    close: () => {
      if (closed) return Promise.resolve();
      closing ??= scene ? scene.leave() : Promise.resolve().then(finish);
      return closing;
    },
    destroy: finish,
  };
};
