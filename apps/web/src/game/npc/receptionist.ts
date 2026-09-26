import type * as Phaser from 'phaser';

/**
 * A self-contained Phaser NPC helper for the Receptionist (W3, docs/design/runner-and-helpdesk.md
 * §4.1: "A fixed NPC stands at the Guild Gate ... every floor and the Nexus"). Deliberately independent
 * of `game/actors/Character.ts` and the `ch-*` texture atlas `game/textures.ts` registers at boot: it
 * draws its own tiny desk-and-person sprite with `Phaser.GameObjects.Graphics`/`Text` created through
 * the scene's own factory (`scene.add.*`), so it can be dropped into any scene that already has one
 * (nothing to preload). Only `import type` on `phaser` — no runtime dependency on the module — so this
 * file can be unit-tested against a minimal mock `scene` without a real Phaser/canvas/WebGL context.
 *
 * W3b wires this into `OfficeScene`: one instance per floor, spawned/re-spawned at
 * `game/npc/receptionistSpot.ts#pickReceptionistSpot`'s tile.
 */

export interface ReceptionistNpcStyle {
  /** Desk + badge accent color. Defaults to a warm amber, distinct from any role color. */
  accent?: number;
  /** Robe/shirt color. Defaults to a neutral slate. */
  outfit?: number;
  /** Skin tone. Defaults to a mid tone matching `game/textures.ts`'s palette. */
  skin?: number;
}

export interface ReceptionistNpcOptions {
  x: number;
  y: number;
  style?: ReceptionistNpcStyle;
  onClick?: () => void;
}

export interface ReceptionistNpcHandle {
  /** Removes every game object this NPC created. Safe to call once; a no-op after. */
  destroy(): void;
  /** Toggles the "thinking" look (dimmed body, pulsing bubble) for one turn in flight (§4.1: "one
   *  turn at a time"). Idempotent. */
  setBusy(busy: boolean): void;
  /** Shows/hides the whole NPC (e.g. `settings.receptionist.enabled` toggled off) without losing its
   *  position or busy state, so re-enabling just flips it back rather than respawning. */
  setVisible(visible: boolean): void;
}

const DEFAULT_STYLE: Required<ReceptionistNpcStyle> = {
  accent: 0xf3c94d,
  outfit: 0x5b6b8c,
  skin: 0xe7b58c,
};

/**
 * A plain-object rectangle (not `Phaser.Geom.Rectangle` — this file only `import type`s `phaser`,
 * see the header comment) covering everything drawn below: the desk, body, bubble and name tag are
 * all centered on x=0 and drawn *upward* from the origin (the desk's "feet" point). Phaser's default
 * texture-based hit area for a sized-but-frameless object like this Container is `Rectangle(0, 0,
 * width, height)` — i.e. *below and to the right* of the origin — which would miss the whole visible
 * NPC and only ever catch the lower-right sliver of its shadow. `spawnReceptionist` passes this (and
 * `containsPoint` below) explicitly instead.
 */
const HIT_AREA = { x: -9, y: -55, width: 18, height: 59 };
const containsPoint = (rect: typeof HIT_AREA, x: number, y: number) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;

/**
 * Spawns the Receptionist NPC: a small desk in front, a person standing behind it, and a "?" speech
 * bubble above — the whole thing clickable (opens the chat panel via `onClick`). Origin is at the
 * desk's front-center "feet" point, matching `Character`'s own origin convention so callers can place
 * it with the same tile-to-world math.
 */
export function spawnReceptionist(scene: Phaser.Scene, opts: ReceptionistNpcOptions): ReceptionistNpcHandle {
  const style = { ...DEFAULT_STYLE, ...opts.style };

  const shadow = scene.add.ellipse(0, 1, 16, 5, 0x000000, 0.3);

  const desk = scene.add.graphics();
  desk.fillStyle(0x2d3142, 1);
  desk.fillRoundedRect(-9, -8, 18, 8, 1.5);
  desk.fillStyle(style.accent, 1);
  desk.fillRect(-9, -8, 18, 2);

  const body = scene.add.graphics();
  body.fillStyle(style.outfit, 1);
  body.fillRoundedRect(-5, -20, 10, 12, 2);
  body.fillStyle(style.skin, 1);
  body.fillCircle(0, -23, 4);
  body.fillStyle(0x2b2330, 1);
  body.fillRect(-3, -27, 6, 3); // hair

  const badge = scene.add.circle(4, -15, 1.6, style.accent);

  const bubbleBg = scene.add.graphics();
  const bubbleText = scene.add
    .text(0, -34, '?', { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '8px', color: '#2a2233' })
    .setOrigin(0.5, 0.5);
  const drawBubble = (busy: boolean) => {
    bubbleBg.clear();
    bubbleBg.fillStyle(0x1c1826, 0.35);
    bubbleBg.fillCircle(0.5, -33.5, 7);
    bubbleBg.fillStyle(busy ? 0xf3c94d : 0xfdf6e3, 1);
    bubbleBg.fillCircle(0, -34, 7);
    bubbleText.setText(busy ? '…' : '?');
  };
  drawBubble(false);

  // A small always-on tag (simpler than hooking into `game/labels.ts`'s zoom/collision layout,
  // which is built around `Character`'s `ActorKey`-keyed subjects): same font/colors as
  // `Character`'s own name tag, just standing in fixed above the head rather than following it.
  const nameTag = scene.add
    .text(0, -46, 'Receptionist', { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '5px', color: '#ffffff', backgroundColor: '#15121ecc', padding: { x: 1.5, y: 0.5 } })
    .setOrigin(0.5, 1);

  const container = scene.add.container(opts.x, opts.y, [shadow, desk, body, badge, bubbleBg, bubbleText, nameTag]);
  container.setInteractive({ hitArea: HIT_AREA, hitAreaCallback: containsPoint, useHandCursor: true });
  if (opts.onClick) container.on('pointerup', opts.onClick);

  let busyPulse: Phaser.Tweens.Tween | undefined;

  return {
    destroy() {
      busyPulse?.remove();
      container.destroy();
    },
    setVisible(visible: boolean) {
      container.setVisible(visible);
    },
    setBusy(busy: boolean) {
      drawBubble(busy);
      busyPulse?.remove();
      busyPulse = undefined;
      body.setAlpha(busy ? 0.75 : 1);
      if (busy) {
        busyPulse = scene.tweens.add({
          targets: bubbleText,
          alpha: { from: 1, to: 0.4 },
          duration: 500,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      } else {
        bubbleText.setAlpha(1);
      }
    },
  };
}
