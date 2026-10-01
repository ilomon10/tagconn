// M14 C1: battle log, encounter and results copy (docs/design/battles.md 3.7). Lines stay short (one log row).
import type { BattleEvent, BattleNpcKind, BattleResult, BattleSetup, BattleState, CombatantSetup, Side } from '@tagconn/shared';
import type { BattleStyle } from '../../game/battle/types';
import { battleLabel } from './labels';

type StatusKey = 'stunned' | 'merge-conflict' | 'burnout' | 'buffed' | 'shielded';
/** `{n}` is the target's name. [applied, ended]. */
const STATUS_LINES: Record<BattleStyle, Record<StatusKey, readonly [string, string]>> = {
  modern: {
    stunned: ['{n} is stunned!', '{n} snaps out of it.'],
    'merge-conflict': ['{n} is stuck in a merge conflict!', '{n} resolved the conflict.'],
    burnout: ['{n} is burning out!', '{n} took a long weekend.'],
    buffed: ['{n} is fired up!', '{n} lost momentum.'],
    shielded: ['{n} is covered by tests!', '{n} lost coverage.'],
  },
  guild: {
    stunned: ['{n} is stunned!', '{n} shakes off the daze.'],
    'merge-conflict': ['{n} is tangled in a hex!', '{n} breaks free of the hex.'],
    burnout: ['{n} grows weary!', '{n} feels rested.'],
    buffed: ['{n} is inspired!', '{n} loses the spark.'],
    shielded: ['{n} is warded!', 'The ward on {n} fades.'],
  },
  rift: {
    stunned: ['{n} is stunned!', '{n} reboots.'],
    'merge-conflict': ['{n} is desynced!', '{n} resynced.'],
    burnout: ['{n} is overheating!', '{n} cooled down.'],
    buffed: ['{n} is overclocked!', '{n} powers down.'],
    shielded: ['{n} raised shields!', '{n} shields drop.'],
  },
};
const SELF_HIT: Record<BattleStyle, string> = {
  modern: '{n} is hit by its own merge conflict!',
  guild: '{n} is hit by its own hex!',
  rift: '{n} is hit by its own desync!',
};
const FAINT: Record<BattleStyle, string> = {
  modern: '{n} fainted!',
  guild: '{n} fell!',
  rift: '{n} went offline!',
};
const FLED: Record<BattleStyle, readonly [string, string]> = {
  modern: ['Got away safely!', "Couldn't get away!"],
  guild: ['Escaped into the shadows!', 'The way is blocked!'],
  rift: ['Warped out safely!', 'Warp drive failed!'],
};
const START: Record<BattleStyle, string> = {
  modern: '{e} wants a word!',
  guild: '{e} blocks the path!',
  rift: '{e} detected! Weapons hot.',
};
const SWAP: Record<BattleStyle, readonly [string, string]> = {
  modern: ['{a}, tag in for {b}!', '{a} steps up!'],
  guild: ['{b}, fall back! {a}, forward!', '{a} takes the front!'],
  rift: ['Swapping {b} for {a}.', '{a} is on deck.'],
};
const END: Record<BattleStyle, Record<BattleResult, string>> = {
  modern: { won: 'The coast is clear!', lost: 'The team was wiped out…', fled: 'Back to work.', timeout: '{e} lost interest.' },
  guild: { won: 'Victory is ours!', lost: 'The party has fallen…', fled: 'Back to the guild.', timeout: '{e} wandered off.' },
  rift: { won: 'Hostile neutralized.', lost: 'Crew offline…', fled: 'Back to the bridge.', timeout: '{e} lost the signal.' },
};

const fill = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '');

function enemyName(setup: BattleSetup, style: BattleStyle): string {
  const r = setup.enemy.ref;
  return r.kind === 'enemy' ? battleLabel(style, 'enemy', r.npcKind) : setup.enemy.name;
}
function sideName(side: Side, setup: BattleSetup, style: BattleStyle): string {
  return side.side === 'enemy' ? enemyName(setup, style) : (setup.party[side.index]?.name ?? '?');
}
function combatant(side: Side, setup: BattleSetup): CombatantSetup | undefined {
  return side.side === 'enemy' ? setup.enemy : setup.party[side.index];
}

