/** mulberry32 as a pure step on a uint32 state (same constants as heroes.ts). No hidden state, no globals. */
export function rngNext(state: number): { value: number; state: number } {
  const a = ((state >>> 0) + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: (t ^ (t >>> 14)) >>> 0, state: a };
}

/** A fresh stream state for `seed` and a purpose `salt`: (seed ^ salt) >>> 0, advanced by one step. */
export function seedState(seed: number, salt: number): number {
  return rngNext((seed ^ salt) >>> 0).state;
}
