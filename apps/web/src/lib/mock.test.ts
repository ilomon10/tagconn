import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Agent } from '@tagconn/shared';
import { useHeroStore } from '../stores/heroStore';
import { useOfficeStore } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { DEFAULT_ROLES } from './defaultRoles';
import { demoHeroes } from './mock';

/**
 * `mock.ts` demo hero binding (docs/design/living-office.md section 3.2/8i, task W2). No jsdom is
 * configured for this project's vitest environment (`node`), so `window.localStorage` is stubbed with
 * a tiny in-memory implementation — exactly the kind of environment `loadDemoHeroes`/`saveDemoHeroes`
 * must degrade gracefully in (see their try/catch).
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

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    sessionId: 's1',
    projectId: PROJECT_ID,
    isMain: false,
    agentType: 'general-purpose',
    role: 'developer',
    status: 'active',
    activity: 'typing',
    zone: 'desks',
    toolCount: 1,
    startedAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

describe('mock.ts demo hero binding', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: fakeLocalStorage() });
    useHeroStore.setState({ heroes: {} });
    useOfficeStore.getState().reset();
    useSettingsStore.getState().setSettings(defaultSettings());
    useSettingsStore.getState().setRoles(DEFAULT_ROLES);
  });

  it('creates a hero for a new, non-idle agent using the shared naming/appearance rule', () => {
    const a = agent();
    useOfficeStore.getState().upsertAgent(a);
    demoHeroes.bindHeroForAgent(a);

    const heroes = Object.values(useHeroStore.getState().heroes);
    expect(heroes).toHaveLength(1);
    expect(heroes[0]).toMatchObject({ projectId: PROJECT_ID, role: 'developer', slot: 0, boundAgentId: 'a1', releasedAt: null, customized: false });
    expect(heroes[0]!.id).toMatch(/^h-[a-f0-9]{8}$/);
  });

  it('does not create a hero for a brand-new agent that is already idle', () => {
    const a = agent({ activity: 'idle' });
    useOfficeStore.getState().upsertAgent(a);
    demoHeroes.bindHeroForAgent(a);
    expect(Object.keys(useHeroStore.getState().heroes)).toHaveLength(0);
  });

  it('does nothing when heroes.enabled is false', () => {
    useSettingsStore.getState().setSettings({ ...defaultSettings(), heroes: { ...defaultSettings().heroes, enabled: false } });
    const a = agent();
    useOfficeStore.getState().upsertAgent(a);
    demoHeroes.bindHeroForAgent(a);
    expect(Object.keys(useHeroStore.getState().heroes)).toHaveLength(0);
  });

  it('releases a hero when its agent finishes, and reuses it for the next agent of the same role', () => {
    const a1 = agent({ id: 'a1' });
    useOfficeStore.getState().upsertAgent(a1);
    demoHeroes.bindHeroForAgent(a1);
    const firstHeroId = Object.keys(useHeroStore.getState().heroes)[0]!;

    const done = { ...a1, status: 'done' as const, activity: 'done' as const, updatedAt: 2_000 };
    useOfficeStore.getState().upsertAgent(done);
    demoHeroes.bindHeroForAgent(done);
    expect(useHeroStore.getState().heroes[firstHeroId]?.releasedAt).toBe(2_000);

    const a2 = agent({ id: 'a2', updatedAt: 3_000 });
    useOfficeStore.getState().upsertAgent(a2);
    demoHeroes.bindHeroForAgent(a2);

    const heroes = Object.values(useHeroStore.getState().heroes);
    expect(heroes).toHaveLength(1); // reused, not a second hero
    expect(heroes[0]!.id).toBe(firstHeroId);
    expect(heroes[0]).toMatchObject({ boundAgentId: 'a2', releasedAt: null });
  });

  it('keeps the hero (un-releasing it) when the same agent id comes back after a stale release', () => {
    const a1 = agent({ id: 'a1' });
    useOfficeStore.getState().upsertAgent(a1);
    demoHeroes.bindHeroForAgent(a1);
    const heroId = Object.keys(useHeroStore.getState().heroes)[0]!;

    // Simulate 8a: a stale-removal releases the hero without the agent itself changing status.
    useHeroStore.getState().upsertHero({ ...useHeroStore.getState().heroes[heroId]!, releasedAt: 2_000 });

    const backAgain = { ...a1, updatedAt: 3_000 };
    demoHeroes.bindHeroForAgent(backAgain);
    expect(useHeroStore.getState().heroes[heroId]).toMatchObject({ boundAgentId: 'a1', releasedAt: null });
    expect(Object.keys(useHeroStore.getState().heroes)).toHaveLength(1);
  });

  it('gives the main agent pm hero slot 0', () => {
    const pm = agent({ id: 'main:s1', isMain: true, role: 'pm', activity: 'thinking' });
    useOfficeStore.getState().upsertAgent(pm);
    demoHeroes.bindHeroForAgent(pm);
    const hero = Object.values(useHeroStore.getState().heroes)[0];
    expect(hero).toMatchObject({ role: 'pm', slot: 0, boundAgentId: 'main:s1' });
  });

  it('releaseHeroForAgent releases a bound hero (removal without a prior finish)', () => {
    const a = agent();
    useOfficeStore.getState().upsertAgent(a);
    demoHeroes.bindHeroForAgent(a);
    const heroId = Object.keys(useHeroStore.getState().heroes)[0]!;
    demoHeroes.releaseHeroForAgent('a1');
    expect(useHeroStore.getState().heroes[heroId]?.releasedAt).not.toBeNull();
  });

  it('releaseAllHeroes releases every still-bound hero at once', () => {
    const a = agent();
    useOfficeStore.getState().upsertAgent(a);
    demoHeroes.bindHeroForAgent(a);
    const heroId = Object.keys(useHeroStore.getState().heroes)[0]!;
    expect(useHeroStore.getState().heroes[heroId]?.releasedAt).toBeNull();
    demoHeroes.releaseAllHeroes();
    expect(useHeroStore.getState().heroes[heroId]?.releasedAt).not.toBeNull();
  });

  describe('localStorage persistence', () => {
    it('saveDemoHeroes/loadDemoHeroes round-trip through the stubbed storage', () => {
      const a = agent();
      useOfficeStore.getState().upsertAgent(a);
      demoHeroes.bindHeroForAgent(a); // saves as a side effect

      const raw = window.localStorage.getItem(demoHeroes.DEMO_HEROES_KEY);
      expect(raw).toBeTruthy();
      const loaded = demoHeroes.loadDemoHeroes();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.boundAgentId).toBe('a1');
    });

    it('loadDemoHeroes tolerates missing, corrupt or invalid-shape storage', () => {
      expect(demoHeroes.loadDemoHeroes()).toEqual([]);
      window.localStorage.setItem(demoHeroes.DEMO_HEROES_KEY, 'not json');
      expect(demoHeroes.loadDemoHeroes()).toEqual([]);
      window.localStorage.setItem(demoHeroes.DEMO_HEROES_KEY, JSON.stringify([{ id: 'not-a-hero' }]));
      expect(demoHeroes.loadDemoHeroes()).toEqual([]);
    });

    it('saveDemoHeroes never throws when storage is unavailable', () => {
      vi.stubGlobal('window', {
        localStorage: {
          setItem: () => {
            throw new Error('quota exceeded');
          },
        },
      });
      expect(() => demoHeroes.saveDemoHeroes()).not.toThrow();
    });
  });
});
