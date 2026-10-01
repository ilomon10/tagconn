import {
  PROGRESSION_LIMITS, SKILLS_CONFLICT_CODE, SKILL_TREES, advanceUsageMark, emptyCore, lootGrant, progressView, skillPointsTotal, validateSkillAllocation,
  type Agent, type Hero, type HeroProgress, type HeroProgressCore, type LootId, type SkillAllocationRequest, type UsageCounters,
} from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import { SlidingWindowLimiter, WRITE_LIMIT } from './progression.schema.js';

/** Bound on the in-memory "last seen usage" cache that keeps unchanged upserts off the DB (section 2.3). */
const LRU_SIZE = 2048;
const CORRUPT = 'progress row is corrupt';

interface Binding {
  heroId: string;
  projectId: string;
}

/** XP crediting from agent token usage and the skills/title/heal writes (docs/design/battles.md 2.3, 2.4). */
export class ProgressionService {
  private readonly heroByAgent = new Map<string, Binding>();
  private readonly agentByHero = new Map<string, string>();
  private readonly lastUsage = new Map<string, UsageCounters>();
  private readonly writeLimiter = new SlidingWindowLimiter(() => WRITE_LIMIT.max, WRITE_LIMIT.windowMs);

  constructor(protected readonly deps: Deps<'progressionRepository' | 'heroesRepository' | 'bus' | 'settings' | 'logger'>) {}

  /** Boot: the hero<->agent binding cache. */
  seed(): void {
    for (const h of this.deps.heroesRepository.list()) this.onHeroUpserted(h);
  }

  // ------------------------------------------------------------------ binding cache (F5)

  private dropHero(heroId: string): void {
    const agentId = this.agentByHero.get(heroId);
    if (agentId === undefined) return;
    this.agentByHero.delete(heroId);
    if (this.heroByAgent.get(agentId)?.heroId === heroId) this.heroByAgent.delete(agentId);
  }

  onHeroUpserted(h: Hero): void {
    this.dropHero(h.id);
    if (!h.boundAgentId) return;
    const prior = this.heroByAgent.get(h.boundAgentId);
    if (prior && prior.heroId !== h.id) this.agentByHero.delete(prior.heroId);
    this.heroByAgent.set(h.boundAgentId, { heroId: h.id, projectId: h.projectId });
    this.agentByHero.set(h.id, h.boundAgentId);
  }

  onHeroRemoved(id: string): void {
    this.dropHero(id);
    this.deps.progressionRepository.delete(id);
  }

  onProjectMerged(m: { from: string; into: string }): void {
    for (const b of this.heroByAgent.values()) if (b.projectId === m.from) b.projectId = m.into;
  }

  /** Credit-time re-read: the cache may be stale after a merge (raw SQL, no hero event). */
  private resolveHero(agent: Agent): Hero | undefined {
    const b = this.heroByAgent.get(agent.id);
    if (!b) return undefined;
    const h = this.deps.heroesRepository.get(b.heroId);
    if (!h) {
      this.dropHero(b.heroId);
      return undefined;
    }
    if (h.projectId !== b.projectId || h.boundAgentId !== agent.id) this.onHeroUpserted(h);
    const now = this.heroByAgent.get(agent.id);
    return now && now.heroId === h.id && h.projectId === agent.projectId ? h : undefined;
  }

  // ------------------------------------------------------------------ XP crediting