/** The log line for an event; '' = silent (turn, focus). Uses the setup for names; `state` is the state after the event. */
export function battleText(e: BattleEvent, setup: BattleSetup, _state: BattleState, style: BattleStyle): string {
  const enemy = enemyName(setup, style);
  switch (e.k) {
    case 'turn':
    case 'focus':
      return '';
    case 'start':
      return fill(START[style], { e: enemy });
    case 'use': {
      const move = combatant(e.by, setup)?.moves[e.move];
      return `${sideName(e.by, setup, style)} used ${move ? battleLabel(style, 'move', move.id) : '???'}!`;
    }
    case 'item': {
      const item = setup.items[e.item]?.def.id;
      return `${setup.party[e.target]?.name ?? '?'} used ${item ? battleLabel(style, 'item', item) : '???'}!`;
    }
    case 'damage': {
      const n = sideName(e.target, setup, style);
      if (e.selfHit) return fill(SELF_HIT[style], { n });
      const lead = `${e.crit ? 'A critical hit! ' : ''}${e.eff === 'super' ? "It's super effective! " : e.eff === 'weak' ? "It's not very effective. " : ''}`;
      return `${lead}${n} took ${e.amount} damage.`;
    }
    case 'miss':
      return `${sideName(e.by, setup, style)} missed!`;
    case 'heal':
      return `${sideName(e.target, setup, style)} recovered ${e.amount} HP.`;
    case 'status': {
      const lines = STATUS_LINES[style][e.status];
      return fill(lines[e.on ? 0 : 1], { n: sideName(e.target, setup, style) });
    }
    case 'resisted':
      return `${sideName(e.target, setup, style)} resisted ${battleLabel(style, 'status', e.status)}!`;
    case 'skip':
      return `${sideName(e.by, setup, style)} is stunned and can't move!`;
    case 'confused':
      return `${sideName(e.by, setup, style)} is confused!`;
    case 'swap': {
      const a = setup.party[e.to]?.name ?? '?', b = setup.party[e.from]?.name ?? '?';
      return fill(SWAP[style][e.forced ? 1 : 0], { a, b });
    }
    case 'faint':
      return fill(FAINT[style], { n: sideName(e.target, setup, style) });
    case 'run':
      return FLED[style][e.ok ? 0 : 1];
    case 'end':
      return fill(END[style][e.result], { e: enemy });
  }
}

// ------------------------------------------------------------------ encounter and results

const ENCOUNTER: Record<BattleStyle, Record<BattleNpcKind, string>> = {
  modern: {
    guest: 'A guest is picking a fight over the Wi-Fi.',
    police: 'The Compliance Cop is writing you up!',
    'cia-agent': 'A suspicious agent wants your logs.',
    'sales-dog': 'A Sales Dog is pitching at you!',
    monster: 'A bug crawled out of production!',
    'office-cat': 'The office cat is walking on keyboards.',
  },
  guild: {
    guest: 'A wanderer demands a duel.',
    police: 'The Town Watch bars the way!',
    'cia-agent': 'A royal spy steps from the shadows.',
    'sales-dog': 'A Merchant Hound sniffs your purse!',
    monster: 'A slime oozes from the cellar!',
    'office-cat': 'The guild cat arches its back.',
  },
  rift: {
    guest: 'A visitor is hostile on deck two.',
    police: 'A Patrol Droid demands your papers!',
    'cia-agent': 'Agent Zero has locked onto you.',
    'sales-dog': 'A Sales Hound is hailing you!',
    monster: 'A glitch entity tore through the hull!',
    'office-cat': 'The station cat is on the console.',
  },
};
export const encounterLine = (style: BattleStyle, kind: BattleNpcKind): string => ENCOUNTER[style][kind];

const RESULT_HEADER: Record<BattleStyle, Record<BattleResult, string>> = {
  modern: { won: 'Victory!', lost: 'Defeated…', fled: 'Got away safely', timeout: '{e} lost interest' },
  guild: { won: 'Victory!', lost: 'Defeated…', fled: 'Escaped the fray', timeout: '{e} wandered off' },
  rift: { won: 'Mission clear!', lost: 'Crew down…', fled: 'Warped out safely', timeout: '{e} lost the signal' },
};
export const resultHeader = (style: BattleStyle, result: BattleResult, enemy: string): string => fill(RESULT_HEADER[style][result], { e: enemy });

export const levelUpLine = (from: number, to: number): string => `Level up! ${from} → ${to}`;
export const lootLine = (style: BattleStyle, lootId: string, hero: string): string => `🎁 ${battleLabel(style, 'loot', lootId)} for ${hero}`;
