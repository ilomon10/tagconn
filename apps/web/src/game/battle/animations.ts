// Pure animation descriptors for battle events (docs/design/battles.md 3.5). The scene runs each step with a tween and
// emits `sfx` on the step's first frame, so sound and motion start together.
import type { BattleEvent, Side } from '@tagconn/shared';
import type { SfxId } from '../sfxBus';
import { BATTLE_TIMING } from './types';

export type Who = 'hero' | 'enemy';
export type FxKind = 'slash' | 'sparkle' | 'shield' | 'stun' | 'conflict' | 'burnout' | 'buff' | 'item';
export type NumberTone = 'dmg' | 'crit' | 'super' | 'weak' | 'heal' | 'miss' | 'note';

interface Base { /** ms after the event starts. */ at: number; sfx?: SfxId }
export type AnimStep =
  | (Base & { op: 'lunge'; who: Who; px: number; ms: number })
  | (Base & { op: 'flash'; who: Who; ms: number })
  | (Base & { op: 'shake'; who: Who; px: number; ms: number })
  | (Base & { op: 'number'; who: Who; text: string; tone: NumberTone })
  | (Base & { op: 'fx'; who: Who; fx: FxKind })
  | (Base & { op: 'fade'; who: Who; ms: number; drop: number }) // faint: drop px + fade
  | (Base & { op: 'slide'; who: Who; ms: number }) // run: the hero slides off to the left
  | (Base & { op: 'swap'; to: number; ms: number }) // ms 0 = instant
  | (Base & { op: 'cue' }); // sound only

/** Ops that move a sprite; reduced motion never produces them. */
export const MOTION_OPS: readonly AnimStep['op'][] = ['lunge', 'shake', 'slide'];

const who = (s: Side): Who => (s.side === 'party' ? 'hero' : 'enemy');
const FLASH_MS = 34; // two frames at 60 fps

export function animFor(e: BattleEvent, reduced: boolean): AnimStep[] {
  const T = BATTLE_TIMING;
  switch (e.k) {
    case 'use':
      return reduced ? [] : [{ op: 'lunge', at: 0, who: who(e.by), px: 8, ms: T.lungeMs }];
    case 'damage': {
      const w = who(e.target);
      const sfx: SfxId = e.eff === 'super' ? 'battle-hit-super' : e.eff === 'weak' ? 'battle-hit-weak' : 'battle-hit';
      const tone: NumberTone = e.crit ? 'crit' : e.eff === 'super' ? 'super' : e.eff === 'weak' ? 'weak' : 'dmg';
      const steps: AnimStep[] = [
        { op: 'flash', at: 0, who: w, ms: reduced ? T.stingMs : FLASH_MS, sfx },
        { op: 'number', at: 0, who: w, text: String(e.amount), tone },
      ];
      if (!reduced) steps.push({ op: 'shake', at: 0, who: w, px: 3, ms: T.shakeMs });
      if (e.crit) steps.push({ op: 'cue', at: 0, sfx: 'battle-crit' });
      if (!e.selfHit) steps.push({ op: 'fx', at: 0, who: w, fx: 'slash' });
      return steps;
    }
    case 'miss':
      return [{ op: 'number', at: 0, who: who(e.by) === 'hero' ? 'enemy' : 'hero', text: 'MISS', tone: 'miss', sfx: 'battle-miss' }];
    case 'heal':
      return [
        { op: 'fx', at: 0, who: who(e.target), fx: 'sparkle', sfx: 'battle-heal' },
        { op: 'number', at: 0, who: who(e.target), text: `+${e.amount}`, tone: 'heal' },
      ];
    case 'status': {
      if (!e.on) return [];
      const map = {
        stunned: ['stun', 'battle-status'],
        'merge-conflict': ['conflict', 'battle-status'],
        burnout: ['burnout', 'battle-status'],
        buffed: ['buff', 'battle-buff'],
        shielded: ['shield', 'battle-shield'],
      } as const;
      const [fx, sfx] = map[e.status];
      return [{ op: 'fx', at: 0, who: who(e.target), fx, sfx }];
    }
    case 'resisted':
      return [{ op: 'number', at: 0, who: who(e.target), text: 'RESIST', tone: 'note', sfx: 'battle-status' }];
    case 'skip':
      return [{ op: 'fx', at: 0, who: who(e.by), fx: 'stun' }];
    case 'confused':
      return [{ op: 'fx', at: 0, who: who(e.by), fx: 'conflict' }];
    case 'faint': {
      const w = who(e.target);
      return [{ op: 'fade', at: 0, who: w, ms: reduced ? T.stingMs : T.faintMs, drop: reduced ? 0 : 6, sfx: w === 'hero' ? 'battle-faint' : 'battle-enemy-faint' }];
    }
    case 'swap':
      return [{ op: 'swap', at: 0, to: e.to, ms: reduced ? 0 : T.swapMs, sfx: 'battle-swap' }];
    case 'item':
      return [{ op: 'fx', at: 0, who: 'hero', fx: 'item', sfx: 'battle-item' }];
    case 'run':
      if (!e.ok) return [];
      return reduced
        ? [{ op: 'fade', at: 0, who: 'hero', ms: T.stingMs, drop: 0, sfx: 'battle-run' }]
        : [{ op: 'slide', at: 0, who: 'hero', ms: 400, sfx: 'battle-run' }];
    case 'start':
    case 'turn':
    case 'focus':
    case 'end':
      return [];
  }
}
