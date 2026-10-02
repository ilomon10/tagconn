import { describe, expect, it } from 'vitest';
import { LAYOUT_LIMITS, ROOM_TYPES, SLOT_ID_RE, type Facing, type FurnishDensity, type RoomType } from '@tagconn/shared';
import {
  anchorCandidates,
  bestCandidate,
  buildPlan,
  CANDIDATES,
  DECOR_AFFINITY,
  fillRows,
  GROUPS,
  HALF_GAPS,
  isBlockingKind,
  MAX_FILL_INSTANCES,
  MAX_GROUP_INSTANCES,
  OccupancyGrid,
  relocate,
  ROOM_PLANS,
  rotateGroup,
  scoreCandidate,
  seatsFor,
  type PlacementCtx,
} from '../harmony';
import { decorateRoom, furnishRoom, type FurnishContext, type RecipeItem } from '../recipes';
import { rectsIntersect } from '../geometry';
import { mulberry32 } from '../rng';
import type { Rect } from '../types';

const SIDES = new Set<Facing>(['n', 'e', 's', 'w']);
const DENSITIES: FurnishDensity[] = ['sparse', 'normal', 'dense', 'packed'];
const ZONE_TYPES = ROOM_TYPES.filter((t) => ROOM_PLANS[t].length > 0) as RoomType[];

function ctxFor(interior: Rect, density: FurnishDensity = 'normal', extra: Partial<FurnishContext> = {}): PlacementCtx {
  return {
    aprons: new Set<string>(),
    wallSides: SIDES,
    pinned: [],
    consumedSlots: new Set<string>(),
    interior,
    density,
    aisle: 1,
    decor: 0.35,
    ...extra,
  };
}
const tile = (n: number) => ({ x: 0, y: 0, w: n, h: n });

describe('GROUPS and ROOM_PLANS data', () => {
  it('every plan entry names a real group; ids are valid slot-id groups', () => {
    for (const type of ROOM_TYPES) {
      for (const id of ROOM_PLANS[type]) {
        expect(Object.hasOwn(GROUPS, id), `${type}: ${id}`).toBe(true);
        expect(SLOT_ID_RE.test(`${id}:0`), id).toBe(true);
      }
    }
  });

  it('every group has exactly one anchor and half-aligned members', () => {
    for (const t of Object.values(GROUPS)) {
      const members = typeof t.members === 'function' ? t.members({ interior: { x: 0, y: 0, w: 20, h: 14 }, density: 'normal', aisle: 1, index: 0, slotH: 2 }) : t.members;
      expect(members.filter((m) => m.anchor).length, t.id).toBe(1);
      for (const m of members) {
        for (const v of [m.w, m.h, m.dx, m.dy]) expect(Number.isInteger(v * 2), `${t.id}.${m.kind}`).toBe(true);
      }
    }
  });

  it('kind lookups are own-property guarded', () => {
    expect(isBlockingKind('constructor')).toBe(false);
    expect(isBlockingKind('__proto__')).toBe(false);
    expect(isBlockingKind('work-desk')).toBe(true);
    expect(buildPlan('constructor' as RoomType, ctxFor(tile(10)))).toEqual([]);
    expect(buildPlan('__proto__' as RoomType, ctxFor(tile(10)))).toEqual([]);
  });
});