  onAgentUpserted(agent: Agent, now = Date.now()): void {
    const usage = agent.usage;
    if (!usage) return;
    const key = `${agent.sessionId}\0${agent.id}`;
    const seen = this.lastUsage.get(key);
    if (
      seen &&
      seen.inputTokens === usage.inputTokens && seen.outputTokens === usage.outputTokens &&
      seen.cacheReadTokens === usage.cacheReadTokens && seen.cacheCreationTokens === usage.cacheCreationTokens
    ) {
      return;
    }
    const { progressionRepository: repo, settings } = this.deps;
    const s = settings.get();
    let credited: string | undefined;
    try {
      repo.tx(() => {
        const r = advanceUsageMark(repo.getMark(agent.sessionId, agent.id) ?? null, usage, s.progression.xpWeights);
        if (!r.changed) return;
        repo.upsertMark(agent.sessionId, agent.id, r.mark, now);
        if (!s.progression.enabled || r.xpDelta === 0) return;
        const hero = this.resolveHero(agent);
        if (!hero) return;
        const read = repo.getCore(hero.id);
        if (read.kind === 'corrupt') {
          this.deps.logger.warn({ heroId: hero.id }, 'not crediting XP to a hero with a corrupt progress row');
          return;
        }
        const core = read.kind === 'ok' ? read.core : emptyCore(hero.role, now);
        const xp = Math.min(PROGRESSION_LIMITS.maxXp, core.xp + Math.min(r.xpDelta, PROGRESSION_LIMITS.maxXpPerUpdate));
        if (repo.upsertCore(hero.id, { ...core, xp, updatedAt: now })) credited = hero.id;
      });
    } catch (err) {
      this.deps.logger.warn({ err, agentId: agent.id }, 'XP crediting failed');
      return;
    }
    this.lastUsage.delete(key);
    this.lastUsage.set(key, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens });
    if (this.lastUsage.size > LRU_SIZE) this.lastUsage.delete(this.lastUsage.keys().next().value as string);
    if (credited) this.emit(credited);
  }

  private emit(heroId: string): void {
    const view = this.deps.progressionRepository.view(heroId, this.deps.settings.get());
    if (view) this.deps.bus.emit('progress.upserted', view);
  }

  // ------------------------------------------------------------------ reads

  list(projectId?: string): HeroProgress[] {
    return this.deps.progressionRepository.listViews(projectId, this.deps.settings.get());
  }

  get(heroId: string): HeroProgress {
    const view = this.deps.progressionRepository.view(heroId, this.deps.settings.get());
    if (view) return view;
    if (this.deps.progressionRepository.getCore(heroId).kind === 'corrupt') throw new HttpError(409, CORRUPT);
    throw notFound('Hero');
  }

  // ------------------------------------------------------------------ writes

  /** Shared preamble of skills/title/heal: rate limit, hero exists, row readable. */
  private begin(heroId: string, now: number): { hero: Hero; core: HeroProgressCore } {
    if (!this.writeLimiter.take(now)) throw new HttpError(429, 'Too many progress changes; try again in a minute');
    const hero = this.deps.heroesRepository.get(heroId);
    if (!hero) throw notFound('Hero');
    const read = this.deps.progressionRepository.getCore(heroId);
    if (read.kind === 'corrupt') throw new HttpError(409, CORRUPT);
    return { hero, core: read.kind === 'ok' ? read.core : emptyCore(hero.role, 0) };
  }

  private save(hero: Hero, core: HeroProgressCore): HeroProgress {
    const repo = this.deps.progressionRepository;
    if (!repo.upsertCore(hero.id, core)) throw notFound('Hero');
    const view = repo.view(hero.id, this.deps.settings.get());
    if (!view) throw new HttpError(409, CORRUPT);
    this.deps.bus.emit('progress.upserted', view);
    return view;
  }

  setSkills(heroId: string, body: SkillAllocationRequest, now = Date.now()): HeroProgress {
    const s = this.deps.settings.get();
    if (!s.progression.enabled) throw new HttpError(409, 'Progression is disabled');
    const { hero, core } = this.begin(heroId, now);
    // Guarded by the skills-only stamp: XP credits, titles and heals bump `updatedAt` but never invalidate a skill plan.
    if (body.baseSkillsUpdatedAt !== undefined && body.baseSkillsUpdatedAt !== (core.skillsUpdatedAt ?? 0)) {
      throw new HttpError(409, `Skills changed since you loaded them (${SKILLS_CONFLICT_CODE}); reload and retry`, { code: SKILLS_CONFLICT_CODE });
    }
    const p = s.progression;
    const cur = progressView(hero.id, hero.projectId, hero.role, core, { curve: p, skillPointsPerLevel: p.skillPointsPerLevel });
    const check = validateSkillAllocation(SKILL_TREES[cur.classId], body.skills, cur.skills, {
      level: cur.level,
      totalPoints: skillPointsTotal(cur.level, p.skillPointsPerLevel, core.bonusPoints),
      allowRespec: p.allowRespec,
    });
    if (!check.ok) throw new HttpError(check.code === 'respec-disabled' ? 409 : 400, `Invalid skill allocation: ${check.code}`, { code: check.code, skillId: check.skillId });
    return this.save(hero, { ...core, classId: cur.classId, skills: body.skills, updatedAt: now, skillsUpdatedAt: now });
  }

  equipTitle(heroId: string, title: LootId | null, now = Date.now()): HeroProgress {
    const { hero, core } = this.begin(heroId, now);
    if (title !== null) {
      if (lootGrant(title).kind !== 'title') throw new HttpError(400, 'Not a title');
      if (!core.loot.includes(title)) throw new HttpError(409, 'Title not owned');
    }
    return this.save(hero, { ...core, equippedTitle: title, updatedAt: now });
  }

  heal(heroId: string, now = Date.now()): HeroProgress {
    const { hero, core } = this.begin(heroId, now);
    if (core.koUntil === null || core.koUntil <= now) throw new HttpError(409, 'Hero is not knocked out');
    return this.save(hero, { ...core, koUntil: null, updatedAt: now });
  }
}
