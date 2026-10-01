import type { BattleNpcKind, BattleOutcome, BattleResult, BattleStart, ClassId, PartyRef, PlayerAction } from '@tagconn/shared';
import type { BattleStyle } from '../../game/battle/types';

export interface EncounterOffer { npcId: string; kind: BattleNpcKind; name: string; style: BattleStyle; projectId: string; at: number }
export type EncounterChoice = 'battle' | 'ignore' | 'expired';

export interface PartyCandidate {
  key: string; // heroId or 'agent:<agentId>'
  ref: PartyRef;
  name: string;
  classId: ClassId;
  level: number;
  temporary: boolean;
  maxHp: number;
  working: boolean; // bound live agent, status active, activity not idle
  koUntil: number | null;
  selectable: boolean;
}

export type FlowState =
  | { phase: 'idle' }
  | { phase: 'offered'; offer: EncounterOffer } // waiting in the alert queue (not held yet)
  | { phase: 'prompt'; offer: EncounterOffer } // alert visible, NPC held
  | { phase: 'picking'; offer: EncounterOffer }
  | { phase: 'starting'; offer: EncounterOffer; party: readonly PartyRef[] }
  | { phase: 'fighting'; offer: EncounterOffer; start: BattleStart }
  | { phase: 'resolving'; offer: EncounterOffer; start: BattleStart; log: readonly PlayerAction[]; result: BattleResult; turns: number }
  | { phase: 'results'; offer: EncounterOffer; start: BattleStart; outcome: BattleOutcome }
  | { phase: 'error'; offer: EncounterOffer; message: string; start: BattleStart | null; /** Set when the failed resolve may be sent again (network / 5xx): the same log and expectation. */ retry?: { log: readonly PlayerAction[]; result: BattleResult; turns: number } };

export type FlowEvent =
  | { t: 'offer'; offer: EncounterOffer } | { t: 'shown'; npcId: string } | { t: 'choice'; npcId: string; choice: EncounterChoice }
  | { t: 'withdraw'; npcId: string } // NPC left / an agent started waiting (before 'picking')
  | { t: 'pick'; party: readonly PartyRef[] } | { t: 'cancel' } // picker cancelled
  | { t: 'started'; npcId: string; start: BattleStart } | { t: 'ended'; log: readonly PlayerAction[]; result: BattleResult; turns: number }
  | { t: 'resolved'; outcome: BattleOutcome }
  /** `for` is the NPC id (a failed create) or the battle id (a failed resolve / unusable battle); other keys are stale and ignored. */
  | { t: 'failed'; for: string; message: string; retryable?: boolean } | { t: 'retry' } | { t: 'close' };

export type FlowEffect =
  | { do: 'hold'; npcId: string } | { do: 'release'; npcId: string } | { do: 'dismiss'; npcId: string }
  | { do: 'withdrawAlert'; npcId: string }
  | { do: 'create'; offer: EncounterOffer; party: readonly PartyRef[] }
  | { do: 'openScene'; start: BattleStart } | { do: 'resolve'; start: BattleStart; log: readonly PlayerAction[]; result: BattleResult; turns: number }
  | { do: 'abandon'; battleId: string } | { do: 'closeScene' };
