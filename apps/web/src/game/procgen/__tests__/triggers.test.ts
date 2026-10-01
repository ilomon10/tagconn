import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, type OfficeLayout } from '@tagconn/shared';
import { generateRandomLayout } from '../bsp';
import { generateMap } from '../generate';
import { TRIGGER_KINDS, TRIGGER_ORDER } from '../../furnitureTriggers';
import type { GeneratedMap } from '../types';

function asLayout(input: ReturnType<typeof generateRandomLayout>, seed: number): OfficeLayout {
  return { ...input, background: input.background ?? 'hall', corridorWidth: input.corridorWidth ?? 2, id: `bsp${seed}`, builtin: false, createdAt: 0, updatedAt: 0 };
}

const actionsOf = (map: GeneratedMap) => map.furniture.filter((f) => f.trigger).map((f) => f.trigger!);
const unreachable = (map: GeneratedMap) => map.issues.filter((i) => i.code.startsWith('unreachable')).length;

describe('trigger pass', () => {
  it('marks at most one item per action, each of a qualifying kind', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const acts = actionsOf(map);
    expect(new Set(acts).size).toBe(acts.length);
    for (const f of map.furniture.filter((x) => x.trigger)) expect(TRIGGER_KINDS[f.trigger!]).toContain(f.kind);
  });

  it('DEFAULT_LAYOUT gets every action, including the infirmary', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    expect([...actionsOf(map)].sort()).toEqual([...TRIGGER_ORDER].sort());
  });

  it('places a coffee machine only when the floor has no coffee machine / water cooler, and marks exactly one', () => {
    let placedAny = false;
    for (let seed = 1; seed <= 40; seed++) {
      const layout = asLayout(generateRandomLayout({ width: 48, height: 30, seed }), seed);
      const on = generateMap(layout);
      const off = generateMap(layout, { triggers: false });
      const count = (m: GeneratedMap) => m.furniture.filter((f) => TRIGGER_KINDS.infirmary.includes(f.kind)).length;
      const marked = on.furniture.filter((f) => f.trigger === 'infirmary');
      if (count(off) > 0) expect(count(on), `seed ${seed}`).toBe(count(off));
      else if (count(on) > 0) {
        placedAny = true;
        expect(count(on), `seed ${seed}`).toBe(1);
        expect(marked[0]).toMatchObject({ kind: 'coffee-machine', w: 1, h: 1, blocking: true });
      }
      expect(marked.length, `seed ${seed}`).toBeLessThanOrEqual(1);
    }
    expect(placedAny).toBe(true);
  });

  it('is deterministic and skipped with triggers: false', () => {
    expect(generateMap(DEFAULT_LAYOUT)).toEqual(generateMap(DEFAULT_LAYOUT));
    const off = generateMap(DEFAULT_LAYOUT, { triggers: false });
    expect(off.furniture.some((f) => f.trigger)).toBe(false);
  });

  it('>= 95% of 200 BSP seeds have all five placed actions, never two of one, and add no unreachable issues', () => {
    let full = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const layout = asLayout(generateRandomLayout({ width: 48, height: 30, seed, background: seed % 2 ? 'hall' : 'void' }), seed);
      const on = generateMap(layout);
      const off = generateMap(layout, { triggers: false });
      const acts = actionsOf(on);
      expect(new Set(acts).size, `seed ${seed}`).toBe(acts.length);
      if (acts.filter((a) => a !== 'infirmary').length === TRIGGER_ORDER.length - 1) full++;
      expect(unreachable(on), `seed ${seed} unreachable`).toBeLessThanOrEqual(unreachable(off));
      expect(on.reachability.unreachableSeats, `seed ${seed} seats`).toBeLessThanOrEqual(off.reachability.unreachableSeats);
      expect(on.issues.filter((i) => i.severity === 'error').length, `seed ${seed} errors`).toBeLessThanOrEqual(off.issues.filter((i) => i.severity === 'error').length);
    }
    expect(full / 200).toBeGreaterThanOrEqual(0.95);
  }, 60000);

  it('placed trigger items sit inside their room, blocking, without seats, and on no door apron', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const layout = asLayout(generateRandomLayout({ width: 48, height: 30, seed }), seed);
      const map = generateMap(layout);
      const doorKeys = new Set(map.doors.map((d) => `${d.x},${d.y}`));
      for (const f of map.furniture.filter((x) => x.trigger && (x.kind === 'notice-board' || x.kind === 'roster-board'))) {
        const room = map.rooms.find((r) => r.id === f.roomId)!;
        expect(f.x).toBeGreaterThanOrEqual(room.interior.x);
        expect(f.x + f.w).toBeLessThanOrEqual(room.interior.x + room.interior.w);
        expect(f.blocking).toBe(true);
        for (let x = f.x; x < f.x + f.w; x++) {
          expect(room.seats.some((s) => s.x === x && s.y === f.y)).toBe(false);
          expect(doorKeys.has(`${x},${f.y}`)).toBe(false);
        }
      }
    }
  });
});