describe('rotateGroup', () => {
  const sofa = GROUPS['sofa-set']!;
  const members = sofa.members as ReturnType<NonNullable<Extract<typeof sofa.members, Function>>>;
  const resolved = (sofa.members as (c: unknown) => typeof members)({ interior: tile(12), density: 'normal', aisle: 1, index: 0 });

  it('keeps the anchor at the origin and swaps footprints for e/w', () => {
    for (const f of ['s', 'n', 'e', 'w'] as Facing[]) {
      const r = rotateGroup(sofa, f, resolved);
      const a = r.find((m) => m.anchor)!;
      expect([a.dx, a.dy], f).toEqual([0, 0]);
      const o = resolved.find((m) => m.anchor)!;
      expect(f === 'e' || f === 'w' ? [a.w, a.h] : [a.w, a.h]).toEqual(f === 'e' || f === 'w' ? [o.h, o.w] : [o.w, o.h]);
      expect(r).toHaveLength(resolved.length);
    }
  });

  it('puts the coffee table in front of the sofa for every facing', () => {
    const front: Record<Facing, (d: { dx: number; dy: number }) => boolean> = {
      s: (d) => d.dy > 0,
      n: (d) => d.dy < 0,
      e: (d) => d.dx > 0,
      w: (d) => d.dx < 0,
    };
    for (const f of ['s', 'n', 'e', 'w'] as Facing[]) {
      const r = rotateGroup(sofa, f, resolved);
      expect(front[f](r.find((m) => m.kind === 'table')!), f).toBe(true);
    }
  });

  it('rotates a member facing with the group (a chair facing n under a desk faces w when the group faces e)', () => {
    const desk = GROUPS.desk!;
    const r = rotateGroup(desk, 'e');
    expect(r.filter((m) => m.kind === 'chair').every((m) => m.facing === 'w')).toBe(true);
    // four quarter turns of the s frame are the s frame
    const back = rotateGroup(desk, 's');
    expect(back.map((m) => [m.dx, m.dy])).toEqual(desk.members instanceof Array ? desk.members.map((m) => [m.dx, m.dy]) : []);
  });
});

describe('OccupancyGrid', () => {
  const interior: Rect = { x: 3, y: 2, w: 6, h: 4 };

  it('lets two half-offset items share a tile without overlapping', () => {
    const g = new OccupancyGrid(interior);
    g.mark({ x: 3, y: 2, w: 1.5, h: 1 }, 1, 1);
    expect(g.canPlace({ x: 4.5, y: 2, w: 1, h: 1 }, 2)).toBe(true);
    expect(g.canPlace({ x: 4, y: 2, w: 1, h: 1 }, 2)).toBe(false);
    g.mark({ x: 4.5, y: 2, w: 1, h: 1 }, 1, 2);
    expect(g.tileBlocked(4, 2)).toBe(true); // conservative: any blocking cell blocks the tile
    expect(g.tileBlocked(3, 3)).toBe(false);
  });

  it('treats outside the interior as occupied and lets an owner overlap itself', () => {
    const g = new OccupancyGrid(interior);
    expect(g.canPlace({ x: 2, y: 2, w: 1, h: 1 }, 1)).toBe(false);
    expect(g.canPlace({ x: 8, y: 5, w: 2, h: 1 }, 1)).toBe(false);
    g.mark({ x: 4, y: 3, w: 2, h: 1 }, 1, 7);
    expect(g.canPlace({ x: 4, y: 3, w: 1, h: 1 }, 7)).toBe(true);
    expect(g.canPlace({ x: 4, y: 3, w: 1, h: 1 }, 8)).toBe(false);
    expect(g.canPlace({ x: 4, y: 3, w: 1, h: 1 }, 0)).toBe(false);
  });

  it('a pin or apron (owner 0) blocks everyone', () => {
    const g = new OccupancyGrid(interior);
    g.mark({ x: 3, y: 2, w: 1, h: 1 }, 3, 0);
    expect(g.canPlace({ x: 3, y: 2, w: 1, h: 1 }, 1)).toBe(false);
    expect(g.tileBlocked(3, 2)).toBe(false); // reserved is not blocking
  });
});

