import type { BattleEvent, BattleNpcKind, BattleResult, BattleSetup, BattleState, HeroAppearance, PlayerAction } from '@tagconn/shared';
import type * as Phaser from 'phaser';

export type BattleStyle = 'modern' | 'guild' | 'rift';
export const BATTLE_SCENE_KEY = 'battle';
/** ms. Reduced motion uses `stingMs` instead of swirl/hold/reveal and `returnMs` becomes a 120 ms fade. */
export const BATTLE_TIMING = { swirlMs: 650, holdMs: 100, revealMs: 250, returnMs: 300, stingMs: 120, lungeMs: 120, shakeMs: 160, faintMs: 400, swapMs: 250, musicFadeMs: 400 } as const;

export type BattlerLook =
  | { kind: 'hero'; appearance: HeroAppearance; role: string; roleColor: number; style: BattleStyle }
  | { kind: 'anon'; role: string; roleColor: number; style: BattleStyle }
  | { kind: 'enemy'; npcKind: BattleNpcKind; style: BattleStyle };

export interface TimelineItem { seq: number; event: BattleEvent; text: string; durationMs: number; startedAt: number }
export interface BattleView {
  setup: BattleSetup;
  /** State after every queued event (the HUD animates bars toward the values carried by `current`). */
  state: BattleState;
  current: TimelineItem | null;
  busy: boolean; // events still playing: commands disabled
  lines: readonly string[]; // full text of every played line (aria-live, scrollback)
  result: BattleResult | null; // set once the 'end' event has PLAYED
}
export interface ControllerOptions {
  text(e: BattleEvent, setup: BattleSetup, state: BattleState): string; // '' = silent event (no log line)
  durationMs(e: BattleEvent, text: string, reduced: boolean): number;
  reduced: boolean;
  now(): number;
}
export interface BattleController {
  view(): BattleView;
  subscribe(cb: (v: BattleView) => void): () => void;
  act(a: PlayerAction): { ok: true } | { ok: false; error: string }; // rejected while busy/ended/illegal
  tick(nowMs: number): void; // advances the timeline; called by the scene's update (and a RAF fallback in the HUD)
  skip(): void; // finish the current item now
  actionLog(): readonly PlayerAction[];
  destroy(): void;
}
export type CreateBattleController = (setup: BattleSetup, opts: ControllerOptions) => BattleController;

export interface StageInsets { bottom: number } // CSS px covered by the DOM command panel
export interface BattleSceneInput {
  controller: BattleController;
  style: BattleStyle;
  reducedMotion: boolean;
  party: readonly BattlerLook[];
  enemy: BattlerLook;
  insets: StageInsets;
}
export interface BattleSceneHandle {
  /** Resolves when the entry transition finished (the HUD shows after it). */
  readonly ready: Promise<void>;
  setInsets(i: StageInsets): void;
  /** Return transition, then the scene stops and `onClosed` runs; resolves once the office is visible. */
  close(): Promise<void>;
  /** Immediate teardown (unmount, game destroy). Idempotent. */
  destroy(): void;
}
/** Implemented in game/scenes/BattleScene.ts. */
export type LaunchBattle = (game: Phaser.Game, input: BattleSceneInput, onClosed: () => void) => BattleSceneHandle;
