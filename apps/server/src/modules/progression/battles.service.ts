import { createHash, randomBytes } from 'node:crypto';
import {
  ENGINE_VERSION, PROGRESSION_LIMITS, buildBattleSetup, computeOutcome, emptyCore, isHeroReleased, isKnockedOut, replay, xpFromUsage,
  type BattleCreate, type BattleOutcome, type BattleResolve, type BattleStart, type BattleStatus, type HeroProgressCore,
  type PartyMemberInput, type PartyRef, type PlayerAction,
} from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import { BattleIdCollisionError, type BattleRow } from './battles.repository.js';
import { RESOLVED_KEEP_MS, SlidingWindowLimiter, WRITE_LIMIT } from './progression.schema.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

const sha256 = (log: readonly PlayerAction[]): string => createHash('sha256').update(JSON.stringify(log)).digest('hex');

type BattlesDeps = Deps<'battlesRepository' | 'progressionRepository' | 'projectsRepository' | 'heroesRepository' | 'agentsRepository' | 'bus' | 'settings' | 'logger'>;

/** What the transaction of `resolve` hands back: the fresh outcome, or "someone else got there first". */
type Resolved = { kind: 'done'; outcome: BattleOutcome; heroIds: string[] } | { kind: 'lost' };

/** M14 battles: create (server-built setup), resolve (server replay, exactly-once awards), abandon, get. docs/design/battles.md 2.5. */
export class BattlesService {
  private timer: NodeJS.Timeout | undefined;
  private readonly createLimiter: SlidingWindowLimiter;
  private readonly writeLimiter = new SlidingWindowLimiter(() => WRITE_LIMIT.max, WRITE_LIMIT.windowMs);
  /** Indirection so tests can spy on the replay call. */
  private readonly engine = { replay };

  constructor(private readonly deps: BattlesDeps) {
    this.createLimiter = new SlidingWindowLimiter(() => this.deps.settings.get().battle.maxPerHour, HOUR_MS);
  }