describe('plan and slot ids (furnishing.md 3.2)', () => {
  const interior: Rect = { x: 0, y: 0, w: 22, h: 14 };

  it('slot ids are unique, match SLOT_ID_RE and are numbered across the whole plan', () => {
    for (const type of ZONE_TYPES) {
      for (const density of DENSITIES) {
        const plan = buildPlan(type, ctxFor(interior, density));
        const ids = plan.flatMap((i) => i.slotIds);
        expect(new Set(ids).size, `${type}/${density}`).toBe(ids.length);
        ids.forEach((id, n) => {
          expect(SLOT_ID_RE.test(id), id).toBe(true);
          expect(id.endsWith(`:${n}`), id).toBe(true);
        });
      }
    }
  });

  it('is stable: pins consuming slots, a different seed and an equal rebuild keep every slot id, kind and size', () => {
    const base = buildPlan('desks', ctxFor(interior));
    const consumed = new Set([base[2]!.slotIds[0]!, base[3]!.slotIds[1]!]);
    const again = buildPlan('desks', ctxFor(interior, 'normal', { consumedSlots: consumed, pinned: [{ x: 5, y: 5, w: 2, h: 1 }] }));
    expect(again.map((i) => i.slotIds)).toEqual(base.map((i) => i.slotIds));
    expect(again.map((i) => i.members.map((m) => [m.kind, m.w, m.h]))).toEqual(base.map((i) => i.members.map((m) => [m.kind, m.w, m.h])));
    // the recipe under a different stream keeps the plan's ids (positions may move)
    const ids = (seed: number) => furnishRoom('lounge', interior, mulberry32(seed), { density: 'normal', decor: 0, aisle: 1 }, ctxFor(interior)).furniture.map((f) => f.slotId);
    const a = new Set(ids(1));
    expect([...new Set(ids(2))].filter((x) => !a.has(x)).length).toBeLessThanOrEqual(2); // only optional/skipped members may differ
  });

  it('numbers the second instance of a repeated group (library has two armchair nooks)', () => {
    const plan = buildPlan('library', ctxFor(interior));
    expect(plan.filter((i) => i.group.id === 'armchair-nook').map((i) => i.groupId)).toEqual(['armchair-nook#0', 'armchair-nook#1']);
  });

  it('bounds a fill repeat and the whole plan (threat check #10)', () => {
    expect(MAX_GROUP_INSTANCES).toBe(LAYOUT_LIMITS.maxSeatsPerRoom);
    const huge: Rect = { x: 0, y: 0, w: 126, h: 94 };
    for (const type of ['desks', 'review-booth', 'server-room'] as RoomType[]) {
      const plan = buildPlan(type, ctxFor(huge, 'packed'));
      const per = new Map<string, number>();
      for (const i of plan) per.set(i.group.id, (per.get(i.group.id) ?? 0) + 1);
      for (const n of per.values()) expect(n).toBeLessThanOrEqual(MAX_FILL_INSTANCES);
      expect(plan.flatMap((i) => i.slotIds).length).toBeLessThanOrEqual(1000);
    }
  });
});

describe('half-gap pitches (furnishing.md 4.3)', () => {
  it('HALF_GAPS packs more 2-wide desks per row at normal density, and never changes sparse/dense', () => {
    expect(HALF_GAPS).toBe(true);
    const r: Rect = { x: 0, y: 0, w: 24, h: 14 };
    expect(fillRows(r, 2, 1, 1, 'normal', true).length).toBeGreaterThan(fillRows(r, 2, 1, 1, 'normal', false).length);
    for (const d of ['sparse', 'dense', 'packed'] as FurnishDensity[]) {
      expect(fillRows(r, 2, 1, 1, d, true)).toEqual(fillRows(r, 2, 1, 1, d, false));
    }
    // half offsets are real half steps
    expect(fillRows(r, 2, 1, 1, 'normal', true).some((s) => s.x % 1 === 0.5)).toBe(true);
  });

  it('rows keep a free spine column so every row stays reachable', () => {
    const r: Rect = { x: 0, y: 0, w: 20, h: 12 };
    for (const d of DENSITIES) {
      const rows = fillRows(r, 2, 1, 1, d, true);
      const spine = 1 + 18; // inset 1, width 18 -> last column
      expect(rows.every((s) => !(s.x < spine + 1 && s.x + 2 > spine))).toBe(true);
    }
  });
});

