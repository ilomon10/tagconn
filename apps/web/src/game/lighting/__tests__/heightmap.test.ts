import { describe, expect, it } from 'vitest';
import { buildHeightMap, heightAt } from '../heightmap';
import { KIND_HEIGHT, WALL_HEIGHT_PX, kindHeight } from '../heights';
import { T, furn, mapFrom, walledRows } from './lightingFixtures';

describe('buildHeightMap', () => {
  it('walls are 16, floor and door are 0', () => {
    const hm = buildHeightMap(mapFrom(walledRows(4, 3, { x: 2, y: 0 })));
    expect(heightAt(hm, 0, 0)).toBe(WALL_HEIGHT_PX);
    expect(heightAt(hm, 1.5 * T, 1.5 * T)).toBe(0);
    expect(heightAt(hm, 2.5 * T, 0.5 * T)).toBe(0);
  });

  it('a single item equals kindHeight on every covered tile and 0 around it', () => {
    for (const kind of ['bookcase', 'work-desk', 'rug', 'fridge']) {
      const hm = buildHeightMap(mapFrom(walledRows(8, 6), { furniture: [furn(kind, 3, 2, 2, 1)] }));
      expect(heightAt(hm, 3.5 * T, 2.5 * T)).toBe(kindHeight(kind));
      expect(heightAt(hm, 4.5 * T, 2.5 * T)).toBe(kindHeight(kind));
      expect(heightAt(hm, 5.5 * T, 2.5 * T)).toBe(0);
      expect(heightAt(hm, 3.5 * T, 3.5 * T)).toBe(0);
    }
  });

  it('overlapping items take the max; an unknown kind is 0', () => {
    const hm = buildHeightMap(mapFrom(walledRows(8, 6), { furniture: [furn('work-desk', 2, 2, 2, 1), furn('bookcase', 3, 2, 1, 1), furn('constructor', 5, 2, 1, 1)] }));
    expect(heightAt(hm, 2.5 * T, 2.5 * T)).toBe(KIND_HEIGHT['work-desk']);
    expect(heightAt(hm, 3.5 * T, 2.5 * T)).toBe(KIND_HEIGHT['bookcase']);
    expect(heightAt(hm, 5.5 * T, 2.5 * T)).toBe(0);
  });

  it('a half-tile pin raises every tile it touches', () => {
    const hm = buildHeightMap(mapFrom(walledRows(8, 6), { furniture: [furn('bookcase', 2.5, 2, 1, 1)] }));
    expect(heightAt(hm, 2.5 * T, 2.5 * T)).toBe(14);
    expect(heightAt(hm, 3.5 * T, 2.5 * T)).toBe(14);
    expect(heightAt(hm, 4.5 * T, 2.5 * T)).toBe(0);
  });

  it('heightAt is 0 outside the map', () => {
    const hm = buildHeightMap(mapFrom(walledRows(4, 3)));
    expect(heightAt(hm, -5, 10)).toBe(0);
    expect(heightAt(hm, 1e6, 10)).toBe(0);
    expect(heightAt(hm, 10, 1e6)).toBe(0);
  });
});
