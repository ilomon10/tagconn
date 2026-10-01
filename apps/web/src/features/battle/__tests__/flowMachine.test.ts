import { describe, expect, it } from 'vitest';
import type { BattleOutcome, BattleStart } from '@tagconn/shared';
import { IDLE, reduce } from '../flowMachine';
import type { EncounterOffer, FlowEvent, FlowState } from '../types';

const offer: EncounterOffer = { npcId: 'n-1', kind: 'sales-dog', name: 'Sales Dog', style: 'modern', projectId: 'p', at: 1 };
const start = { id: 'b-1', setup: {} } as unknown as BattleStart;
const outcome = (result: BattleOutcome['result']): BattleOutcome => ({ battleId: 'b-1', result, turns: 3, heroes: [], loot: null, resolvedAt: 5 });
const party = [{ kind: 'hero', heroId: 'h-00000001' }] as const;

function run(events: FlowEvent[], from: FlowState = IDLE) {
  let state = from;
  const effects: unknown[] = [];
  for (const e of events) {
    const r = reduce(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const toPicking: FlowEvent[] = [{ t: 'offer', offer }, { t: 'shown', npcId: 'n-1' }, { t: 'choice', npcId: 'n-1', choice: 'battle' }];
const toFighting: FlowEvent[] = [...toPicking, { t: 'pick', party }, { t: 'started', start }];

describe('flowMachine', () => {
  it('offer then shown holds the NPC', () => {
    const r = run([{ t: 'offer', offer }, { t: 'shown', npcId: 'n-1' }]);
    expect(r.state.phase).toBe('prompt');
    expect(r.effects).toEqual([{ do: 'hold', npcId: 'n-1' }]);
  });

  it('ignores an offer while busy and a shown for another NPC', () => {
    expect(run([{ t: 'offer', offer }, { t: 'offer', offer: { ...offer, npcId: 'n-2' } }]).state).toMatchObject({ phase: 'offered', offer: { npcId: 'n-1' } });
    expect(run([{ t: 'offer', offer }, { t: 'shown', npcId: 'x' }]).state.phase).toBe('offered');
  });

  it('withdraw before hold only drops the alert', () => {
    const r = run([{ t: 'offer', offer }, { t: 'withdraw', npcId: 'n-1' }]);
    expect(r.state.phase).toBe('idle');
    expect(r.effects).toEqual([{ do: 'withdrawAlert', npcId: 'n-1' }]);
  });

  it('withdraw while the prompt shows drops the alert and releases the NPC (waiting agent, NPC left)', () => {
    const r = run([{ t: 'offer', offer }, { t: 'shown', npcId: 'n-1' }, { t: 'withdraw', npcId: 'n-1' }]);
    expect(r.state.phase).toBe('idle');
    expect(r.effects).toEqual([{ do: 'hold', npcId: 'n-1' }, { do: 'withdrawAlert', npcId: 'n-1' }, { do: 'release', npcId: 'n-1' }]);
  });

  it('ignore and expiry release the NPC', () => {
    for (const choice of ['ignore', 'expired'] as const) {
      const r = run([{ t: 'offer', offer }, { t: 'shown', npcId: 'n-1' }, { t: 'choice', npcId: 'n-1', choice }]);
      expect(r.state.phase).toBe('idle');
      expect(r.effects.at(-1)).toEqual({ do: 'release', npcId: 'n-1' });
    }
  });

  it('battle goes to picking; cancel releases', () => {
    expect(run(toPicking).state.phase).toBe('picking');
    const r = run([{ t: 'cancel' }], run(toPicking).state);
    expect(r.state.phase).toBe('idle');
    expect(r.effects).toEqual([{ do: 'release', npcId: 'n-1' }]);
  });

  it('a battle choice before the prompt is shown is ignored', () => {
    expect(run([{ t: 'offer', offer }, { t: 'choice', npcId: 'n-1', choice: 'battle' }]).state.phase).toBe('offered');
  });

  it('an empty pick is ignored; a pick creates the battle', () => {
    expect(run([{ t: 'pick', party: [] }], run(toPicking).state).state.phase).toBe('picking');
    const r = run([{ t: 'pick', party }], run(toPicking).state);
    expect(r.state.phase).toBe('starting');
    expect(r.effects).toEqual([{ do: 'create', offer, party }]);
  });

  it('a failed create releases the NPC and shows the error; Continue leaves quietly', () => {
    const base = run([...toPicking, { t: 'pick', party }]);
    const failed = run([{ t: 'failed', message: 'rate limit' }], base.state);
    expect(failed.state).toEqual({ phase: 'error', offer, message: 'rate limit', start: null });
    expect(failed.effects).toEqual([{ do: 'release', npcId: 'n-1' }]);
    const done = run([{ t: 'close' }], failed.state);
    expect(done.state.phase).toBe('idle');
    expect(done.effects).toEqual([]);
  });

  it('started opens the scene; ended resolves with the log', () => {
    const f = run(toFighting);
    expect(f.state.phase).toBe('fighting');
    expect(f.effects.at(-1)).toEqual({ do: 'openScene', start });
    const log = [{ t: 'move', move: 0 }] as const;
    const r = run([{ t: 'ended', log, result: 'won', turns: 4 }], f.state);
    expect(r.state.phase).toBe('resolving');
    expect(r.effects).toEqual([{ do: 'resolve', start, log, result: 'won', turns: 4 }]);
  });

  it('won dismisses the NPC on Continue', () => {
    const f = run([{ t: 'ended', log: [], result: 'won', turns: 1 }, { t: 'resolved', outcome: outcome('won') }], run(toFighting).state);
    expect(f.state.phase).toBe('results');
    const r = run([{ t: 'close' }], f.state);
    expect(r.state.phase).toBe('idle');
    expect(r.effects).toEqual([{ do: 'closeScene' }, { do: 'dismiss', npcId: 'n-1' }]);
  });

  it('lost, fled and timeout release the NPC on Continue', () => {
    for (const result of ['lost', 'fled', 'timeout'] as const) {
      const f = run([{ t: 'ended', log: [], result, turns: 1 }, { t: 'resolved', outcome: outcome(result) }], run(toFighting).state);
      expect(run([{ t: 'close' }], f.state).effects).toEqual([{ do: 'closeScene' }, { do: 'release', npcId: 'n-1' }]);
    }
  });

  it('a failed resolve shows the error, keeps the scene, and releases on Continue', () => {
    const resolving = run([{ t: 'ended', log: [], result: 'won', turns: 1 }], run(toFighting).state);
    const failed = run([{ t: 'failed', message: 'desync' }], resolving.state);
    expect(failed.state).toMatchObject({ phase: 'error', start, message: 'desync' });
    expect(failed.effects).toEqual([]);
    expect(run([{ t: 'close' }], failed.state).effects).toEqual([{ do: 'closeScene' }, { do: 'release', npcId: 'n-1' }]);
  });

  it('unmount (close) mid-battle abandons it', () => {
    const r = run([{ t: 'close' }], run(toFighting).state);
    expect(r.state.phase).toBe('idle');
    expect(r.effects).toEqual([{ do: 'abandon', battleId: 'b-1' }, { do: 'closeScene' }, { do: 'release', npcId: 'n-1' }]);
  });

  it('close while the picker is open or the battle is starting releases the NPC', () => {
    expect(run([{ t: 'close' }], run(toPicking).state).effects).toEqual([{ do: 'release', npcId: 'n-1' }]);
    expect(run([{ t: 'close' }], run([...toPicking, { t: 'pick', party }]).state).effects).toEqual([{ do: 'release', npcId: 'n-1' }]);
  });

  it('stale async events are ignored once the flow is idle', () => {
    expect(run([{ t: 'started', start }, { t: 'resolved', outcome: outcome('won') }, { t: 'failed', message: 'x' }, { t: 'ended', log: [], result: 'won', turns: 1 }]).state).toBe(IDLE);
  });

  it('a withdraw does not interrupt the picker or a fight', () => {
    expect(run([{ t: 'withdraw', npcId: 'n-1' }], run(toPicking).state).state.phase).toBe('picking');
    expect(run([{ t: 'withdraw', npcId: 'n-1' }], run(toFighting).state).state.phase).toBe('fighting');
  });
});
