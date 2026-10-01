import { CLASS_MOVES, ENEMIES, ITEMS, MOVES, BASIC_MOVE, type BattleEvent, type BattleSetup, type BattleState, type CombatantSetup } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { encounterLine, resultHeader, battleText } from '../copy';

const mods = {} as CombatantSetup['mods'];
const stats = { hp: 100, atk: 60, def: 60, spd: 60, focus: 50 };
const hero: CombatantSetup = {
  ref: { kind: 'hero', heroId: 'h1' } as CombatantSetup['ref'], name: 'Brom', classId: 'developer', type: 'build', level: 3, stats,
  moves: [BASIC_MOVE.developer, CLASS_MOVES.developer[0]].map((id) => MOVES[id]!), mods, ai: null, temporary: false,
};
const wolf = ENEMIES.monster;
const enemy: CombatantSetup = {
  ref: { kind: 'enemy', npcKind: 'monster' }, name: 'monster', classId: null, type: 'bug', level: 3, stats: wolf.base,
  moves: wolf.moves.map((id) => MOVES[id]!), mods, ai: 'aggressive', temporary: false,
};
const setup = { engineVersion: 1, seed: 1, party: [hero], enemy, items: [{ def: ITEMS.coffee, count: 2 }], maxTurns: 30 } as unknown as BattleSetup;
const state = {} as BattleState;
const P = { side: 'party', index: 0 } as const, E = { side: 'enemy' } as const;

const events: BattleEvent[] = [
  { k: 'start' }, { k: 'use', by: P, move: 1 }, { k: 'item', item: 0, target: 0 },
  { k: 'damage', target: E, amount: 12, hp: 50, eff: 'super', crit: true, selfHit: false },
  { k: 'damage', target: P, amount: 4, hp: 50, eff: 'normal', crit: false, selfHit: true },
  { k: 'miss', by: E }, { k: 'heal', target: P, amount: 13, hp: 90 },
  { k: 'status', target: E, status: 'stunned', on: true }, { k: 'status', target: E, status: 'burnout', on: false },
  { k: 'status', target: P, status: 'shielded', on: true }, { k: 'resisted', target: P, status: 'merge-conflict' },
  { k: 'skip', by: E, reason: 'stunned' }, { k: 'confused', by: P }, { k: 'swap', from: 0, to: 0, forced: false }, { k: 'swap', from: 0, to: 0, forced: true },
  { k: 'faint', target: P }, { k: 'run', ok: true }, { k: 'run', ok: false },
  { k: 'end', result: 'won' }, { k: 'end', result: 'lost' }, { k: 'end', result: 'fled' }, { k: 'end', result: 'timeout' },
];

describe('battleText', () => {
  for (const style of ['modern', 'guild', 'rift'] as const) {
    it(`${style}: every non-silent event has a short line`, () => {
      for (const e of events) {
        const t = battleText(e, setup, state, style);
        expect(t, JSON.stringify(e)).not.toBe('');
        expect(t).not.toMatch(/undefined|\{|\?\?\?/);
        expect(t.length).toBeLessThanOrEqual(80);
      }
    });
  }
  it('turn and focus are silent', () => {
    expect(battleText({ k: 'turn', turn: 2 }, setup, state, 'modern')).toBe('');
    expect(battleText({ k: 'focus', target: P, amount: 1, focus: 2 }, setup, state, 'rift')).toBe('');
  });
  it('themes names and effectiveness', () => {
    expect(battleText({ k: 'use', by: P, move: 1 }, setup, state, 'guild')).toBe('Brom used Mending Rune!');
    expect(battleText({ k: 'damage', target: E, amount: 12, hp: 1, eff: 'super', crit: true, selfHit: false }, setup, state, 'rift'))
      .toBe("A critical hit! It's super effective! Glitch Entity took 12 damage.");
    expect(battleText({ k: 'item', item: 0, target: 0 }, setup, state, 'modern')).toBe('Brom used Coffee!');
    expect(battleText({ k: 'damage', target: P, amount: 4, hp: 1, eff: 'normal', crit: false, selfHit: true }, setup, state, 'modern'))
      .toBe('Brom is hit by its own merge conflict!');
  });
});

describe('encounter and results copy', () => {
  it('has a line per style and kind', () => {
    for (const s of ['modern', 'guild', 'rift'] as const) for (const k of ['guest', 'police', 'cia-agent', 'sales-dog', 'monster', 'office-cat'] as const) expect(encounterLine(s, k)).toBeTruthy();
  });
  it('fills the enemy into the header', () => {
    expect(resultHeader('modern', 'timeout', 'Sales Dog')).toBe('Sales Dog lost interest');
    expect(resultHeader('modern', 'won', 'x')).toBe('Victory!');
  });
});
