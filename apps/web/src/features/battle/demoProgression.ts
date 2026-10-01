import {
  advanceUsageMark,
  BATTLE_ID_RE,
  buildBattleSetup,
  classForRole,
  CLASS_IDS,
  computeOutcome,
  emptyCore,
  ENGINE_VERSION,
  HERO_ID_RE,
  isKnockedOut,
  LOOT_IDS,
  lootGrant,
  PROGRESSION_LIMITS,
  progressView,
  replay,
  SKILL_ID_RE,
  SKILL_TREES,
  SkillAllocationSchema,
  skillPointsTotal,
  xpFromUsage,
  type Agent,
  type ClassId,
  type BattleCreate,
  type BattleNpcKind,
  type BattleOutcome,
  type BattleResolve,
  type BattleSetup,
  type BattleStart,
  type BattleStatus,
  type Hero,
  type HeroProgress,
  type HeroProgressCore,
  type LootId,
  type PartyMemberInput,
  type SkillAllocation,
  type UsageCounters,
  validateSkillAllocation,
} from '@tagconn/shared';
import { ApiError } from '../../lib/api';
import { getHero, useHeroStore } from '../../stores/heroStore';
import { useOfficeStore } from '../../stores/officeStore';
import { useProgressStore } from '../../stores/progressStore';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * Demo-mode progression (docs/design/battles.md 3.9 P1): the server's XP crediting, battle create and resolve, run
 * locally with the same shared code (`advanceUsageMark`, `buildBattleSetup`, `replay`, `computeOutcome`). The demo has no
 * server, so the loot seed lives in local storage next to the battle. Bad storage never throws (the ADR #25 pattern).
 */

export const DEMO_PROGRESS_KEY = 'tagconn.demoProgress.v1';
const MAX_BATTLES = 20;
const MAX_MARKS = 500;
const BATTLE_STATUSES_STORED: readonly BattleStatus[] = ['open', 'resolved', 'abandoned', 'expired'];

interface DemoBattle {
  id: string;
  projectId: string;
  npcKind: BattleNpcKind;
  encounterId: string;
  setup: BattleSetup;
  lootSeed: number;
  status: BattleStatus;
  createdAt: number;
  expiresAt: number;
  /** Hero members: the hero ids and their party slots. */
  heroes: { heroId: string; memberIndex: number }[];
  logKey: string | null;
  outcome: BattleOutcome | null;
}

interface DemoState {
  cores: Record<string, HeroProgressCore>;
  marks: Record<string, UsageCounters>;
  battles: Record<string, DemoBattle>;
}

const nullProto = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const emptyState = (): DemoState => ({ cores: nullProto(), marks: nullProto(), battles: nullProto() });

let state: DemoState = emptyState();
let loaded = false;

// ------------------------------------------------------------------ storage

const num = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null);
const int = (v: unknown, max?: number): number | null => {
  const n = num(v, max);
  return n === null ? null : Math.floor(n);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function sanitizeCore(raw: unknown): HeroProgressCore | null {
  if (!isObj(raw)) return null;
  const xp = int(raw.xp, PROGRESSION_LIMITS.maxXp);
  const bonusPoints = int(raw.bonusPoints, 1000);
  const wins = int(raw.wins);
  const losses = int(raw.losses);
  const flees = int(raw.flees);
  const updatedAt = num(raw.updatedAt);
  const classId = CLASS_IDS.find((c) => c === raw.classId);
  if (xp === null || bonusPoints === null || wins === null || losses === null || flees === null || updatedAt === null || !classId) return null;
  const skills = nullProto<number>();
  if (isObj(raw.skills)) {
    for (const [k, v] of Object.entries(raw.skills)) {
      if (SKILL_ID_RE.test(k) && typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10) skills[k] = v;
    }
  }
  const loot = Array.isArray(raw.loot) ? LOOT_IDS.filter((l) => (raw.loot as unknown[]).includes(l)) : [];
  const equippedTitle = LOOT_IDS.find((l) => l === raw.equippedTitle) ?? null;
  const koUntil = raw.koUntil === null ? null : num(raw.koUntil);
  if (raw.koUntil !== null && koUntil === null) return null;
  return { classId, xp, bonusPoints, skills, koUntil, wins, losses, flees, loot, equippedTitle, updatedAt };
}

function sanitizeMark(raw: unknown): UsageCounters | null {
  if (!isObj(raw)) return null;
  const inputTokens = num(raw.inputTokens, PROGRESSION_LIMITS.maxCounter);
  const outputTokens = num(raw.outputTokens, PROGRESSION_LIMITS.maxCounter);
  const cacheReadTokens = num(raw.cacheReadTokens, PROGRESSION_LIMITS.maxCounter);
  const cacheCreationTokens = num(raw.cacheCreationTokens, PROGRESSION_LIMITS.maxCounter);
  if (inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheCreationTokens === null) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

function sanitizeBattle(id: string, raw: unknown): DemoBattle | null {
  if (!BATTLE_ID_RE.test(id) || !isObj(raw) || !isObj(raw.setup)) return null;
  const lootSeed = int(raw.lootSeed, 0xffffffff);
  const createdAt = num(raw.createdAt);
  const expiresAt = num(raw.expiresAt);
  const status = BATTLE_STATUSES_STORED.find((s) => s === raw.status);
  const setup = raw.setup as unknown as BattleSetup;
  if (lootSeed === null || createdAt === null || expiresAt === null || !status || typeof raw.projectId !== 'string' || typeof raw.npcKind !== 'string' || typeof raw.encounterId !== 'string') return null;
  if (!Array.isArray(setup.party) || !isObj(setup.enemy) || typeof setup.seed !== 'number') return null;
  const heroes = Array.isArray(raw.heroes)
    ? raw.heroes.flatMap((h: unknown) => (isObj(h) && typeof h.heroId === 'string' && HERO_ID_RE.test(h.heroId) && int(h.memberIndex) !== null ? [{ heroId: h.heroId, memberIndex: h.memberIndex as number }] : []))
    : [];
  return {
    id, projectId: raw.projectId, npcKind: raw.npcKind as BattleNpcKind, encounterId: raw.encounterId, setup, lootSeed, status, createdAt, expiresAt, heroes,
    logKey: typeof raw.logKey === 'string' ? raw.logKey : null,
    outcome: isObj(raw.outcome) ? (raw.outcome as unknown as BattleOutcome) : null,
  };
}

function load(): DemoState {
  const s = emptyState();
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(DEMO_PROGRESS_KEY) ?? 'null');
    if (!isObj(raw)) return s;
    if (isObj(raw.cores)) {
      for (const [id, c] of Object.entries(raw.cores)) {
        const core = HERO_ID_RE.test(id) ? sanitizeCore(c) : null;
        if (core) s.cores[id] = core;
      }
    }
    if (isObj(raw.marks)) {
      for (const [k, m] of Object.entries(raw.marks)) {
        const mark = sanitizeMark(m);
        if (mark) s.marks[k] = mark;
      }
    }
    if (isObj(raw.battles)) {
      for (const [id, b] of Object.entries(raw.battles)) {
        const battle = sanitizeBattle(id, b);
        if (battle) s.battles[id] = battle;
      }
    }
  } catch {
    // Private browsing, disabled storage or corrupt JSON: start empty.
  }
  return s;
}