describe('furnishRoom with groups: structural properties', () => {
  const sizes: [number, number][] = [[10, 8], [18, 14], [28, 18]];

  it('every item is inside the interior, blocking items never overlap, seats are on free tiles, slots are unique', () => {
    for (const type of ZONE_TYPES) {
      for (const [w, h] of sizes) {
        for (const density of DENSITIES) {
          for (const seed of [1, 7]) {
            const interior: Rect = { x: 4, y: 3, w, h };
            const r = furnishRoom(type, interior, mulberry32(seed), { density, decor: 0.3, aisle: 1 }, ctxFor(interior, density));
            const tag = `${type} ${w}x${h} ${density} #${seed}`;
            const blocking: RecipeItem[] = [];
            const bad: string[] = []; // collected, then one expect: thousands of expect() calls made this test take seconds
            for (const it of r.furniture) {
              if (!(it.x >= interior.x && it.y >= interior.y && it.x + it.w <= interior.x + w && it.y + it.h <= interior.y + h)) bad.push(`${it.kind} out of bounds`);
              if (!(Number.isInteger(it.x * 2) && Number.isInteger(it.y * 2) && Number.isInteger(it.w * 2) && Number.isInteger(it.h * 2))) bad.push(`${it.kind} off the half grid`);
              if (it.blocking) {
                for (const o of blocking) if (rectsIntersect(it, o)) bad.push(`${it.kind} overlaps ${o.kind}`);
                blocking.push(it);
              }
              if (!it.slotId || !SLOT_ID_RE.test(it.slotId)) bad.push(`${it.kind} bad slot id`);
            }
            if (new Set(r.furniture.map((f) => f.slotId)).size !== r.furniture.length) bad.push('duplicate slot ids');
            for (const s of r.seats) {
              if (blocking.some((b) => rectsIntersect({ x: s.x, y: s.y, w: 1, h: 1 }, b))) bad.push(`seat ${s.x},${s.y} on a blocked tile`);
              if (!(s.x >= interior.x && s.x < interior.x + w && s.y >= interior.y && s.y < interior.y + h)) bad.push(`seat ${s.x},${s.y} outside`);
            }
            if (r.furniture.length && !(r.score!.reach > 0)) bad.push('reach 0');
            expect(bad, tag).toEqual([]);
          }
        }
      }
    }
  });

  it('is deterministic and reports the winning score', () => {
    const interior: Rect = { x: 0, y: 0, w: 24, h: 16 };
    const run = () => furnishRoom('meeting-room', interior, mulberry32(9), { density: 'normal', decor: 0.3, aisle: 1 }, ctxFor(interior));
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
    const r = run();
    expect(r.score!.total).toBeGreaterThan(0.5);
    expect(r.score!.total).toBeLessThanOrEqual(1);
  });

  it('a desk has its chairs on the front row (facing n) or, when that row is taken, mirrored behind it (facing s)', () => {
    const interior: Rect = { x: 0, y: 0, w: 20, h: 12 };
    const r = furnishRoom('desks', interior, mulberry32(1), { density: 'dense', decor: 0, aisle: 1 }, ctxFor(interior, 'dense'));
    const desks = r.furniture.filter((f) => f.kind === 'work-desk');
    const chairs = r.furniture.filter((f) => f.kind === 'chair');
    expect(desks.length).toBeGreaterThan(5);
    expect(chairs.length).toBeGreaterThan(5);
    for (const c of chairs) {
      const d = desks.find((k) => k.groupId === c.groupId)!;
      expect(d, 'chair has its desk').toBeTruthy();
      expect(c.x >= d.x && c.x < d.x + d.w).toBe(true);
      if (c.y === d.y + d.h) expect(c.facing).toBe('n');
      else {
        expect(c.y).toBe(d.y - 1);
        expect(c.facing).toBeUndefined(); // facing s is the painter default
      }
    }
    // each chair carries exactly one seat on its own tile
    for (const c of chairs) expect(r.seats.some((s) => s.x === Math.floor(c.x) && s.y === Math.floor(c.y))).toBe(true);
  });

  it('a lounge sofa gets its coffee table, rug and lamp, with the sofa against a wall', () => {
    const interior: Rect = { x: 0, y: 0, w: 20, h: 14 };
    const r = furnishRoom('lounge', interior, mulberry32(3), { density: 'normal', decor: 0, aisle: 1 }, ctxFor(interior));
    const sofa = r.furniture.find((f) => f.kind === 'sofa')!;
    expect(sofa).toBeTruthy();
    const mates = r.furniture.filter((f) => f.groupId === sofa.groupId).map((f) => f.kind);
    expect(mates).toContain('table');
    expect(mates).toContain('rug');
    const nearWall = sofa.x === 0 || sofa.y === 0 || sofa.x + sofa.w === interior.w || sofa.y + sofa.h === interior.h;
    expect(nearWall).toBe(true);
  });

  it('a meeting table is surrounded by chairs facing it and a board hangs on a wall', () => {
    const interior: Rect = { x: 0, y: 0, w: 22, h: 14 };
    const r = furnishRoom('meeting-room', interior, mulberry32(2), { density: 'normal', decor: 0, aisle: 1 }, ctxFor(interior));
    const table = r.furniture.find((f) => f.kind === 'table')!;
    const chairs = r.furniture.filter((f) => f.kind === 'chair' && f.groupId === table.groupId);
    expect(chairs.length).toBeGreaterThan(8);
    const board = r.furniture.find((f) => f.kind === 'board')!;
    expect(board).toBeTruthy();
    expect(board.x === 0 || board.y === 0 || board.x + board.w === interior.w || board.y + board.h === interior.h).toBe(true);
  });

  it('corner groups take corners; wall groups take walls', () => {
    const interior: Rect = { x: 0, y: 0, w: 14, h: 10 };
    const r = furnishRoom('qa-lab', interior, mulberry32(4), { density: 'sparse', decor: 0, aisle: 1 }, ctxFor(interior, 'sparse'));
    const eq = r.furniture.find((f) => f.kind === 'equipment')!;
    expect(eq).toBeTruthy();
    expect((eq.x === 0 || eq.x + eq.w === 14) && (eq.y === 0 || eq.y + eq.h === 10)).toBe(true);
  });

  it('an open-plan room (no solid wall sides) still gets its wall-affinity groups', () => {
    const interior: Rect = { x: 0, y: 0, w: 14, h: 10 };
    const r = furnishRoom('entrance', interior, mulberry32(1), { density: 'normal', decor: 0, aisle: 1 }, ctxFor(interior, 'normal', { wallSides: new Set() }));
    expect(r.furniture.some((f) => f.kind === 'reception-desk')).toBe(true);
  });

  it('a consumed slot is neither placed nor listed as skipped, and the rest keep their ids', () => {
    const interior: Rect = { x: 0, y: 0, w: 22, h: 14 };
    const full = furnishRoom('desks', interior, mulberry32(1), { density: 'normal', decor: 0, aisle: 1 }, ctxFor(interior));
    const gone = full.furniture.find((f) => f.kind === 'work-desk')!.slotId!;
    const r = furnishRoom('desks', interior, mulberry32(1), { density: 'normal', decor: 0, aisle: 1 }, ctxFor(interior, 'normal', { consumedSlots: new Set([gone]) }));
    expect(r.furniture.some((f) => f.slotId === gone)).toBe(false);
    expect(r.skippedSlots).not.toContain(gone);
    const ids = new Set(full.furniture.map((f) => f.slotId));
    expect(r.furniture.every((f) => ids.has(f.slotId))).toBe(true);
    expect(r.furniture.length).toBe(full.furniture.length - 1);
  });

  it('a pinned rect is avoided by every item', () => {
    const interior: Rect = { x: 0, y: 0, w: 22, h: 14 };
    const pin: Rect = { x: 8, y: 4, w: 4, h: 3 };
    const r = furnishRoom('library', interior, mulberry32(1), { density: 'dense', decor: 0, aisle: 1 }, ctxFor(interior, 'dense', { pinned: [pin] }));
    expect(r.furniture.filter((f) => f.blocking).some((f) => rectsIntersect(f, pin))).toBe(false);
  });

  it('door aprons stay free of blocking furniture', () => {
    const interior: Rect = { x: 0, y: 0, w: 20, h: 12 };
    const aprons = new Set(['10,0', '10,11', '0,6']);
    const r = furnishRoom('desks', interior, mulberry32(1), { density: 'packed', decor: 0, aisle: 1 }, ctxFor(interior, 'packed', { aprons }));
    for (const key of aprons) {
      const [x, y] = key.split(',').map(Number) as [number, number];
      expect(r.furniture.some((f) => f.blocking && rectsIntersect(f, { x, y, w: 1, h: 1 })), key).toBe(false);
    }
  });
});

