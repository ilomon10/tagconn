import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBattleSetup,
  computeOutcome,
  createBattle as createEngineBattle,
  defaultSettings,
  emptyCore,
  legalActions,
  replay,
  applyAction,
  xpFromUsage,
  type Agent,
  type BattleSetup,
  type PlayerAction,
} from '@tagconn/shared';
import { ApiError } from '../../../lib/api';
import { DEFAULT_ROLES } from '../../../lib/defaultRoles';
import { demoHeroes } from '../../../lib/mock';
import { useHeroStore } from '../../../stores/heroStore';
import { useOfficeStore } from '../../../stores/officeStore';
import { useProgressStore } from '../../../stores/progressStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import {
  abandonBattle,
  createBattle,
  creditUsage,
  DEMO_PROGRESS_KEY,
  demoProgressionState,
  equipTitle,
  healHero,
  resetDemoProgression,
  resolveBattle,
  saveSkills,
  startDemoProgression,
} from '../demoProgression';

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

const PROJECT = 'p1';
const usage = (outputTokens: number) => ({ inputTokens: 0, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 1, contextTokens: 0 });
function agent(over: Partial<Agent> = {}): Agent {
  return { id: 'a1', sessionId: 's1', projectId: PROJECT, isMain: false, agentType: 'general-purpose', role: 'developer', status: 'active', activity: 'typing', zone: 'desks', toolCount: 1, startedAt: 1_000, updatedAt: 1_000, ...over };
}

let storage: ReturnType<typeof fakeLocalStorage>;

function addHero(a = agent()): string {
  useOfficeStore.getState().upsertAgent(a);
  demoHeroes.bindHeroForAgent(a);
  return Object.values(useHeroStore.getState().heroes).find((h) => h.boundAgentId === a.id)!.id;
}

/** Plays the first legal action until the battle ends (the same engine the scene animates). */
function play(setup: BattleSetup): PlayerAction[] {
  let s = createEngineBattle(setup);
  const log: PlayerAction[] = [];
  for (let i = 0; i < 500 && s.result === null; i++) {
    const legal = legalActions(setup, s);
    const a = legal.filter((x) => x.t === 'move').at(-1) ?? legal[0]!;
    const r = applyAction(setup, s, a);
    if (!r.ok) throw new Error(r.error);
    s = r.state;
    log.push(a);
  }
  return log;
}

beforeEach(() => {
  storage = fakeLocalStorage();
  vi.stubGlobal('window', { localStorage: storage });
  useHeroStore.setState({ heroes: {} });
  useOfficeStore.getState().reset();
  useOfficeStore.getState().upsertProject({ id: PROJECT, name: 'P', path: '/p', createdAt: 1, updatedAt: 1 } as never);
  useProgressStore.getState().setAll([]);
  useSettingsStore.getState().setSettings(defaultSettings());
  useSettingsStore.getState().setRoles(DEFAULT_ROLES);
  resetDemoProgression();
});

describe('demo XP crediting', () => {
  it('credits the bound hero from usage and pushes a view', () => {
    const heroId = addHero();
    creditUsage([agent({ usage: usage(1000) })]);
    const w = defaultSettings().progression.xpWeights;
    expect(useProgressStore.getState().progress[heroId]?.xp).toBe(xpFromUsage(usage(1000), w));
  });

  it('never double-counts across repeats and reloads', () => {
    const heroId = addHero();
    const a = agent({ usage: usage(1000) });
    creditUsage([a]);
    creditUsage([a]);
    const xp = demoProgressionState().cores[heroId]!.xp;
    resetDemoProgression(); // a reload: state comes back from storage
    startDemoProgression()();
    creditUsage([a]);
    expect(demoProgressionState().cores[heroId]!.xp).toBe(xp);
    creditUsage([agent({ usage: usage(1500) })]);
    expect(demoProgressionState().cores[heroId]!.xp).toBe(xp + 500);
  });

  it('advances the mark without crediting when progression is off or the agent has no hero', () => {
    const w = defaultSettings();
    useSettingsStore.getState().setSettings({ ...w, progression: { ...w.progression, enabled: false } });
    const heroId = addHero();
    creditUsage([agent({ usage: usage(1000) })]);
    expect(demoProgressionState().cores[heroId]).toBeUndefined();
    useSettingsStore.getState().setSettings(w);
    creditUsage([agent({ usage: usage(1000) })]);
    expect(demoProgressionState().cores[heroId]).toBeUndefined();
    expect(creditUsage([agent({ id: 'ghost', usage: usage(99) })])).toEqual([]);
  });

  it('subscribes to the office store and drops a removed hero', () => {
    const heroId = addHero();
    const stop = startDemoProgression();
    useOfficeStore.getState().upsertAgent(agent({ usage: usage(400) }));
    expect(useProgressStore.getState().progress[heroId]).toBeDefined();
    useHeroStore.getState().removeHero(heroId);
    expect(useProgressStore.getState().progress[heroId]).toBeUndefined();
    expect(demoProgressionState().cores[heroId]).toBeUndefined();
    stop();
  });
});