function save(): void {
  try {
    const marks = Object.entries(state.marks);
    if (marks.length > MAX_MARKS) for (const [k] of marks.slice(0, marks.length - MAX_MARKS)) delete state.marks[k];
    const battles = Object.values(state.battles).sort((a, b) => a.createdAt - b.createdAt);
    for (const b of battles.slice(0, Math.max(0, battles.length - MAX_BATTLES))) delete state.battles[b.id];
    window.localStorage.setItem(DEMO_PROGRESS_KEY, JSON.stringify(state));
  } catch {
    // Best-effort only (quota, private mode): progress just won't survive a reload.
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  state = load();
  loaded = true;
}

// ------------------------------------------------------------------ views

const cfg = () => useSettingsStore.getState().settings;
const curveOf = () => {
  const p = cfg().progression;
  return { levelBase: p.levelBase, levelExponent: p.levelExponent, maxLevel: p.maxLevel };
};
const viewCfg = () => ({ curve: curveOf(), skillPointsPerLevel: cfg().progression.skillPointsPerLevel });
const heroOf = (heroId: string): Hero | undefined => getHero(useHeroStore.getState().heroes, heroId);
const coreOf = (heroId: string): HeroProgressCore | undefined => (Object.hasOwn(state.cores, heroId) ? state.cores[heroId] : undefined);

function viewFor(hero: Hero, core: HeroProgressCore): HeroProgress {
  return progressView(hero.id, hero.projectId, hero.role, core, viewCfg());
}

function pushView(heroId: string): void {
  const hero = heroOf(heroId);
  const core = coreOf(heroId);
  if (hero && core) useProgressStore.getState().upsert(viewFor(hero, core));
}

function pushAll(): void {
  for (const id of Object.keys(state.cores)) pushView(id);
}

const fail = (status: number, message: string): never => {
  throw new ApiError(message, status);
};

// ------------------------------------------------------------------ XP crediting (server 2.3, local)

export function markKey(a: Pick<Agent, 'sessionId' | 'id'>): string {
  return `${a.sessionId}\0${a.id}`;
}

/** Advances the usage marks of `agents` and credits the bound heroes. Returns the hero ids whose XP changed. */
export function creditUsage(agents: Iterable<Agent>, now = Date.now()): string[] {
  ensureLoaded();
  const { enabled, xpWeights } = cfg().progression;
  const heroes = Object.values(useHeroStore.getState().heroes);
  const credited = new Set<string>();
  let dirty = false;
  for (const a of agents) {
    if (!a.usage) continue;
    const key = markKey(a);
    const prev = Object.hasOwn(state.marks, key) ? (state.marks[key] as UsageCounters) : null;
    const r = advanceUsageMark(prev, a.usage, xpWeights);
    if (!r.changed) continue;
    state.marks[key] = r.mark;
    dirty = true;
    if (!enabled || r.xpDelta === 0) continue;
    const hero = heroes.find((h) => h.boundAgentId === a.id && h.projectId === a.projectId);
    if (!hero) continue;
    const core = coreOf(hero.id) ?? emptyCore(hero.role, now);
    state.cores[hero.id] = { ...core, xp: Math.min(PROGRESSION_LIMITS.maxXp, core.xp + r.xpDelta), updatedAt: now };
    credited.add(hero.id);
  }
  if (dirty) save();
  for (const id of credited) pushView(id);
  return [...credited];
}

// ------------------------------------------------------------------ lifecycle

/** Loads the stored state, pushes the views and starts crediting from the demo agents. Returns the stop function. */
export function startDemoProgression(): () => void {
  state = load();
  loaded = true;
  useProgressStore.getState().setAll([]);
  pushAll();
  creditUsage(Object.values(useOfficeStore.getState().agents));

  const unsubOffice = useOfficeStore.subscribe((s, prev) => {
    if (s.agents !== prev.agents) creditUsage(Object.values(s.agents));
  });
  const unsubHeroes = useHeroStore.subscribe((s, prev) => {
    if (s.heroes === prev.heroes) return;
    let dirty = false;
    for (const id of Object.keys(prev.heroes)) {
      if (Object.hasOwn(s.heroes, id)) continue;
      useProgressStore.getState().remove(id);
      if (Object.hasOwn(state.cores, id)) {
        delete state.cores[id];
        dirty = true;
      }
    }
    if (dirty) save();
    for (const id of Object.keys(s.heroes)) if (s.heroes[id] !== prev.heroes[id]) pushView(id);
  });
  const unsubSettings = useSettingsStore.subscribe((s, prev) => {
    if (s.settings.progression !== prev.settings.progression) pushAll();
  });
  return () => {
    unsubOffice();
    unsubHeroes();
    unsubSettings();
  };
}

// ------------------------------------------------------------------ writes (mirror the server routes, 2.4)

const randomUint32 = (): number => {
  const a = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(a);
  else a[0] = Math.floor(Math.random() * 0x1_0000_0000);
  return a[0] as number;
};
const randomHex = (bytes: number): string => {
  const a = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
};

function requireEnabled(): void {
  if (!cfg().progression.enabled || !cfg().battle.enabled) fail(409, 'Battles are disabled (battle.enabled)');
}

function toStart(b: DemoBattle): BattleStart {
  return { id: b.id, projectId: b.projectId, npcKind: b.npcKind, encounterId: b.encounterId, status: b.status, setup: b.setup, createdAt: b.createdAt, expiresAt: b.expiresAt };
}

/** `viewFor(hero, core)` where a hero without a row reads as a fresh level-1 core. */
function viewOrDefault(hero: Hero, now: number): HeroProgress {
  return viewFor(hero, coreOf(hero.id) ?? emptyCore(hero.role, now));
}

export function createBattle(body: BattleCreate, now = Date.now()): BattleStart {
  ensureLoaded();
  requireEnabled();
  const c = cfg();
  if (!Object.hasOwn(useOfficeStore.getState().projects, body.projectId)) fail(404, 'project not found');
  if (body.party.length > c.battle.maxParty) fail(400, `party is limited to ${c.battle.maxParty}`);

  const heroes = Object.values(useHeroStore.getState().heroes);
  const seen = new Set<string>();
  const members: PartyMemberInput[] = [];
  const heroSlots: DemoBattle['heroes'] = [];
  for (const ref of body.party) {
    const dup = ref.kind === 'hero' ? `h:${ref.heroId}` : `a:${ref.agentId}`;
    if (seen.has(dup)) fail(400, 'duplicate party member');
    seen.add(dup);
    if (ref.kind === 'hero') {
      const hero = heroOf(ref.heroId);
      if (!hero) return fail(404, 'hero not found');
      if (hero.projectId !== body.projectId) fail(400, 'hero is on another floor');
      const view = viewOrDefault(hero, now);
      if (isKnockedOut(view, now)) fail(409, 'hero is knocked out');
      heroSlots.push({ heroId: hero.id, memberIndex: members.length });
      members.push({ ref, name: hero.name, role: hero.role, xp: view.xp, skills: view.skills, temporary: false });
    } else {
      if (!c.progression.anonymousInBattle) fail(400, 'anonymous agents may not join (progression.anonymousInBattle)');
      const agent = Object.hasOwn(useOfficeStore.getState().agents, ref.agentId) ? useOfficeStore.getState().agents[ref.agentId] : undefined;
      if (!agent) return fail(404, 'agent not found');
      if (agent.projectId !== body.projectId) fail(400, 'agent is on another floor');
      if (heroes.some((h) => h.boundAgentId === agent.id && h.releasedAt === null)) fail(400, 'agent has a hero; send the hero instead');
      const xp = agent.usage ? xpFromUsage(agent.usage, c.progression.xpWeights) : 0;
      members.push({ ref, name: agent.role, role: agent.role, xp, skills: {}, temporary: true });
    }
  }

  // At most one open battle per floor and per hero (server 2.5 step 4).
  for (const b of Object.values(state.battles)) {
    if (b.status === 'open' && (b.projectId === body.projectId || b.heroes.some((h) => heroSlots.some((s) => s.heroId === h.heroId)))) b.status = 'abandoned';
  }

  const setup = buildBattleSetup({
    seed: randomUint32(), npcKind: body.npcKind, party: members, curve: curveOf(), difficulty: c.battle.difficulty, items: c.battle.items, maxTurns: c.battle.maxTurns,
  });
  let id = `b-${randomHex(6)}`;
  while (Object.hasOwn(state.battles, id)) id = `b-${randomHex(6)}`;
  const battle: DemoBattle = {
    id, projectId: body.projectId, npcKind: body.npcKind, encounterId: body.encounterId, setup, lootSeed: randomUint32(), status: 'open',
    createdAt: now, expiresAt: now + c.battle.openTtlMin * 60_000, heroes: heroSlots, logKey: null, outcome: null,
  };
  state.battles[id] = battle;
  save();
  return toStart(battle);
}

export function resolveBattle(id: string, body: BattleResolve, now = Date.now()): BattleOutcome {
  ensureLoaded();
  requireEnabled();
  const battle = Object.hasOwn(state.battles, id) ? state.battles[id] : undefined;
  if (!battle) return fail(404, 'battle not found');
  const logKey = JSON.stringify(body.log);
  if (battle.status === 'resolved') {
    if (battle.outcome && battle.logKey === logKey) return battle.outcome;
    return fail(409, 'battle already resolved with another log');
  }
  if (battle.status !== 'open') return fail(410, `battle ${battle.status}`);
  if (now > battle.expiresAt) {
    battle.status = 'expired';
    save();
    return fail(410, 'battle expired');
  }
  if (battle.setup.engineVersion !== ENGINE_VERSION) {
    battle.status = 'abandoned';
    save();
    return fail(409, 'engine version changed');
  }

  let r: ReturnType<typeof replay>;
  try {
    r = replay(battle.setup, body.log);
  } catch {
    return fail(400, 'stored battle is unreadable');
  }
  if (!r.ok) return fail(400, `${r.error} (action ${r.at})`);
  if (r.result === null) return fail(400, 'battle not finished');
  if (body.expect && (body.expect.result !== r.result || body.expect.turns !== r.turns)) fail(409, 'battle desync');

  const p = cfg().progression;
  const b = cfg().battle;
  const inputs = battle.heroes.flatMap((h) => {
    const hero = heroOf(h.heroId);
    return hero ? [{ heroId: h.heroId, memberIndex: h.memberIndex, core: coreOf(h.heroId) ?? emptyCore(hero.role, now) }] : [];
  });
  const out = computeOutcome({
    setup: battle.setup, final: r.state, result: r.result, turns: r.turns, lootSeed: battle.lootSeed, heroes: inputs,
    cfg: { curve: curveOf(), skillPointsPerLevel: p.skillPointsPerLevel, xpScale: b.xpScale, koMinutes: b.koMinutes, skillPointEveryWins: b.skillPointEveryWins, lootChance: b.lootChance },
    now,
  });
  const outcome: BattleOutcome = { battleId: id, result: r.result, turns: r.turns, heroes: out.awards, loot: out.loot, resolvedAt: now };
  for (const [heroId, core] of Object.entries(out.next)) state.cores[heroId] = core;
  battle.status = 'resolved';
  battle.logKey = logKey;
  battle.outcome = outcome;
  save();
  for (const heroId of Object.keys(out.next)) pushView(heroId);
  return outcome;
}

export function abandonBattle(id: string): BattleStatus {
  ensureLoaded();
  const battle = Object.hasOwn(state.battles, id) ? state.battles[id] : undefined;
  if (!battle) return fail(404, 'battle not found');
  if (battle.status === 'resolved') return fail(409, 'battle already resolved');
  if (battle.status === 'open') {
    battle.status = 'abandoned';
    save();
  }
  return battle.status;
}

function heroOrFail(heroId: string): Hero {
  const hero = HERO_ID_RE.test(heroId) ? heroOf(heroId) : undefined;
  return hero ?? fail(404, 'hero not found');
}

export function saveSkills(heroId: string, skills: SkillAllocation, baseUpdatedAt?: number, now = Date.now()): HeroProgress {
  ensureLoaded();
  const hero = heroOrFail(heroId);
  if (!cfg().progression.enabled) fail(409, 'progression is disabled');
  const parsed = SkillAllocationSchema.safeParse({ skills, baseUpdatedAt });
  if (!parsed.success) return fail(400, 'invalid skill allocation');
  const stored = coreOf(hero.id);
  if (stored && parsed.data.baseUpdatedAt !== undefined && parsed.data.baseUpdatedAt !== stored.updatedAt) fail(409, 'progress changed, reload');

  const core = stored ?? emptyCore(hero.role, now);
  const view = viewFor(hero, core);
  const classId = classForRole(hero.role);
  const p = cfg().progression;
  const check = validateSkills(classId, parsed.data.skills, view, p.skillPointsPerLevel, p.allowRespec);
  if (check) fail(check === 'respec-disabled' ? 409 : 400, check);
  state.cores[hero.id] = { ...core, classId, skills: parsed.data.skills, updatedAt: now };
  save();
  pushView(hero.id);
  return viewFor(hero, coreOf(hero.id) as HeroProgressCore);
}

/** The failing check code, or null when the allocation is valid. */
function validateSkills(classId: ClassId, next: SkillAllocation, view: HeroProgress, perLevel: number, allowRespec: boolean): string | null {
  const r = validateSkillAllocation(SKILL_TREES[classId], next, view.skills, {
    level: view.level, totalPoints: skillPointsTotal(view.level, perLevel, view.bonusPoints), allowRespec,
  });
  return r.ok ? null : r.code;
}

export function equipTitle(heroId: string, title: LootId | null, now = Date.now()): HeroProgress {
  ensureLoaded();
  const hero = heroOrFail(heroId);
  if (title !== null && (!LOOT_IDS.includes(title) || lootGrant(title).kind !== 'title')) fail(400, 'not a title');
  const core = coreOf(hero.id) ?? emptyCore(hero.role, now);
  if (title !== null && !core.loot.includes(title)) fail(409, 'title not owned');
  state.cores[hero.id] = { ...core, equippedTitle: title, updatedAt: now };
  save();
  pushView(hero.id);
  return viewFor(hero, state.cores[hero.id] as HeroProgressCore);
}

export function healHero(heroId: string, now = Date.now()): HeroProgress {
  ensureLoaded();
  const hero = heroOrFail(heroId);
  const core = coreOf(hero.id);
  if (!core || !isKnockedOut(core, now)) return fail(409, 'hero is not knocked out');
  state.cores[hero.id] = { ...core, koUntil: null, updatedAt: now };
  save();
  pushView(hero.id);
  return viewFor(hero, state.cores[hero.id] as HeroProgressCore);
}

/** Test seam: forget the in-memory state (storage is untouched) so the next call reloads it. */
export function resetDemoProgression(): void {
  state = emptyState();
  loaded = false;
}

/** Read-only peek for tests and debugging. */
export const demoProgressionState = (): Readonly<DemoState> => state;