describe('anchorCandidates', () => {
  const interior: Rect = { x: 2, y: 2, w: 16, h: 10 };

  it('wall: flush with the side the facing looks away from, all inside the interior', () => {
    const board = GROUPS.board!;
    const members = (board.members as (c: unknown) => never[])({ interior, density: 'normal', aisle: 1, index: 0 });
    for (const [f, check] of [
      ['s', (p: { x: number; y: number }) => p.y === interior.y],
      ['n', (p: { x: number; y: number }) => p.y + 1 === interior.y + interior.h],
      ['e', (p: { x: number; y: number }) => p.x === interior.x],
      ['w', (p: { x: number; y: number }) => p.x + 1 === interior.x + interior.w],
    ] as const) {
      const pts = anchorCandidates(board, f, ctxFor(interior), members);
      expect(pts.length, f).toBeGreaterThan(0);
      expect(pts.every(check), f).toBe(true);
    }
  });

  it('centre: the first candidate is the centre snapped to a half tile; corner: inside corners', () => {
    const reading = GROUPS.reading!;
    const [first] = anchorCandidates(reading, 's', ctxFor(interior));
    expect(Number.isInteger(first!.x * 2) && Number.isInteger(first!.y * 2)).toBe(true);
    expect(Math.abs(first!.x + 1 - (interior.x + interior.w / 2))).toBeLessThanOrEqual(1);
    const corners = anchorCandidates(GROUPS.equipment!, 's', ctxFor(interior));
    expect(corners).toHaveLength(4);
  });
});

