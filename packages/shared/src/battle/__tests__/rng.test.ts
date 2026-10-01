import { describe, expect, it } from 'vitest';
import { rngNext, seedState } from '../rng.js';

describe('rng', () => {
  it('matches golden values', () => {
    const seq = (s: number) => {
      const out: number[] = [];
      let st = s;
      for (let i = 0; i < 3; i++) { const r = rngNext(st); out.push(r.value); st = r.state; }
      return out;
    };
    expect(seq(0)).toMatchInlineSnapshot(`
      [
        1144304738,
        1416247,
        958946056,
      ]
    `);
    expect(seq(1)).toMatchInlineSnapshot(`
      [
        2693262067,
        11749833,
        2265367787,
      ]
    `);
    expect(seq(0xffffffff)).toMatchInlineSnapshot(`
      [
        3850105811,
        813802916,
        3073704848,
      ]
    `);
  });
  it('values and states are uint32 and pure', () => {
    for (const s of [0, 1, 2 ** 31, 2 ** 32 - 1]) {
      const a = rngNext(s);
      expect(rngNext(s)).toEqual(a);
      expect(Number.isInteger(a.value) && a.value >= 0 && a.value < 2 ** 32).toBe(true);
      expect(Number.isInteger(a.state) && a.state >= 0 && a.state < 2 ** 32).toBe(true);
    }
  });
  it('seedState mixes the salt and is one step', () => {
    expect(seedState(5, 0)).toBe(rngNext(5).state);
    expect(seedState(5, 1)).not.toBe(seedState(5, 2));
    expect(seedState(2 ** 32 + 5, 0)).toBe(seedState(5, 0));
  });
});
