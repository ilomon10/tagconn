import { randomBytes } from 'node:crypto';
import {
  type Agent,
  type BoundAgentState,
  chooseHeroForAgent,
  generateHeroAppearance,
  type Hero,
  type HeroAppearance,
  HERO_ID_RE,
  type HeroCreate,
  HeroCreateSchema,
  heroRoleFor,
  type HeroPatch,
  HeroPatchSchema,
  heroSeed,
  isHeroReleased,
  namePoolFor,
  pickHeroName,
} from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { HttpError, notFound } from '../../core/http/index.js';
import type { HeroesRepository } from './heroes.repository.js';

type HeroesDeps = Deps<'heroesRepository' | 'projectsRepository' | 'agentsRepository' | 'rolesService' | 'settings' | 'bus' | 'logger'>;

/**
 * Binds live agents to persistent named heroes (M8 8i, docs/design/living-office.md §3.2) and exposes
 * hand-authored CRUD for the hero editor. Never imports the agents module's internals: agent state
 * flows in only through `onAgentUpserted`/`onAgentRemoved`, wired to the bus by `index.ts`.
 */
export class HeroesService {
  /** Liveness/activity of every tracked agent, seeded at boot and kept current from the bus. */
  private readonly agentState = new Map<string, BoundAgentState>();
  /** Hero currently bound and unreleased to an agent id — an O(1) "already has a hero" check that
   * keeps the hot path (every tool call) a map lookup with no DB access. */
  private readonly boundHeroByAgent = new Map<string, string>();

  constructor(private readonly deps: HeroesDeps) {}

  private get repo(): HeroesRepository {
    return this.deps.heroesRepository;
  }

  /** Boot: rebuild in-memory state from the DB (read-only), so bindings survive a restart. */
  seed(): void {
    for (const a of this.deps.agentsRepository.listLive()) {
      this.agentState.set(a.id, { live: a.status !== 'done', activity: a.activity, lastEventAt: a.updatedAt });
    }
    for (const h of this.repo.list()) {
      if (h.boundAgentId && !isHeroReleased(h)) this.boundHeroByAgent.set(h.boundAgentId, h.id);
    }
  }

  /**
   * `agent.upserted`: keep the state map current, then bind or release. A live agent that already has
   * an unreleased hero (or is idle without one, i.e. it was just taken over) is a no-op — no DB write.
   */
  onAgentUpserted(agent: Agent, now = Date.now()): void {
    const live = agent.status !== 'done';
    this.agentState.set(agent.id, { live, activity: agent.activity, lastEventAt: agent.updatedAt });
    if (!this.deps.settings.get().heroes.enabled) return;

    if (!live) {
      this.release(agent.id, now);
      return;
    }
    if (this.boundHeroByAgent.has(agent.id)) return;
    if (agent.activity === 'idle') return; // wait for a non-idle event before claiming a new hero
    this.assign(agent, now);
  }

  /** `agent.removed` (including 8a stale removals): the agent leaves the floor; its hero is released. */
  onAgentRemoved(agentId: string, now = Date.now()): void {
    const state = this.agentState.get(agentId);
    if (state) state.live = false;
    if (!this.deps.settings.get().heroes.enabled) return;
    this.release(agentId, now);
  }

  private release(agentId: string, now: number): void {
    const heroId = this.boundHeroByAgent.get(agentId);
    if (!heroId) return;
    this.boundHeroByAgent.delete(agentId);
    const hero = this.repo.get(heroId);
    if (!hero || isHeroReleased(hero)) return;
    const updated: Hero = { ...hero, releasedAt: now, updatedAt: now };
    this.repo.upsert(updated);
    this.deps.bus.emit('hero.upserted', updated);
  }

