// M14 F1: the battle flow as a pure reducer (docs/design/battles.md 3.3 / 3.10). `useBattleFlow` executes the effects.
import type { EncounterOffer, FlowEffect, FlowEvent, FlowState } from './types';

export const IDLE: FlowState = { phase: 'idle' };

export interface FlowStep {
  state: FlowState;
  effects: readonly FlowEffect[];
}

const stay = (state: FlowState): FlowStep => ({ state, effects: [] });
const to = (state: FlowState, ...effects: FlowEffect[]): FlowStep => ({ state, effects });

/** How the NPC leaves the encounter once the flow is over: defeated NPCs leave, everything else lets the script go on. */
const endEffect = (npcId: string, won: boolean): FlowEffect => (won ? { do: 'dismiss', npcId } : { do: 'release', npcId });

/** Pure transition. Events that do not fit the current phase are ignored (stale async results, double clicks). */
export function reduce(s: FlowState, e: FlowEvent): FlowStep {
  switch (e.t) {
    case 'offer':
      return s.phase === 'idle' ? stay({ phase: 'offered', offer: e.offer }) : stay(s);

    case 'shown':
      return s.phase === 'offered' && s.offer.npcId === e.npcId ? to({ phase: 'prompt', offer: s.offer }, { do: 'hold', npcId: e.npcId }) : stay(s);

    case 'choice': {
      if ((s.phase !== 'offered' && s.phase !== 'prompt') || s.offer.npcId !== e.npcId) return stay(s);
      if (e.choice === 'battle') return s.phase === 'prompt' ? stay({ phase: 'picking', offer: s.offer }) : stay(s);
      return to(IDLE, { do: 'release', npcId: e.npcId });
    }

    case 'withdraw': {
      if ((s.phase !== 'offered' && s.phase !== 'prompt') || s.offer.npcId !== e.npcId) return stay(s);
      // Before 'hold' there is nothing to release; the release is a no-op for a NPC that is already leaving.
      return s.phase === 'offered' ? to(IDLE, { do: 'withdrawAlert', npcId: e.npcId }) : to(IDLE, { do: 'withdrawAlert', npcId: e.npcId }, { do: 'release', npcId: e.npcId });
    }

    case 'cancel':
      return s.phase === 'picking' ? to(IDLE, { do: 'release', npcId: s.offer.npcId }) : stay(s);

    case 'pick':
      if (s.phase !== 'picking' || e.party.length === 0) return stay(s);
      return to({ phase: 'starting', offer: s.offer, party: e.party }, { do: 'create', offer: s.offer, party: e.party });

    case 'started':
      return s.phase === 'starting' ? to({ phase: 'fighting', offer: s.offer, start: e.start }, { do: 'openScene', start: e.start }) : stay(s);

    case 'ended':
      if (s.phase !== 'fighting') return stay(s);
      return to(
        { phase: 'resolving', offer: s.offer, start: s.start, log: e.log, result: e.result, turns: e.turns },
        { do: 'resolve', start: s.start, log: e.log, result: e.result, turns: e.turns },
      );

    case 'resolved':
      return s.phase === 'resolving' ? stay({ phase: 'results', offer: s.offer, start: s.start, outcome: e.outcome }) : stay(s);

    case 'failed':
      if (s.phase === 'starting') return to({ phase: 'error', offer: s.offer, message: e.message, start: null }, { do: 'release', npcId: s.offer.npcId });
      if (s.phase === 'resolving') return stay({ phase: 'error', offer: s.offer, message: e.message, start: s.start });
      return stay(s);

    case 'close':
      return close(s);
  }
}

/** Continue (results / error) or teardown (unmount, floor change): leaves the flow from wherever it is. */
function close(s: FlowState): FlowStep {
  switch (s.phase) {
    case 'idle':
      return stay(s);
    case 'offered':
      return to(IDLE, { do: 'withdrawAlert', npcId: s.offer.npcId });
    case 'prompt':
      return to(IDLE, { do: 'withdrawAlert', npcId: s.offer.npcId }, { do: 'release', npcId: s.offer.npcId });
    case 'picking':
    case 'starting': // a battle created after this is abandoned by the executor
      return to(IDLE, { do: 'release', npcId: s.offer.npcId });
    case 'fighting':
      return to(IDLE, { do: 'abandon', battleId: s.start.id }, { do: 'closeScene' }, { do: 'release', npcId: s.offer.npcId });
    case 'resolving': // the resolve call is in flight and the server records it
      return to(IDLE, { do: 'closeScene' }, { do: 'release', npcId: s.offer.npcId });
    case 'results':
      return to(IDLE, { do: 'closeScene' }, endEffect(s.offer.npcId, s.outcome.result === 'won'));
    case 'error':
      // A failed create already released the NPC; a failed resolve did not.
      return s.start ? to(IDLE, { do: 'closeScene' }, { do: 'release', npcId: s.offer.npcId }) : stay(IDLE);
  }
}

export const offerOf = (s: FlowState): EncounterOffer | null => (s.phase === 'idle' ? null : s.offer);