describe('scoreCandidate', () => {
  const interior: Rect = { x: 0, y: 0, w: 8, h: 6 };
  const item = (x: number, y: number, w: number, h: number): RecipeItem => ({ kind: 'table', x, y, w, h, blocking: true, variant: 0 });

  it('an unreachable seat forces total 0; a reachable layout scores in (0, 1]', () => {
    const wall = [item(0, 2, 8, 1)];
    const ctx = ctxFor(interior, 'normal', { aprons: new Set(['0,5']) });
    const sealed = scoreCandidate(wall, [{ x: 3, y: 0, kind: 'sit' }], ctx);
    expect(sealed.reach).toBe(0);
    expect(sealed.total).toBe(0);
    const ok = scoreCandidate([item(2, 2, 3, 1)], [{ x: 3, y: 3, kind: 'sit' }], ctx);
    expect(ok.reach).toBeGreaterThan(0.9);
    expect(ok.total).toBeGreaterThan(0);
    expect(ok.total).toBeLessThanOrEqual(1);
  });

  it('prefers the symmetric arrangement and the density target', () => {
    const ctx = ctxFor({ x: 0, y: 0, w: 10, h: 8 }, 'normal');
    const sym = scoreCandidate([item(1, 1, 2, 1), item(7, 1, 2, 1), item(1, 6, 2, 1), item(7, 6, 2, 1)], [], ctx);
    const lopsided = scoreCandidate([item(1, 1, 2, 1), item(2, 2, 2, 1), item(3, 3, 2, 1), item(1, 6, 2, 1)], [], ctx);
    expect(sym.symmetry).toBeGreaterThan(lopsided.symmetry);
    expect(sym.alignment).toBeGreaterThanOrEqual(lopsided.alignment);
    const empty = scoreCandidate([], [], ctx);
    expect(empty.density).toBe(0);
  });

  it('counts pinned rects as blocking in the reach flood', () => {
    const ctx = ctxFor(interior, 'normal', { aprons: new Set(['0,5']), pinned: [{ x: 0, y: 2, w: 8, h: 1 }] });
    expect(scoreCandidate([], [{ x: 3, y: 0, kind: 'sit' }], ctx).reach).toBe(0);
  });
});