  /** Housekeeping at boot and then hourly; `stop()` clears the timer. */
  start(): void {
    this.housekeep();
    this.timer = setInterval(() => this.housekeep(), HOUR_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** expire → strip → prune by age → cap (F1, F9). Never throws. */
  housekeep(now = Date.now()): void {
    const repo = this.deps.battlesRepository;
    try {
      repo.expireOpenBefore(now);
      repo.stripBefore(now - RESOLVED_KEEP_MS);
      repo.prune(now - this.deps.settings.get().battle.retentionDays * DAY_MS);
      repo.pruneExcess(PROGRESSION_LIMITS.maxStoredBattles);
    } catch (err) {
      this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'battle housekeeping failed');
    }
  }

  private newId(): string {
    return `b-${randomBytes(6).toString('hex')}`;
  }

  private toStart(row: BattleRow): BattleStart {
    if (!row.setup) throw new HttpError(410, 'battle details expired');
    return {
      id: row.id, projectId: row.projectId, npcKind: row.npcKind, encounterId: row.encounterId, status: row.status, setup: row.setup,
      createdAt: row.createdAt, expiresAt: row.expiresAt,
    };
  }

  create(body: BattleCreate, now = Date.now()): BattleStart {
    const s = this.deps.settings.get();
    if (!s.battle.enabled || !s.progression.enabled) throw new HttpError(409, 'Battles are disabled (battle.enabled)');
    if (!this.createLimiter.check(now)) throw new HttpError(429, 'Too many battles started; try again later');
    if (!this.deps.projectsRepository.get(body.projectId)) throw notFound('Project');
    if (body.party.length > s.battle.maxParty) throw new HttpError(400, `A party has at most ${s.battle.maxParty} members`);

    const row = this.deps.progressionRepository.txImmediate(() => {
      const members: PartyMemberInput[] = [];
      const heroIds: string[] = [];
      const seen = new Set<string>();
      for (const ref of body.party) {
        const key = ref.kind === 'hero' ? `h:${ref.heroId}` : `a:${ref.agentId}`;
        if (seen.has(key)) throw new HttpError(400, 'Duplicate party member');
        seen.add(key);
        members.push(ref.kind === 'hero' ? this.heroMember(ref, body.projectId, now) : this.agentMember(ref, body.projectId));
        if (ref.kind === 'hero') heroIds.push(ref.heroId);
      }

      const repo = this.deps.battlesRepository;
      repo.abandonOpen(body.projectId, now);
      repo.abandonOpenWithHeroes(heroIds, now);

      const setup = buildBattleSetup({
        seed: randomBytes(4).readUInt32LE(0),
        npcKind: body.npcKind,
        party: members,
        curve: { levelBase: s.progression.levelBase, levelExponent: s.progression.levelExponent, maxLevel: s.progression.maxLevel },
        difficulty: s.battle.difficulty,
        items: s.battle.items,
        maxTurns: s.battle.maxTurns,
      });
      const base: Omit<BattleRow, 'id'> = {
        projectId: body.projectId, status: 'open', npcKind: body.npcKind, encounterId: body.encounterId, setup,
        lootSeed: randomBytes(4).readUInt32LE(0), partyHeroIds: heroIds, log: null, logHash: null, outcome: null,
        createdAt: now, expiresAt: now + s.battle.openTtlMin * 60_000, resolvedAt: null,
      };
      for (let attempt = 0; ; attempt++) {
        const candidate: BattleRow = { id: this.newId(), ...base };
        try {
          repo.insert(candidate);
          return candidate;
        } catch (err) {
          if (!(err instanceof BattleIdCollisionError)) throw err;
          if (attempt >= 1) throw new HttpError(500, 'could not allocate a battle id');
        }
      }
    });

    this.createLimiter.record(now);
    return this.toStart(row);
  }

  private heroMember(ref: Extract<PartyRef, { kind: 'hero' }>, projectId: string, now: number): PartyMemberInput {
    const hero = this.deps.heroesRepository.get(ref.heroId);
    if (!hero) throw notFound('Hero');
    if (hero.projectId !== projectId) throw new HttpError(400, 'Hero is on another floor');
    const read = this.deps.progressionRepository.getCore(hero.id);
    if (read.kind === 'corrupt') throw new HttpError(409, 'progress row is corrupt');
    const core = read.kind === 'ok' ? read.core : emptyCore(hero.role, now);
    if (isKnockedOut(core, now)) throw new HttpError(409, 'Hero is knocked out', { heroId: hero.id, koUntil: core.koUntil });
    return { ref, name: hero.name, role: hero.role, xp: core.xp, skills: core.skills, temporary: false };
  }

  private agentMember(ref: Extract<PartyRef, { kind: 'agent' }>, projectId: string): PartyMemberInput {
    const s = this.deps.settings.get();
    if (!s.progression.anonymousInBattle) throw new HttpError(400, 'Anonymous agents cannot join battles (progression.anonymousInBattle)');
    const agent = this.deps.agentsRepository.get(ref.agentId);
    if (!agent || agent.removed) throw notFound('Agent');
    if (agent.projectId !== projectId) throw new HttpError(400, 'Agent is on another floor');
    const bound = this.deps.heroesRepository.list(agent.projectId).some((h) => h.boundAgentId === agent.id && !isHeroReleased(h));
    if (bound) throw new HttpError(400, 'This agent has a hero; send the hero instead');
    return {
      ref, name: agent.role, role: agent.role, xp: xpFromUsage(agent.usage ?? ZERO_USAGE, s.progression.xpWeights), skills: Object.create(null) as HeroProgressCore['skills'],
      temporary: true,
    };
  }

  /** Answers a repeat/late resolve from a non-open row: same log → the stored outcome, otherwise 409; abandoned/expired → 410. */
  private terminalAnswer(row: BattleRow, logHash: string): BattleOutcome {
    if (row.status === 'resolved') {
      if (row.outcome && row.logHash === logHash) return row.outcome;
      throw new HttpError(409, 'Battle already resolved with another log');
    }
    if (row.status === 'abandoned' || row.status === 'expired') throw new HttpError(410, `Battle ${row.status}`);
    throw new HttpError(409, 'Battle state changed; try again');
  }

  resolve(id: string, body: BattleResolve, now = Date.now()): BattleOutcome {
    if (!this.writeLimiter.take(now)) throw new HttpError(429, 'Too many requests; try again later');
    const repo = this.deps.battlesRepository;
    const row = repo.get(id);
    if (!row) throw notFound('Battle');
    const logHash = sha256(body.log);
    if (row.status !== 'open') return this.terminalAnswer(row, logHash);
    if (now > row.expiresAt) {
      repo.transition(id, 'open', 'expired', {});
      throw new HttpError(410, 'Battle expired');
    }
    if (!row.setup) throw new HttpError(410, 'battle details expired');
    if (row.setup.engineVersion !== ENGINE_VERSION) {
      repo.transition(id, 'open', 'abandoned', {});
      throw new HttpError(409, 'engine version changed');
    }

    const setup = row.setup;
    const r = this.engine.replay(setup, body.log);
    if (!r.ok) throw new HttpError(400, 'Invalid battle log', { error: r.error, at: r.at });
    if (r.result === null) throw new HttpError(400, 'Battle not finished');
    const { result, turns, state } = r;
    if (body.expect && (body.expect.result !== result || body.expect.turns !== turns)) {
      throw new HttpError(409, 'Battle desync', { result, turns });
    }

    const s = this.deps.settings.get();
    const done = this.deps.progressionRepository.txImmediate((): Resolved => {
      const heroes: { heroId: string; memberIndex: number; core: HeroProgressCore }[] = [];
      setup.party.forEach((m, memberIndex) => {
        if (m.ref.kind !== 'hero') return;
        const heroId = m.ref.heroId;
        const hero = this.deps.heroesRepository.get(heroId);
        if (!hero) return;
        const read = this.deps.progressionRepository.getCore(heroId);
        if (read.kind === 'corrupt') {
          this.deps.logger.warn({ heroId, battleId: id }, 'corrupt progress row; no battle award');
          return;
        }
        heroes.push({ heroId, memberIndex, core: read.kind === 'ok' ? read.core : emptyCore(hero.role, now) });
      });
      const out = computeOutcome({
        setup, final: state, result, turns, lootSeed: row.lootSeed, heroes, now,
        cfg: {
          curve: { levelBase: s.progression.levelBase, levelExponent: s.progression.levelExponent, maxLevel: s.progression.maxLevel },
          skillPointsPerLevel: s.progression.skillPointsPerLevel, xpScale: s.battle.xpScale, koMinutes: s.battle.koMinutes,
          skillPointEveryWins: s.battle.skillPointEveryWins, lootChance: s.battle.lootChance,
        },
      });
      const outcome: BattleOutcome = { battleId: id, result, turns, heroes: out.awards, loot: out.loot, resolvedAt: now };
      if (!repo.transition(id, 'open', 'resolved', { log: [...body.log], logHash, outcome, resolvedAt: now })) return { kind: 'lost' };
      const written: string[] = [];
      for (const [heroId, core] of Object.entries(out.next)) {
        if (this.deps.progressionRepository.upsertCore(heroId, core)) written.push(heroId);
        else this.deps.logger.warn({ heroId, battleId: id }, 'hero vanished mid-resolve; no award stored');
      }
      return { kind: 'done', outcome, heroIds: written };
    });

    if (done.kind === 'lost') {
      // Lost a race: re-read ONCE and answer from the stored row. Never replay again.
      const again = repo.get(id);
      if (!again) throw notFound('Battle');
      return this.terminalAnswer(again, logHash);
    }
    for (const heroId of done.heroIds) {
      const view = this.deps.progressionRepository.view(heroId, s);
      if (view) this.deps.bus.emit('progress.upserted', view);
    }
    return done.outcome;
  }

  abandon(id: string, now = Date.now()): { status: BattleStatus } {
    if (!this.writeLimiter.take(now)) throw new HttpError(429, 'Too many requests; try again later');
    const repo = this.deps.battlesRepository;
    const row = repo.get(id);
    if (!row) throw notFound('Battle');
    if (row.status === 'resolved') throw new HttpError(409, 'Battle already resolved');
    if (row.status !== 'open') return { status: row.status };
    if (repo.transition(id, 'open', 'abandoned', {})) return { status: 'abandoned' };
    const again = repo.get(id);
    if (!again) throw notFound('Battle');
    if (again.status === 'resolved') throw new HttpError(409, 'Battle already resolved');
    return { status: again.status };
  }

  get(id: string): BattleStart & { outcome: BattleOutcome | null } {
    const row = this.deps.battlesRepository.get(id);
    if (!row) throw notFound('Battle');
    return { ...this.toStart(row), outcome: row.outcome };
  }
}