describe('bad storage never throws', () => {
  it('survives corrupt JSON, wrong shapes, and throwing storage', () => {
    for (const raw of ['{', 'null', '[]', '{"cores":{"__proto__":1,"h-00000000":{"xp":"x"}},"marks":5,"battles":{"b-aaaaaaaaaaaa":{}}}']) {
      storage.setItem(DEMO_PROGRESS_KEY, raw);
      resetDemoProgression();
      expect(() => startDemoProgression()()).not.toThrow();
      expect(Object.keys(demoProgressionState().cores)).toHaveLength(0);
    }
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } } });
    resetDemoProgression();
    addHero();
    expect(() => creditUsage([agent({ usage: usage(10) })])).not.toThrow();
  });
});

const rejects = (fn: () => unknown, status: number) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    return;
  }
  throw new Error(`expected an ApiError ${status}`);
};

function startFor(heroId: string, now = Date.now()) {
  return createBattle({ projectId: PROJECT, npcKind: 'sales-dog', encounterId: 'sales-dog-1', party: [{ kind: 'hero', heroId }] }, now);
}

describe('demo battles', () => {
  it('plays a battle end to end and resolves it exactly like the server path', () => {
    const heroId = addHero();
    const start = startFor(heroId);
    expect(start.status).toBe('open');
    expect(start).not.toHaveProperty('lootSeed');
    const log = play(start.setup);
    const r = replay(start.setup, log);
    if (!r.ok || r.result === null) throw new Error('battle did not finish');

    const stored = demoProgressionState().battles[start.id]!;
    const p = defaultSettings().progression;
    const b = defaultSettings().battle;
    const expected = computeOutcome({
      setup: start.setup, final: r.state, result: r.result, turns: r.turns, lootSeed: stored.lootSeed,
      heroes: [{ heroId, memberIndex: 0, core: emptyCore('developer', 6_000) }],
      cfg: { curve: { levelBase: p.levelBase, levelExponent: p.levelExponent, maxLevel: p.maxLevel }, skillPointsPerLevel: p.skillPointsPerLevel, xpScale: b.xpScale, koMinutes: b.koMinutes, skillPointEveryWins: b.skillPointEveryWins, lootChance: b.lootChance },
      now: 6_000,
    });
    const out = resolveBattle(start.id, { log, expect: { result: r.result, turns: r.turns } }, 6_000);
    expect(out).toMatchObject({ battleId: start.id, result: r.result, turns: r.turns, loot: expected.loot, heroes: expected.awards });
    expect(demoProgressionState().cores[heroId]).toMatchObject({ xp: expected.next[heroId]!.xp, wins: expected.next[heroId]!.wins, loot: expected.next[heroId]!.loot });
    expect(useProgressStore.getState().progress[heroId]?.xp).toBe(expected.next[heroId]!.xp);

    // Idempotent for the same log, 409 for another, and it survives a reload.
    expect(resolveBattle(start.id, { log }, 7_000)).toEqual(out);
    rejects(() => resolveBattle(start.id, { log: [...log, { t: 'run' }] }, 7_000), 409);
    resetDemoProgression();
    expect(resolveBattle(start.id, { log }, 8_000)).toEqual(out);
  });

  it('a fixed seed and lootSeed give a deterministic outcome', () => {
    const heroId = addHero();
    const start = startFor(heroId);
    const stored = demoProgressionState().battles[start.id]!;
    const p = defaultSettings().progression;
    stored.setup = buildBattleSetup({
      seed: 1234, npcKind: 'sales-dog', party: [{ ref: { kind: 'hero', heroId }, name: 'X', role: 'developer', xp: 0, skills: {}, temporary: false }],
      curve: { levelBase: p.levelBase, levelExponent: p.levelExponent, maxLevel: p.maxLevel }, difficulty: 1, items: defaultSettings().battle.items, maxTurns: 60,
    });
    stored.lootSeed = 99;
    const log = play(stored.setup);
    const a = resolveBattle(start.id, { log }, 6_000);
    resetDemoProgression();
    vi.stubGlobal('window', { localStorage: fakeLocalStorage() });
    const start2 = startFor(heroId);
    const s2 = demoProgressionState().battles[start2.id]!;
    s2.setup = stored.setup;
    s2.lootSeed = 99;
    expect(resolveBattle(start2.id, { log }, 6_000)).toMatchObject({ result: a.result, turns: a.turns, loot: a.loot, heroes: a.heroes });
  });

  it('rejects bad parties and unfinished or invalid logs without changing anything', () => {
    const heroId = addHero();
    rejects(() => createBattle({ projectId: 'nope', npcKind: 'guest', encounterId: 'g-1', party: [{ kind: 'hero', heroId }] }), 404);
    rejects(() => createBattle({ projectId: PROJECT, npcKind: 'guest', encounterId: 'g-1', party: [{ kind: 'hero', heroId }, { kind: 'hero', heroId }] }), 400);
    rejects(() => createBattle({ projectId: PROJECT, npcKind: 'guest', encounterId: 'g-1', party: [{ kind: 'agent', agentId: 'a1' }] }), 400); // bound to a hero
    const start = startFor(heroId);
    rejects(() => resolveBattle(start.id, { log: [] }), 400);
    rejects(() => resolveBattle(start.id, { log: [{ t: 'swap', to: 3 }] }), 400);
    rejects(() => resolveBattle('b-000000000000', { log: [] }), 404);
    expect(demoProgressionState().battles[start.id]?.status).toBe('open');
  });

  it('lets an anonymous agent join, gates on settings, and abandons idempotently', () => {
    addHero();
    useOfficeStore.getState().upsertAgent(agent({ id: 'a2', usage: usage(5000) }));
    const start = createBattle({ projectId: PROJECT, npcKind: 'guest', encounterId: 'g-1', party: [{ kind: 'agent', agentId: 'a2' }] });
    expect(start.setup.party[0]?.temporary).toBe(true);
    expect(abandonBattle(start.id)).toBe('abandoned');
    expect(abandonBattle(start.id)).toBe('abandoned');
    rejects(() => resolveBattle(start.id, { log: [] }), 410);
    const d = defaultSettings();
    useSettingsStore.getState().setSettings({ ...d, battle: { ...d.battle, enabled: false } });
    rejects(() => createBattle({ projectId: PROJECT, npcKind: 'guest', encounterId: 'g-1', party: [{ kind: 'agent', agentId: 'a2' }] }), 409);
  });

  it('a newer battle on the floor abandons the older open one', () => {
    const heroId = addHero();
    const first = startFor(heroId);
    startFor(heroId);
    expect(demoProgressionState().battles[first.id]?.status).toBe('abandoned');
  });
});

