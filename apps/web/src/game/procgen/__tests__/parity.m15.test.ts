// M15 T2 (docs/design/navigation.md section 5, property 2): integer layouts stay byte-identical across the
// half-tile rasterizer swap. The fixture was captured on `main` BEFORE geometry.ts replaced the local integer
// loops (`M15_PARITY_CAPTURE=1 vitest run parity.m15`), and every later change must reproduce it exactly.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, type OfficeLayout } from '@tagconn/shared';
import { generateRandomLayout } from '../bsp';
import { generateMap } from '../generate';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'm15-parity.json');
const BSP_SEEDS = [3, 17, 42] as const;

function asLayout(seed: number): OfficeLayout {
  const input = generateRandomLayout({ width: 48, height: 30, seed, background: seed % 2 ? 'hall' : 'void' });
  return { ...input, background: input.background ?? 'hall', corridorWidth: input.corridorWidth ?? 2, id: `bsp${seed}`, builtin: false, createdAt: 0, updatedAt: 0 };
}

function snapshot(layout: OfficeLayout): string {
  const map = generateMap(layout);
  return JSON.stringify({ furniture: map.furniture, rooms: map.rooms.map((r) => r.seats) });
}

function current(): Record<string, string> {
  const out: Record<string, string> = { default: snapshot(DEFAULT_LAYOUT) };
  for (const seed of BSP_SEEDS) out[`bsp${seed}`] = snapshot(asLayout(seed));
  return out;
}

describe('M15 parity: integer layouts are byte-identical to the pre-half-tile generator', () => {
  if (process.env.M15_PARITY_CAPTURE === '1') {
    it('captures the fixture (M15_PARITY_CAPTURE=1)', () => {
      writeFileSync(FIXTURE, JSON.stringify(current(), null, 0) + '\n');
      expect(existsSync(FIXTURE)).toBe(true);
    });
    return;
  }
  it('DEFAULT_LAYOUT and three BSP seeds reproduce fixtures/m15-parity.json', () => {
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
    const got = current();
    for (const k of Object.keys(expected)) expect(got[k], k).toBe(expected[k]);
    expect(Object.keys(got).sort()).toEqual(Object.keys(expected).sort());
  });
});
