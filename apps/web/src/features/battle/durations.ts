// M14 C1: event durations (docs/design/battles.md 3.7).
import type { BattleEvent } from '@tagconn/shared';

export const BASE_DURATION_MS: Readonly<Record<BattleEvent['k'], number>> = {
  use: 450, damage: 650, miss: 500, heal: 550, status: 600, resisted: 500, skip: 550, confused: 550, swap: 600, faint: 900, item: 550, run: 700, end: 900,
  start: 0, turn: 0, focus: 0,
};
const REDUCED_FACTOR = 0.6;
const REDUCED_MIN_MS = 300;

/** Base time, at least long enough to read `text`; reduced motion keeps 60 % (min 300). start/turn/focus stay 0. */
export function eventDurationMs(e: BattleEvent, text: string, reduced: boolean): number {
  const base = BASE_DURATION_MS[e.k];
  if (base === 0) return 0;
  const ms = Math.max(base, (text.length / 40) * 1000 + 250);
  return reduced ? Math.max(REDUCED_MIN_MS, Math.round(ms * REDUCED_FACTOR)) : Math.round(ms);
}
