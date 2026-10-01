// M14 E1: should an encounter NPC offer a battle? Pure (docs/design/battles.md 3.3).
import { isBattleNpcKind, type Settings } from '@tagconn/shared';
import { dramaRng } from '../../game/drama';
import type { EncounterEvent } from '../../game/npc/types';

export interface EncounterRuleCtx {
  settings: Settings;
  /** Any live agent is waiting for / blocked on the user. */
  anyWaiting: boolean;
  /** Demo mode, or an admin session (the battle routes are admin). */
  canWrite: boolean;
  /** No other battle flow is in progress. */
  flowIdle: boolean;
  multiverse: boolean;
}

/** Every condition must hold; the offer chance is seeded by the NPC id, so asking twice gives one answer. */
export function shouldOfferEncounter(e: EncounterEvent, ctx: EncounterRuleCtx): boolean {
  const { battle, progression, office } = ctx.settings;
  return (
    e.phase === 'appeared' &&
    isBattleNpcKind(e.kind) &&
    battle.enabled &&
    progression.enabled &&
    office.alerts.enabled &&
    !ctx.multiverse &&
    ctx.flowIdle &&
    !ctx.anyWaiting &&
    ctx.canWrite &&
    dramaRng(`offer:${e.id}`)() < battle.offerChance
  );
}