describe('bestCandidate', () => {
  it('returns the best of K by total with ties going to the earlier candidate, and never loses to candidate 0', () => {
    const interior: Rect = { x: 0, y: 0, w: 20, h: 14 };
    const ctx = ctxFor(interior, 'normal');
    const best = bestCandidate('lounge', ctx, mulberry32(11), CANDIDATES.normal);
    const first = bestCandidate('lounge', ctx, mulberry32(11), 1);
    expect(best.score.total).toBeGreaterThanOrEqual(first.score.total);
    expect(bestCandidate('lounge', ctx, mulberry32(11), CANDIDATES.normal).items).toEqual(best.items);
  });

  it('K and stream offsets are fixed: a candidate sees the same stream whatever came before it', () => {
    const interior: Rect = { x: 0, y: 0, w: 20, h: 14 };
    const ctx = ctxFor(interior, 'normal');
    const a = mulberry32(5);
    bestCandidate('lounge', ctx, a, 4);
    const b = mulberry32(5);
    bestCandidate('desks', ctx, b, 4); // a plan that places very differently
    expect(a()).toBe(b());
  });
});

describe('relocate', () => {
  it('slides a group along its axis to the nearest free spot, or gives up', () => {
    const interior: Rect = { x: 0, y: 0, w: 12, h: 6 };
    const grid = new OccupancyGrid(interior);
    grid.mark({ x: 4, y: 2, w: 2, h: 1 }, 1, 0); // the pin that displaced the item
    const item: RecipeItem = { kind: 'work-desk', x: 4, y: 2, w: 2, h: 1, blocking: true, variant: 0 };
    const moved = relocate([item], 'x', grid)!;
    expect(moved).toHaveLength(1);
    expect(Math.abs(moved[0]!.x - 4)).toBeGreaterThanOrEqual(2);
    expect(moved[0]!.y).toBe(2);
    grid.mark({ x: 0, y: 2, w: 12, h: 1 }, 1, 0);
    expect(relocate([item], 'x', grid)).toBeNull();
  });
});

