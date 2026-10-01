import { describe, expect, it } from 'vitest';
import type { BattleEvent } from '@tagconn/shared';
import { SFX_IDS } from '../../sfxBus';
import { animFor, MOTION_OPS } from '../animations';

const party = { side: 'party', index: 0 } as const;
const enemy = { side: 'enemy' } as const;
const events: BattleEvent[] = [
  { k: 'start' }, { k: 'turn', turn: 1 }, { k: 'use', by: party, move: 0 }, { k: 'item', item: 0, target: 0 },
  { k: 'damage', target: enemy, amount: 12, hp: 8, eff: 'super', crit: true, selfHit: false },
  { k: 'damage', target: party, amount: 3, hp: 8, eff: 'weak', crit: false, selfHit: true },
  { k: 'damage', target: party, amount: 3, hp: 8, eff: 'normal', crit: false, selfHit: false },
  { k: 'miss', by: enemy }, { k: 'heal', target: party, amount: 5, hp: 9 }, { k: 'focus', target: party, amount: 2, focus: 5 },
  { k: 'status', target: enemy, status: 'stunned', on: true }, { k: 'status', target: enemy, status: 'stunned', on: false },
  { k: 'status', target: party, status: 'merge-conflict', on: true }, { k: 'status', target: party, status: 'burnout', on: true },
  { k: 'status', target: party, status: 'buffed', on: true }, { k: 'status', target: party, status: 'shielded', on: true },
  { k: 'resisted', target: enemy, status: 'burnout' }, { k: 'skip', by: enemy, reason: 'stunned' }, { k: 'confused', by: party },
  { k: 'swap', from: 0, to: 1, forced: false }, { k: 'faint', target: party }, { k: 'faint', target: enemy },
  { k: 'run', ok: true }, { k: 'run', ok: false }, { k: 'end', result: 'won' },
];

describe('animFor', () => {
  it('is total over every event kind, with known sounds and sane offsets', () => {
    for (const reduced of [false, true]) {
      for (const e of events) {
        const steps = animFor(e, reduced);
        for (const s of steps) {
          expect(s.at).toBeGreaterThanOrEqual(0);
          if (s.sfx) expect(SFX_IDS).toContain(s.sfx);
        }
      }
    }
  });

  it('reduced motion produces no motion steps', () => {
    for (const e of events) {
      for (const s of animFor(e, true)) {
        expect(MOTION_OPS).not.toContain(s.op);
        if (s.op === 'swap') expect(s.ms).toBe(0);
        if (s.op === 'fade') expect(s.drop).toBe(0);
      }
    }
  });

  it('full motion lunges, shakes and slides', () => {
    expect(animFor(events[2]!, false).map((s) => s.op)).toEqual(['lunge']);
    expect(animFor(events[4]!, false).map((s) => s.op)).toEqual(expect.arrayContaining(['flash', 'shake', 'number', 'fx']));
    expect(animFor({ k: 'run', ok: true }, false).map((s) => s.op)).toEqual(['slide']);
  });

  it('picks the hit sound by effectiveness and overlays the crit cue', () => {
    const sfx = (e: BattleEvent) => animFor(e, false).flatMap((s) => (s.sfx ? [s.sfx] : []));
    expect(sfx(events[4]!)).toEqual(['battle-hit-super', 'battle-crit']);
    expect(sfx(events[5]!)).toEqual(['battle-hit-weak']);
    expect(sfx(events[6]!)).toEqual(['battle-hit']);
  });

  it('silent events and a status ending have no steps; a faint targets the right side', () => {
    expect(animFor({ k: 'turn', turn: 2 }, false)).toEqual([]);
    expect(animFor(events[11]!, false)).toEqual([]);
    expect(animFor(events[20]!, false)[0]).toMatchObject({ who: 'hero', sfx: 'battle-faint' });
    expect(animFor(events[21]!, false)[0]).toMatchObject({ who: 'enemy', sfx: 'battle-enemy-faint' });
  });
});
