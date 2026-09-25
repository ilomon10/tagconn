import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, type Hero } from '@tagconn/shared';
import { useHeroStore } from '../../stores/heroStore';
import { useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { classifyHeroError, createHero, deleteHero, patchHero, resetHero } from './commands';

/**
 * Demo-mode hero writes (docs/design/living-office.md section 3.4). No jsdom is configured for this
 * project's vitest environment (`node`), so `window.localStorage` is stubbed — same approach as
 * `lib/mock.test.ts` (`demoHeroes.saveDemoHeroes()` degrades gracefully without it either way).
 */

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear' | 'key' | 'length'>;
}

const PROJECT_ID = 'p1';

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { localStorage: fakeLocalStorage() };
  useHeroStore.setState({ heroes: Object.create(null) });
  useSettingsStore.getState().setSettings(defaultSettings());
  useOfficeStore.setState({ connection: 'demo' });
});

function hero(over: Partial<Hero> = {}): Hero {
  const now = 1_000;
  return {
    id: 'h-aaaaaaaa',
    projectId: PROJECT_ID,
    role: 'developer',
    slot: 0,
    name: 'Brom',
    title: null,
    appearance: { skin: '#f5c89a', hairStyle: 0, hairColor: '#3b2a20', outfitColor: null, hat: 'auto', hatColor: null, prop: 'auto', accessory: 'auto', accessoryColor: null },
    customized: false,
    boundAgentId: null,
    boundAt: null,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('createHero (demo)', () => {
  it('recruits a hero into the lowest free slot', async () => {
    const h = await createHero({ projectId: PROJECT_ID, role: 'developer' });
    expect(h.slot).toBe(0);
    expect(h.projectId).toBe(PROJECT_ID);
    expect(useHeroStore.getState().heroes[h.id]).toEqual(h);
  });

  it('rejects with a clear cap error once heroes.maxPerRole is reached', async () => {
    useSettingsStore.getState().setSettings({ ...defaultSettings(), heroes: { ...defaultSettings().heroes, maxPerRole: 1 } });
    await createHero({ projectId: PROJECT_ID, role: 'developer' });
    await expect(createHero({ projectId: PROJECT_ID, role: 'developer' })).rejects.toThrow(/heroes\.maxPerRole/);
  });

  it('rejects with a clear cap error once heroes.maxPerProject is reached', async () => {
    useSettingsStore.getState().setSettings({ ...defaultSettings(), heroes: { ...defaultSettings().heroes, maxPerProject: 1 } });
    await createHero({ projectId: PROJECT_ID, role: 'developer' });
    await expect(createHero({ projectId: PROJECT_ID, role: 'qa-engineer' })).rejects.toThrow(/heroes\.maxPerProject/);
  });
});

describe('patchHero (demo)', () => {
  it('applies the patch and marks the hero customized', async () => {
    useHeroStore.getState().upsertHero(hero());
    const updated = await patchHero('h-aaaaaaaa', { name: 'Wendel' });
    expect(updated.name).toBe('Wendel');
    expect(updated.customized).toBe(true);
  });
});

describe('resetHero (demo)', () => {
  it('clears customized and regenerates the seeded look', async () => {
    useHeroStore.getState().upsertHero(hero({ name: 'Custom Name', customized: true }));
    const reset = await resetHero('h-aaaaaaaa');
    expect(reset.customized).toBe(false);
    expect(reset.title).toBeNull();
  });
});

describe('deleteHero (demo)', () => {
  it('removes a released hero', async () => {
    useHeroStore.getState().upsertHero(hero());
    await deleteHero('h-aaaaaaaa');
    expect(useHeroStore.getState().heroes['h-aaaaaaaa']).toBeUndefined();
  });

  it('rejects while bound to a live (unreleased) agent', async () => {
    useHeroStore.getState().upsertHero(hero({ boundAgentId: 'agent-1', releasedAt: null }));
    await expect(deleteHero('h-aaaaaaaa')).rejects.toThrow(/bound to a live agent/);
  });
});

describe('classifyHeroError', () => {
  it('classifies conflict, cap and bound messages, else "other"', () => {
    expect(classifyHeroError(new Error('Hero "h-1" was changed since you loaded it'))).toEqual({ kind: 'conflict', message: expect.any(String) });
    expect(classifyHeroError(new Error('at most 6 heroes per role may be stored (heroes.maxPerRole)'))).toMatchObject({ kind: 'cap', capKind: 'role' });
    expect(classifyHeroError(new Error('at most 40 heroes per project may be stored (heroes.maxPerProject)'))).toMatchObject({ kind: 'cap', capKind: 'project' });
    expect(classifyHeroError(new Error('Hero "h-1" is bound to a live agent'))).toEqual({ kind: 'bound', message: expect.any(String) });
    expect(classifyHeroError(new Error('boom'))).toEqual({ kind: 'other', message: 'boom' });
  });
});