describe('demo skills, titles and heal', () => {
  it('saves a skill allocation, enforcing points and the base version', () => {
    const heroId = addHero();
    creditUsage([agent({ usage: usage(100_000) })]); // enough for several levels
    const view = useProgressStore.getState().progress[heroId]!;
    expect(view.skillPoints).toBeGreaterThan(0);
    const saved = saveSkills(heroId, { 'developer.0.1': 1 }, view.updatedAt, 9_000);
    expect(saved.skills).toEqual({ 'developer.0.1': 1 });
    expect(useProgressStore.getState().progress[heroId]?.skills).toEqual({ 'developer.0.1': 1 });
    rejects(() => saveSkills(heroId, { 'developer.0.1': 1 }, view.updatedAt - 1), 409);
    rejects(() => saveSkills(heroId, { 'developer.0.4': 1 }, undefined), 400); // missing prerequisites
    rejects(() => saveSkills(heroId, { 'bogus': 1 }, undefined), 400);
    rejects(() => saveSkills('h-ffffffff', {}), 404);
  });

  it('equips only owned titles and heals only knocked-out heroes', () => {
    const heroId = addHero();
    creditUsage([agent({ usage: usage(10) })]);
    rejects(() => equipTitle(heroId, 'hat-cap' as never), 400);
    rejects(() => healHero(heroId), 409);
    rejects(() => equipTitle(heroId, 'title-unsold'), 409);
    demoProgressionState().cores[heroId]!.loot = ['title-unsold'];
    expect(equipTitle(heroId, 'title-unsold').equippedTitle).toBe('title-unsold');
    expect(equipTitle(heroId, null).equippedTitle).toBeNull();
    demoProgressionState().cores[heroId]!.koUntil = Date.now() + 60_000;
    expect(healHero(heroId).koUntil).toBeNull();
  });
});
