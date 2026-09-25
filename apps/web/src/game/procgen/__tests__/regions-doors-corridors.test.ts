import { describe, expect, it } from 'vitest';
import { astarVoid, carveCorridor, findExitCandidates } from '../corridors';
import { footprintRing, findDoorSpans } from '../doors';
import { buildRegionAtGrid, buildRoomToRegion, findRegions, findVoidAreas } from '../regions';
import type { TileKind } from '../types';

/** Build a `[y][x]` tile grid from an array of same-length row strings (f=floor, w=wall, v=void). */
function grid(rows: string[]): TileKind[][] {
  const map: Record<string, TileKind> = { f: 'floor', w: 'wall', v: 'void', d: 'door' };
  return rows.map((row) => [...row].map((c) => map[c]!));
}

describe('findRegions', () => {
  it('isolates each walled room into its own region, and merges hall + open rooms', () => {
    // Two walled 3x3 rooms (rings at col 0-4/6-10) side by side, both sitting on an open hall floor.
    const tiles = grid([
      'fffffffffff',
      'fwwwffwwwff',
      'fwfwffwfwff',
      'fwwwffwwwff',
      'fffffffffff',
    ]);
    const roomAt: (string | null)[][] = tiles.map((row) => row.map(() => null));
    roomAt[2]![2] = 'a';
    roomAt[2]![7] = 'b';
    const regions = findRegions(tiles, roomAt);
    // 2 isolated 1x1 room regions + 1 big hall region that wraps around them.
    expect(regions).toHaveLength(3);
    const roomRegion = (id: string) => regions.find((r) => r.roomIds.includes(id));
    expect(roomRegion('a')!.tiles).toHaveLength(1);
    expect(roomRegion('b')!.tiles).toHaveLength(1);
    const hall = regions.find((r) => r.hasHall)!;
    expect(hall.roomIds).toEqual([]);
    expect(hall.tiles.length).toBeGreaterThan(2);
  });

  it('buildRegionAtGrid and buildRoomToRegion agree with findRegions', () => {
    const tiles = grid(['fff', 'fff', 'fff']);
    const roomAt: (string | null)[][] = tiles.map((row) => row.map(() => null));
    roomAt[1]![1] = 'x';
    const regions = findRegions(tiles, roomAt);
    const regionAt = buildRegionAtGrid(regions, 3, 3);
    const roomToRegion = buildRoomToRegion(regions);
    expect(regionAt[1]![1]).toBe(roomToRegion.get('x'));
  });
});

describe('findDoorSpans', () => {
  it('finds a single-thick span between a walled room and the hall', () => {
    const tiles = grid(['wwwww', 'wfffw', 'wfffw', 'wfffw', 'wwwww', 'fffff']);
    // Open the bottom ring row's interior beneath into hall floor for one column so it is candidate-able.
    const roomAt: (string | null)[][] = tiles.map((row) => row.map(() => null));
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) roomAt[y]![x] = 'room';
    const spans = findDoorSpans([{ id: 'room', footprint: { x: 0, y: 0, w: 5, h: 5 }, walled: true }], tiles, buildRegionAtGrid(findRegions(tiles, roomAt), 6, 5));
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s) => s.roomId === 'room' && s.side === 'bottom' && s.depth === 1)).toBe(true);
  });

  it('finds a double-thick span between two adjacent walled rooms', () => {
    // Room A (cols 0-4) directly beside room B (cols 5-9), each with its own wall ring, no gap.
    const tiles = grid(['wwwwwwwwww', 'wfffwwfffw', 'wfffwwfffw', 'wfffwwfffw', 'wwwwwwwwww']);
    const roomAt: (string | null)[][] = tiles.map((row) => row.map(() => null));
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) roomAt[y]![x] = 'a';
    for (let y = 1; y <= 3; y++) for (let x = 6; x <= 8; x++) roomAt[y]![x] = 'b';
    const regions = findRegions(tiles, roomAt);
    const regionAt = buildRegionAtGrid(regions, 5, 10);
    const rooms = [
      { id: 'a', footprint: { x: 0, y: 0, w: 5, h: 5 }, walled: true },
      { id: 'b', footprint: { x: 5, y: 0, w: 5, h: 5 }, walled: true },
    ];
    const spans = findDoorSpans(rooms, tiles, regionAt);
    const aToB = spans.filter((s) => s.roomId === 'a' && s.side === 'right');
    expect(aToB.length).toBeGreaterThan(0);
    expect(aToB[0]!.depth).toBe(2);
  });

  it('footprintRing skips the 4 corners', () => {
    const positions = [...footprintRing({ x: 0, y: 0, w: 4, h: 4 })].map((r) => r.p);
    expect(positions).not.toContainEqual({ x: 0, y: 0 });
    expect(positions).not.toContainEqual({ x: 3, y: 0 });
    expect(positions).not.toContainEqual({ x: 0, y: 3 });
    expect(positions).not.toContainEqual({ x: 3, y: 3 });
  });
});

