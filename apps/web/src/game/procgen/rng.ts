/** Deterministic seeded RNG. Same seed (and same sub-stream label) always gives the same sequence. */

/** mulberry32: fast, small-state PRNG. `seed` is coerced to a uint32. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a string hash, used to derive sub-stream seeds from a label. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * An independent RNG stream for one part of generation (e.g. `room:<id>`, `doors`, `decor`).
 * Editing one room's seed-derived choices never reshuffles another room's.
 */
export function rngFor(seed: number, label: string): () => number {
  return mulberry32((seed ^ fnv1a(label)) >>> 0);
}

/** Pick an integer in [lo, hi] inclusive. */
export function randInt(rand: () => number, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** Pick one element of a non-empty array. */
export function pick<T>(rand: () => number, arr: readonly T[]): T {
  const item = arr[Math.floor(rand() * arr.length)];
  return item as T;
}
