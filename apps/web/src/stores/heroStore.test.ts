import { beforeEach, describe, expect, it } from 'vitest';
import type { Hero } from '@tagconn/shared';
import { generateHeroAppearance, heroSeed } from '@tagconn/shared';
import { heroesForProject, useHeroStore } from './heroStore';

const hero = (id: string, over: Partial<Hero> = {}): Hero => ({
  id,
  projectId: 'proj-a',
  role: 'developer',
  slot: 0,
  name: id,
  title: null,
  appearance: generateHeroAppearance(heroSeed('proj-a', 'developer', 0)),
  customized: false,
  boundAgentId: null,
  boundAt: null,
  releasedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('heroStore', () => {
  beforeEach(() => {
    useHeroStore.setState({ heroes: {} });
  });

  it('setHeroes replaces the whole map, indexed by id', () => {
    useHeroStore.getState().setHeroes([hero('h-aaaaaaaa'), hero('h-bbbbbbbb')]);
    expect(Object.keys(useHeroStore.getState().heroes).sort()).toEqual(['h-aaaaaaaa', 'h-bbbbbbbb']);
    useHeroStore.getState().setHeroes([hero('h-cccccccc')]);
    expect(Object.keys(useHeroStore.getState().heroes)).toEqual(['h-cccccccc']);
  });

  it('upsertHero inserts and replaces by id', () => {
    useHeroStore.getState().upsertHero(hero('h-aaaaaaaa', { name: 'first' }));
    expect(useHeroStore.getState().heroes['h-aaaaaaaa']?.name).toBe('first');
    useHeroStore.getState().upsertHero(hero('h-aaaaaaaa', { name: 'second' }));
    expect(useHeroStore.getState().heroes['h-aaaaaaaa']?.name).toBe('second');
    expect(Object.keys(useHeroStore.getState().heroes)).toEqual(['h-aaaaaaaa']);
  });

  it('removeHero removes and is a no-op for unknown ids', () => {
    useHeroStore.getState().setHeroes([hero('h-aaaaaaaa'), hero('h-bbbbbbbb')]);
    useHeroStore.getState().removeHero('h-aaaaaaaa');
    expect(Object.keys(useHeroStore.getState().heroes)).toEqual(['h-bbbbbbbb']);
    useHeroStore.getState().removeHero('nope'); // no-op
    expect(Object.keys(useHeroStore.getState().heroes)).toEqual(['h-bbbbbbbb']);
  });

  describe('client hardening: unsafe ids never resolve to Object.prototype members', () => {
    it("upsertHero/removeHero keep the map's prototype null (no accidental Object.prototype inheritance)", () => {
      useHeroStore.getState().upsertHero(hero('h-aaaaaaaa'));
      expect(Object.getPrototypeOf(useHeroStore.getState().heroes)).toBeNull();
      useHeroStore.getState().removeHero('h-aaaaaaaa');
      expect(Object.getPrototypeOf(useHeroStore.getState().heroes)).toBeNull();
    });

    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('a hero id of %j never resolves via prototype lookup', (id) => {
      // Establish the null-prototype map first (a fresh `useHeroStore.setState({ heroes: {} })` in
      // `beforeEach` is a plain literal, which is exactly what this guards against downstream).
      useHeroStore.getState().setHeroes([hero('h-aaaaaaaa')]);
      // No hero was ever stored under this id: a plain-object map would still "find" one via the
      // inherited Object.prototype member (a function), which is exactly the bug this guards against.
      expect(Object.hasOwn(useHeroStore.getState().heroes, id)).toBe(false);
      expect(useHeroStore.getState().heroes[id]).toBeUndefined();
    });

    it('setHeroes stores an entry under a reserved-word id as a plain own property, not a prototype change', () => {
      // The schema's `HERO_ID_RE` rejects "constructor" for a NEW hero, but an old snapshot or a
      // future id scheme could still hand one to the client — the map itself must stay inert either way.
      useHeroStore.getState().setHeroes([hero('constructor', { name: 'Sneaky' })]);
      const heroes = useHeroStore.getState().heroes;
      expect(Object.hasOwn(heroes, 'constructor')).toBe(true);
      expect(Object.getPrototypeOf(heroes)).toBeNull();
    });
  });

  describe('heroesForProject', () => {
    it('filters by project id using own-property lookups', () => {
      useHeroStore.getState().setHeroes([hero('h-aaaaaaaa', { projectId: 'a' }), hero('h-bbbbbbbb', { projectId: 'b' }), hero('h-cccccccc', { projectId: 'a' })]);
      const forA = heroesForProject(useHeroStore.getState().heroes, 'a');
      expect(forA.map((h) => h.id).sort()).toEqual(['h-aaaaaaaa', 'h-cccccccc']);
    });

    it('returns an empty list for an unknown or hostile project id', () => {
      useHeroStore.getState().setHeroes([hero('h-aaaaaaaa', { projectId: 'a' })]);
      expect(heroesForProject(useHeroStore.getState().heroes, '__proto__')).toEqual([]);
      expect(heroesForProject(useHeroStore.getState().heroes, 'missing')).toEqual([]);
    });
  });
});
