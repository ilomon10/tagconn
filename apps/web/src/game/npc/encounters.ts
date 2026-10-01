// M13 W1-15: the encounter table (docs/design/office-life.md 3.5.2). Pure data; no Phaser.
import type { NpcKind } from '@tagconn/shared';
import type { EncounterDef, HourCurve, NpcStep } from './types';

/** 24 weights: `peak` hours (inclusive ranges, wrapping past midnight) get `high`, the rest `low`. */
function curve(peaks: readonly (readonly [number, number])[], high = 1, low = 0): HourCurve {
  const out: number[] = Array.from({ length: 24 }, () => low);
  for (const [from, to] of peaks) {
    for (let h = from; ; h = (h + 1) % 24) {
      out[h] = high;
      if (h === to) break;
    }
  }
  return out;
}

const enter: NpcStep = { do: 'enter' };
const exit: NpcStep = { do: 'exit' };

/** Cat: 1 all day, 2 from 20:00 to 06:59. */
const CAT_HOURS: HourCurve = Array.from({ length: 24 }, (_, h) => (h >= 20 || h < 7 ? 2 : 1));

export const ENCOUNTERS: Readonly<Record<NpcKind, EncounterDef>> = {
  // Scheduled by janitorDue, not by weight.
  janitor: {
    kind: 'janitor', routine: true, weight: 0, hours: curve([[18, 23]]),
    steps: [enter, { do: 'sweep', tiles: 12 }, { do: 'goto', target: { furniture: ['bin'] } }, { do: 'bit', pose: 'sweep', sec: [4, 6] }, exit],
  },
  courier: {
    kind: 'courier', routine: true, weight: 3, hours: curve([[9, 17]]),
    steps: [enter, { do: 'goto', target: 'entrance' }, { do: 'bit', pose: 'carry', sec: [4, 6], line: true }, exit],
  },
  'plant-waterer': {
    kind: 'plant-waterer', routine: true, weight: 2, hours: curve([[7, 11]]),
    steps: [
      enter, { do: 'goto', target: { furniture: ['plant'] } }, { do: 'bit', pose: 'water', sec: [4, 4] },
      { do: 'wander', rooms: 1 }, { do: 'goto', target: { furniture: ['plant'] } }, { do: 'bit', pose: 'water', sec: [4, 4] }, exit,
    ],
  },
  guest: {
    kind: 'guest', routine: false, weight: 3, hours: curve([[9, 18]]),
    steps: [enter, { do: 'wander', rooms: 2 }, { do: 'goto', target: 'crowd' }, { do: 'bit', pose: 'chat', sec: [5, 7], line: true, react: 'gather' }, exit],
  },
  police: {
    kind: 'police', routine: false, weight: 1, hours: curve([[10, 22]]),
    steps: [enter, { do: 'goto', target: 'crowd' }, { do: 'bit', pose: 'cheer', sec: [4, 6], line: true, react: 'flee', sfx: 'whistle' }, exit],
  },
  'cia-agent': {
    kind: 'cia-agent', routine: false, weight: 1, hours: curve([[20, 4]]),
    steps: [enter, { do: 'wander', rooms: 3 }, { do: 'bit', pose: 'phone', sec: [5, 5], line: true }, exit],
  },
  'sales-dog': {
    kind: 'sales-dog', routine: false, weight: 2, hours: curve([[9, 17]]),
    steps: [enter, { do: 'goto', target: 'crowd' }, { do: 'bit', pose: 'cheer', sec: [5, 5], line: true, react: 'chase', sfx: 'bark' }, exit],
  },
  monster: {
    kind: 'monster', routine: false, weight: 1, hours: curve([[22, 5]]),
    steps: [enter, { do: 'wander', rooms: 2 }, { do: 'bit', pose: 'cheer', sec: [4, 4], line: true, react: 'flee', sfx: 'roar' }, exit],
  },
  'office-cat': {
    kind: 'office-cat', routine: false, weight: 3, hours: CAT_HOURS,
    steps: [enter, { do: 'goto', target: { furniture: ['sofa'] } }, { do: 'bit', pose: 'nap', sec: [8, 12], line: true, react: 'gather', sfx: 'meow' }, exit],
  },
};
