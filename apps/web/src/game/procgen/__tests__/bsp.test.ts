import { describe, expect, it } from 'vitest';
import { hasLayoutErrors, LAYOUT_LIMITS, type OfficeLayout } from '@tagconn/shared';
import { generateRandomLayout } from '../bsp';
import { generateMap } from '../generate';
import { reachableFrom } from '../regions';

const SIZES: [number, number][] = [
  [32, 24],
  [48, 30],
  [64, 48],
  [128, 96],
];
const BACKGROUNDS = ['hall', 'void'] as const;

describe('generateRandomLayout', () => {
  it('is deterministic per seed', () => {
    const a = generateRandomLayout({ width: 48, height: 30, seed: 42, background: 'hall' });
    const b = generateRandomLayout({ width: 48, height: 30, seed: 42, background: 'hall' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never exceeds the room limit', () => {
    for (const [width, height] of SIZES) {
      for (const background of BACKGROUNDS) {
        const layout = generateRandomLayout({ width, height, seed: 7, background });
        expect(layout.rooms.length, `${width}x${height} ${background}`).toBeLessThanOrEqual(LAYOUT_LIMITS.maxRooms);
      }
    }
  });

  // Property test (acceptance criteria): 0 errors for seeds 1..300 at every listed size and
  // background, every seat and stairs landing reachable from spawn, and no blocking furniture on a
  // door or door apron tile.
  for (const [width, height] of SIZES) {
    for (const background of BACKGROUNDS) {
      it(`seeds 1..300 at ${width}x${height} (${background}) all produce a valid, fully reachable map`, async () => {
        // 300 full generateMap runs on a big grid is slower than vitest's default 5s budget, and
        // long enough on 128x96 to starve the worker's heartbeat if run fully synchronously - yield
        // periodically so the runner stays responsive.
        for (let seed = 1; seed <= 300; seed++) {
          if (seed % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
          const input = generateRandomLayout({ width, height, seed, background });
          const layout: OfficeLayout = {
            ...input,
            background: input.background ?? 'hall',
            corridorWidth: input.corridorWidth ?? 2,
            id: `s${seed}`,
            builtin: false,
            createdAt: 0,
            updatedAt: 0,
          };
          const map = generateMap(layout);
          const errors = map.issues.filter((i) => i.severity === 'error');
          expect(errors, `seed ${seed}`).toEqual([]);

          const reach = reachableFrom(map.walkable, map.spawn);
          const doorAprons = new Set<string>();
          for (const d of map.doors) {
            const dx = d.vertical ? 1 : 0;
            const dy = d.vertical ? 0 : 1;
            doorAprons.add(`${d.x - dx},${d.y - dy}`);
            doorAprons.add(`${d.x + dx},${d.y + dy}`);
          }
          const doorTiles = new Set(map.doors.map((d) => `${d.x},${d.y}`));

          for (const room of map.rooms) {
            for (const s of room.seats) {
              expect(reach.has(`${s.x},${s.y}`), `seed ${seed} seat ${room.id} ${s.x},${s.y}`).toBe(true);
            }
          }
          for (const s of map.stairs) {
            expect(reach.has(`${s.landing.x},${s.landing.y}`), `seed ${seed} stairs landing`).toBe(true);
          }
          for (const f of map.furniture) {
            if (!f.blocking) continue;
            for (let y = f.y; y < f.y + f.h; y++) {
              for (let x = f.x; x < f.x + f.w; x++) {
                const k = `${x},${y}`;
                expect(doorTiles.has(k), `seed ${seed} furniture on door ${k}`).toBe(false);
                expect(doorAprons.has(k), `seed ${seed} furniture on door apron ${k}`).toBe(false);
              }
            }
          }
        }
      }, 60000);
    }
  }
});