describe('corridors', () => {
  it('astarVoid finds a path through void tiles only, and refuses to cross walls', () => {
    const tiles = grid(['vvvvv', 'vwwwv', 'vvvvv']);
    const path = astarVoid(tiles, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(path).not.toBeNull();
    expect(path!.every((p) => tiles[p.y]![p.x] === 'void')).toBe(true);
    expect(path![0]).toEqual({ x: 0, y: 0 });
    expect(path!.at(-1)).toEqual({ x: 4, y: 0 });
  });

  it('astarVoid returns null when there is no void path', () => {
    const tiles = grid(['vwv', 'vwv', 'vwv']);
    expect(astarVoid(tiles, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
  });

  it('astarVoid stops after maxExpansions instead of exhausting a huge or maze-like void area', () => {
    // A wide open void strip: `astarVoid` would normally find this trivially (it's a straight line).
    const tiles = grid(['v'.repeat(50)]);
    expect(astarVoid(tiles, { x: 0, y: 0 }, { x: 49, y: 0 })).not.toBeNull();
    // With a tiny expansion budget, the same call gives up before reaching the goal.
    expect(astarVoid(tiles, { x: 0, y: 0 }, { x: 49, y: 0 }, 3)).toBeNull();
  });

  it('findVoidAreas labels disconnected void components separately, and a connected one as a single id', () => {
    // Two 1x1 void pockets on either side of a wall column: never orthogonally adjacent.
    const tiles = grid(['vwv']);
    const areas = findVoidAreas(tiles);
    expect(areas[0]![0]).not.toBeNull();
    expect(areas[0]![2]).not.toBeNull();
    expect(areas[0]![0]).not.toBe(areas[0]![2]);
    expect(areas[0]![1]).toBeNull(); // the wall tile itself is never labelled

    const connected = grid(['vvv']);
    const connectedAreas = findVoidAreas(connected);
    expect(new Set(connectedAreas[0]).size).toBe(1); // one contiguous strip -> one area id
  });

  it('carveCorridor only converts void tiles to floor, never walls', () => {
    const tiles = grid(['vvvvv', 'wwwww']);
    const roomAt: (string | null)[][] = tiles.map((row) => row.map(() => null));
    carveCorridor(tiles, roomAt, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], 3);
    expect(tiles[0]!.filter((t) => t === 'floor').length).toBeGreaterThan(0);
    expect(tiles[1]).toEqual(['wall', 'wall', 'wall', 'wall', 'wall']); // widening never touched the wall row
  });

  it('findExitCandidates only reports edges whose outward neighbour is void', () => {
    const tiles = grid(['fffvv', 'fffvv', 'fffvv']);
    const exits = findExitCandidates([{ id: 'r', footprint: { x: 0, y: 0, w: 3, h: 3 }, walled: false }], tiles);
    expect(exits.length).toBeGreaterThan(0);
    for (const e of exits) expect(tiles[e.voidTile.y]![e.voidTile.x]).toBe('void');
  });
});
