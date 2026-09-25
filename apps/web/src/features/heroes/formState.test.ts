import { generateHeroAppearance, HERO_ACCESSORIES, HERO_HATS, HERO_LIMITS, HERO_PROPS, HERO_SKIN_TONES, heroSeed, type Hero } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import {
  defaultHeroFloor,
  diffHeroPatch,
  draftFromHero,
  groupHeroesByRole,
  heroStatus,
  randomizeAppearance,
  validateHeroName,
  validateHeroTitle,
} from './formState';

function makeHero(over: Partial<Hero> = {}): Hero {
  const now = 1_000;
  return {
    id: 'h-00000001',
    projectId: 'proj-1',
    role: 'developer',
    slot: 0,
    name: 'Brom',
    title: null,
    appearance: generateHeroAppearance(heroSeed('proj-1', 'developer', 0)),
    customized: false,
    boundAgentId: null,
    boundAt: null,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('draftFromHero / diffHeroPatch', () => {
  it('produces no patch when the draft is untouched', () => {
    const hero = makeHero();
    expect(diffHeroPatch(hero, draftFromHero(hero))).toBeNull();
  });

  it('diffs a name change and carries baseUpdatedAt', () => {
    const hero = makeHero({ updatedAt: 42 });
    const draft = draftFromHero(hero);
    draft.name = ' Wendel ';
    expect(diffHeroPatch(hero, draft)).toEqual({ name: 'Wendel', baseUpdatedAt: 42 });
  });

  it('maps an empty title to null, and a non-empty one to trimmed text', () => {
    const hero = makeHero({ title: 'Old Title', updatedAt: 1 });
    const cleared = draftFromHero(hero);
    cleared.title = '   ';
    expect(diffHeroPatch(hero, cleared)).toEqual({ title: null, baseUpdatedAt: 1 });

    const noTitleHero = makeHero({ title: null, updatedAt: 1 });
    const set = draftFromHero(noTitleHero);
    set.title = ' New Title ';
    expect(diffHeroPatch(noTitleHero, set)).toEqual({ title: 'New Title', baseUpdatedAt: 1 });
  });

  it('diffs only the changed appearance fields', () => {
    const hero = makeHero({ updatedAt: 7 });
    const draft = draftFromHero(hero);
    draft.appearance = { ...draft.appearance, hat: 'crown', hatColor: '#112233' };
    expect(diffHeroPatch(hero, draft)).toEqual({ appearance: { hat: 'crown', hatColor: '#112233' }, baseUpdatedAt: 7 });
  });
});

describe('validateHeroName / validateHeroTitle', () => {
  it('rejects an empty or too-long name', () => {
    expect(validateHeroName('')).toMatch(/required/);
    expect(validateHeroName('   ')).toMatch(/required/);
    expect(validateHeroName('a'.repeat(HERO_LIMITS.maxNameLength + 1))).toMatch(/at most/);
    expect(validateHeroName('Brom')).toBeNull();
  });

  it('allows an empty title (themed default), rejects only a too-long one', () => {
    expect(validateHeroTitle('')).toBeNull();
    expect(validateHeroTitle('   ')).toBeNull();
    expect(validateHeroTitle('a'.repeat(HERO_LIMITS.maxTitleLength + 1))).toMatch(/at most/);
    expect(validateHeroTitle('Keeper of Tests')).toBeNull();
  });
});

describe('randomizeAppearance', () => {
  it('is deterministic for a given seed', () => {
    const base = generateHeroAppearance(1);
    const a = randomizeAppearance(base, 12345, false);
    const b = randomizeAppearance(base, 12345, false);
    expect(a).toEqual(b);
  });

  it('always picks from the curated skin palette', () => {
    const base = generateHeroAppearance(1);
    for (let seed = 0; seed < 20; seed++) {
      const next = randomizeAppearance(base, seed, false);
      expect(HERO_SKIN_TONES).toContain(next.skin);
    }
  });

  it('leaves hat/prop/accessory untouched unless includeCostume is set', () => {
    const base = generateHeroAppearance(1);
    const custom = { ...base, hat: 'crown' as const, prop: 'lute' as const, accessory: 'cloak' as const };
    const kept = randomizeAppearance(custom, 999, false);
    expect(kept.hat).toBe('crown');
    expect(kept.prop).toBe('lute');
    expect(kept.accessory).toBe('cloak');

    let changedSomething = false;
    for (let seed = 0; seed < 40; seed++) {
      const reseeded = randomizeAppearance(custom, seed, true);
      expect(HERO_HATS).toContain(reseeded.hat);
      expect(HERO_PROPS).toContain(reseeded.prop);
      expect(HERO_ACCESSORIES).toContain(reseeded.accessory);
      if (reseeded.hat !== custom.hat || reseeded.prop !== custom.prop || reseeded.accessory !== custom.accessory) changedSomething = true;
    }
    expect(changedSomething).toBe(true);
  });
});

describe('heroStatus', () => {
  it('is "away" for a never-bound hero', () => {
    expect(heroStatus(makeHero({ boundAgentId: null, releasedAt: null }), {})).toEqual({ kind: 'away' });
  });

  it('is "resting" for a released hero, with no agent lookup needed', () => {
    expect(heroStatus(makeHero({ boundAgentId: 'a-1', releasedAt: 500 }), {})).toEqual({ kind: 'resting' });
  });

  it('is "on-quest" with the bound agent\'s description while unreleased', () => {
    const agents = { 'a-1': { description: 'Fixing the login bug' } };
    expect(heroStatus(makeHero({ boundAgentId: 'a-1', releasedAt: null }), agents)).toEqual({
      kind: 'on-quest',
      agentId: 'a-1',
      description: 'Fixing the login bug',
    });
  });
});

describe('groupHeroesByRole', () => {
  const theme = { roleTitles: { developer: 'Artificer', pm: 'Guild Master' } };

  it('groups by role, sorted by themed title, with heroes sorted by slot', () => {
    const heroes = [
      makeHero({ id: 'h-1', role: 'pm', slot: 1, name: 'B' }),
      makeHero({ id: 'h-2', role: 'developer', slot: 1, name: 'D' }),
      makeHero({ id: 'h-3', role: 'developer', slot: 0, name: 'C' }),
      makeHero({ id: 'h-4', role: 'pm', slot: 0, name: 'A' }),
    ];
    const groups = groupHeroesByRole(heroes, theme, (r) => r);
    expect(groups.map((g) => g.title)).toEqual(['Artificer', 'Guild Master']);
    expect(groups[0]!.heroes.map((h) => h.id)).toEqual(['h-3', 'h-2']);
    expect(groups[1]!.heroes.map((h) => h.id)).toEqual(['h-4', 'h-1']);
  });

  it('falls back to the given title for a role the theme does not know', () => {
    const heroes = [makeHero({ role: 'devops', slot: 0 })];
    const groups = groupHeroesByRole(heroes, theme, () => 'DevOps Engineer');
    expect(groups).toEqual([{ role: 'devops', title: 'DevOps Engineer', heroes: [heroes[0]] }]);
  });
});

describe('defaultHeroFloor', () => {
  const projects = {
    a: { id: 'a', cwd: '/a', name: 'A', archived: false, createdAt: 1, lastActivityAt: 1 },
    b: { id: 'b', cwd: '/b', name: 'B', archived: false, createdAt: 2, lastActivityAt: 2 },
  };

  it('keeps the current selection when it is a real floor', () => {
    expect(defaultHeroFloor(projects, 'b', 'created')).toBe('b');
  });

  it('falls back to the first floor in stairs order for the Multiverse ("*") or an unknown id', () => {
    expect(defaultHeroFloor(projects, '*', 'created')).toBe('a');
    expect(defaultHeroFloor(projects, 'nope', 'created')).toBe('a');
  });

  it('returns undefined when there are no floors', () => {
    expect(defaultHeroFloor({}, '*', 'created')).toBeUndefined();
  });
});