describe('seatsFor facing', () => {
  const interior: Rect = { x: 0, y: 0, w: 10, h: 8 };
  it('seats the front row for each facing and the opposite one at the edge', () => {
    const desk: Rect = { x: 3, y: 3, w: 2, h: 1 };
    expect(seatsFor('work-desk', desk, interior).map((s) => [s.x, s.y])).toEqual([[3, 4], [4, 4]]);
    expect(seatsFor('work-desk', desk, interior, 'n').map((s) => [s.x, s.y])).toEqual([[3, 2], [4, 2]]);
    expect(seatsFor('standing-table', { x: 3, y: 3, w: 1, h: 2 }, interior, 'e').map((s) => [s.x, s.y])).toEqual([[4, 3], [4, 4]]);
    expect(seatsFor('standing-table', { x: 3, y: 3, w: 1, h: 2 }, interior, 'w').map((s) => [s.x, s.y])).toEqual([[2, 3], [2, 4]]);
    expect(seatsFor('work-desk', { x: 3, y: 7, w: 2, h: 1 }, interior).map((s) => s.y)).toEqual([6, 6]);
    expect(seatsFor('rack-row', { x: 2, y: 2, w: 1, h: 3 }, interior)).toEqual([{ x: 2, y: 5, kind: 'stand' }]);
  });
});

describe('decorateRoom with a context (furnishing.md 3.5)', () => {
  const r: Rect = { x: 0, y: 0, w: 14, h: 10 };
  const free = (): { x: number; y: number }[] => {
    const out = [];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) out.push({ x, y });
    return out;
  };
  const seat = '5,5';
  const dctx = {
    wallSides: new Set<Facing>(['n', 'w']),
    seats: new Set([seat]),
    corners: [{ x: 0, y: 0 }, { x: 13, y: 0 }, { x: 0, y: 9 }, { x: 13, y: 9 }],
    aprons: new Set(['7,0']),
  };

  it('is deterministic from the room seed alone and does not touch a stream', () => {
    const a = decorateRoom(r, free(), 1, 'room:a', dctx);
    expect(a).toEqual(decorateRoom(r, free(), 1, 'room:a', dctx));
    expect(a).not.toEqual(decorateRoom(r, free(), 1, 'room:b', dctx));
    expect(a.length).toBeGreaterThan(5);
  });

  it('puts wall kinds only on cells next to a solid wall, plants in corners, lamps near seats or corners, never on seats or aprons', () => {
    const items = decorateRoom(r, free(), 1, 'room:affinity', dctx);
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.size).toBeGreaterThan(3);
    for (const it of items) {
      const key = `${it.x},${it.y}`;
      expect(key === seat || key === '7,0', key).toBe(false);
      expect(it.blocking).toBe(false);
      if (DECOR_AFFINITY[it.kind as keyof typeof DECOR_AFFINITY] === 'wall') {
        expect(it.y === 0 || it.x === 0, `${it.kind} at ${key}`).toBe(true); // only n and w are solid
      }
      if (it.kind === 'plant') expect(dctx.corners.some((c) => Math.abs(c.x - it.x) <= 1 && Math.abs(c.y - it.y) <= 1), key).toBe(true);
      if (it.kind === 'lamp') {
        const nearSeat = Math.abs(5 - it.x) + Math.abs(5 - it.y) === 1;
        expect(nearSeat || dctx.corners.some((c) => Math.abs(c.x - it.x) <= 1 && Math.abs(c.y - it.y) <= 1), key).toBe(true);
      }
      if (DECOR_AFFINITY[it.kind as keyof typeof DECOR_AFFINITY] === 'centre') expect(it.x > 0 && it.x < 13 && it.y > 0 && it.y < 9).toBe(true);
    }
    expect(new Set(items.map((i) => `${i.x},${i.y}`)).size).toBe(items.length);
  });

  it('puts no wall art or banner mid-floor, and none at all when no side is solid', () => {
    const open = decorateRoom(r, free(), 1, 'room:open', { ...dctx, wallSides: new Set<Facing>() });
    expect(open.some((i) => i.kind === 'wall-art' || i.kind === 'banner' || i.kind === 'crate' || i.kind === 'bin')).toBe(false);
  });

  it('keeps the old stream-based signature working', () => {
    const items = decorateRoom(r, free(), 0.5, mulberry32(1));
    expect(items.length).toBeGreaterThan(0);
    expect(decorateRoom(r, free(), 0, mulberry32(1))).toEqual([]);
  });
});