  private assign(agent: Agent, now: number): void {
    const cfg = this.deps.settings.get().heroes;
    const projectHeroes = this.repo.list(agent.projectId);
    const assignment = chooseHeroForAgent({
      agent: { id: agent.id, projectId: agent.projectId, isMain: agent.isMain, role: agent.role },
      heroes: projectHeroes,
      agents: this.agentState,
      maxPerRole: cfg.maxPerRole,
      maxPerProject: cfg.maxPerProject,
      reuseIdleAfterSec: cfg.reuseIdleAfterSec,
      now,
    });

    switch (assignment.kind) {
      case 'keep': {
        const hero = projectHeroes.find((h) => h.id === assignment.heroId);
        if (!hero) break;
        this.boundHeroByAgent.set(agent.id, hero.id);
        if (hero.releasedAt !== null) {
          const updated: Hero = { ...hero, releasedAt: null, updatedAt: now };
          this.repo.upsert(updated);
          this.deps.bus.emit('hero.upserted', updated);
        }
        break;
      }
      case 'reuse': {
        const hero = projectHeroes.find((h) => h.id === assignment.heroId);
        if (!hero) break;
        const updated: Hero = { ...hero, boundAgentId: agent.id, boundAt: now, releasedAt: null, updatedAt: now };
        this.repo.upsert(updated);
        this.boundHeroByAgent.set(agent.id, updated.id);
        if (assignment.takenFrom) this.boundHeroByAgent.delete(assignment.takenFrom);
        this.deps.bus.emit('hero.upserted', updated);
        break;
      }
      case 'create': {
        const role = heroRoleFor(agent);
        const seed = heroSeed(agent.projectId, role, assignment.slot);
        const name = pickHeroName(namePoolFor(cfg.namePools, role), projectHeroes.map((h) => h.name), seed, this.roleTitle(role));
        const hero: Hero = {
          id: this.freshId(),
          projectId: agent.projectId,
          role,
          slot: assignment.slot,
          name,
          title: null,
          appearance: generateHeroAppearance(seed),
          customized: false,
          boundAgentId: agent.id,
          boundAt: now,
          releasedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.repo.upsert(hero);
        this.boundHeroByAgent.set(agent.id, hero.id);
        this.deps.bus.emit('hero.upserted', hero);
        break;
      }
      case 'none':
        break;
    }
  }

  private roleTitle(role: string): string {
    return this.deps.rolesService.get(role)?.title ?? role;
  }

  private freshId(): string {
    for (let i = 0; i < 20; i++) {
      const id = `h-${randomBytes(4).toString('hex')}`;
      if (!this.repo.get(id)) return id;
    }
    throw new HttpError(500, 'Could not generate a unique hero id');
  }

  // -------------------------------------------------------------- hand-authored CRUD (editor, §3.3)

  list(projectId?: string): Hero[] {
    return this.repo.list(projectId);
  }

  create(rawInput: HeroCreate): Hero {
    const input = HeroCreateSchema.parse(rawInput);
    if (!this.deps.projectsRepository.get(input.projectId)) throw notFound(`Project ${input.projectId}`);
    const cfg = this.deps.settings.get().heroes;
    const projectHeroes = this.repo.list(input.projectId);
    const roleHeroes = projectHeroes.filter((h) => h.role === input.role);
    if (roleHeroes.length >= cfg.maxPerRole) {
      throw new HttpError(409, `Cannot create hero: at most ${cfg.maxPerRole} heroes per role may be stored (heroes.maxPerRole)`);
    }
    if (projectHeroes.length >= cfg.maxPerProject) {
      throw new HttpError(409, `Cannot create hero: at most ${cfg.maxPerProject} heroes per project may be stored (heroes.maxPerProject)`);
    }
    const used = new Set(roleHeroes.map((h) => h.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const seed = heroSeed(input.projectId, input.role, slot);
    const name = input.name ?? pickHeroName(namePoolFor(cfg.namePools, input.role), projectHeroes.map((h) => h.name), seed, this.roleTitle(input.role));
    const appearance: HeroAppearance = { ...generateHeroAppearance(seed), ...(input.appearance ?? {}) };
    const now = Date.now();
    const hero: Hero = {
      id: this.freshId(),
      projectId: input.projectId,
      role: input.role,
      slot,
      name,
      title: input.title ?? null,
      appearance,
      customized: input.name !== undefined || input.title !== undefined || input.appearance !== undefined,
      boundAgentId: null,
      boundAt: null,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.upsert(hero);
    this.deps.bus.emit('hero.upserted', hero);
    return hero;
  }

  patch(id: string, rawPatch: HeroPatch): Hero {
    if (!HERO_ID_RE.test(id)) throw new HttpError(400, `Invalid hero id "${id}"`);
    const patch = HeroPatchSchema.parse(rawPatch);
    const existing = this.repo.get(id);
    if (!existing) throw notFound(`Hero ${id}`);
    if (patch.baseUpdatedAt !== undefined && existing.updatedAt !== patch.baseUpdatedAt) {
      throw new HttpError(409, `Hero "${id}" was changed since you loaded it`);
    }
    const updated: Hero = {
      ...existing,
      name: patch.name ?? existing.name,
      title: patch.title === undefined ? existing.title : patch.title,
      appearance: { ...existing.appearance, ...(patch.appearance ?? {}) },
      customized: true,
      updatedAt: Date.now(),
    };
    this.repo.upsert(updated);
    this.deps.bus.emit('hero.upserted', updated);
    return updated;
  }

  /** Regenerates the seeded name and appearance for this (project, role, slot), clearing `customized`. */
  reset(id: string): Hero {
    if (!HERO_ID_RE.test(id)) throw new HttpError(400, `Invalid hero id "${id}"`);
    const existing = this.repo.get(id);
    if (!existing) throw notFound(`Hero ${id}`);
    const seed = heroSeed(existing.projectId, existing.role, existing.slot);
    const taken = this.repo
      .list(existing.projectId)
      .filter((h) => h.id !== id)
      .map((h) => h.name);
    const cfg = this.deps.settings.get().heroes;
    const updated: Hero = {
      ...existing,
      name: pickHeroName(namePoolFor(cfg.namePools, existing.role), taken, seed, this.roleTitle(existing.role)),
      title: null,
      appearance: generateHeroAppearance(seed),
      customized: false,
      updatedAt: Date.now(),
    };
    this.repo.upsert(updated);
    this.deps.bus.emit('hero.upserted', updated);
    return updated;
  }

  delete(id: string): void {
    if (!HERO_ID_RE.test(id)) throw new HttpError(400, `Invalid hero id "${id}"`);
    const existing = this.repo.get(id);
    if (!existing) throw notFound(`Hero ${id}`);
    if (!isHeroReleased(existing)) throw new HttpError(409, `Hero "${id}" is bound to a live agent`);
    this.repo.delete(id);
    this.deps.bus.emit('hero.removed', { id, projectId: existing.projectId });
  }
}
