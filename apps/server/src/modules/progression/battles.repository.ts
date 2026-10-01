import { PlayerActionSchema, type BattleNpcKind, type BattleOutcome, type BattleSetup, type BattleStatus, type PlayerAction } from '@tagconn/shared';
import { z } from 'zod';
import { HttpError } from '../../core/http/errors.js';
import type { Deps } from '../../core/di/index.js';
import { MAX_SETUP_BYTES } from './progression.schema.js';

/** `setup` is null on a stripped row (stored '{}'); `log` is null when absent or stripped. */
export interface BattleRow {
  id: string;
  projectId: string;
  status: BattleStatus;
  npcKind: BattleNpcKind;
  encounterId: string;
  setup: BattleSetup | null;
  lootSeed: number;
  partyHeroIds: string[];
  log: PlayerAction[] | null;
  logHash: string | null;
  outcome: BattleOutcome | null;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

/** Thrown by `insert` on a PRIMARY KEY conflict; the service retries once with a new id. */
export class BattleIdCollisionError extends Error {
  constructor(readonly id: string) {
    super('id-collision');
    this.name = 'id-collision';
  }
}

interface DbRow {
  id: string;
  project_id: string;
  status: BattleStatus;
  npc_kind: BattleNpcKind;
  encounter_id: string;
  setup: string;
  loot_seed: number;
  party_hero_ids: string;
  log: string | null;
  log_hash: string | null;
  outcome: string | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
}

const LogSchema = z.array(PlayerActionSchema);
const STRIPPED = '{}';

export class BattlesRepository {
  constructor(private readonly deps: Deps<'sqlite' | 'logger'>) {}

  private parseJson(id: string, what: string, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      this.deps.logger.warn({ id }, `corrupt stored battle ${what}`);
      return undefined;
    }
  }

  private toRow(r: DbRow): BattleRow {
    const setup = r.setup === STRIPPED ? undefined : this.parseJson(r.id, 'setup', r.setup);
    const log = r.log === null ? undefined : LogSchema.safeParse(this.parseJson(r.id, 'log', r.log));
    const party = this.parseJson(r.id, 'party', r.party_hero_ids);
    return {
      id: r.id,
      projectId: r.project_id,
      status: r.status,
      npcKind: r.npc_kind,
      encounterId: r.encounter_id,
      setup: setup && typeof setup === 'object' ? (setup as BattleSetup) : null,
      lootSeed: r.loot_seed,
      partyHeroIds: Array.isArray(party) ? party.filter((x): x is string => typeof x === 'string') : [],
      log: log?.success ? log.data : null,
      logHash: r.log_hash,
      outcome: r.outcome === null ? null : ((this.parseJson(r.id, 'outcome', r.outcome) as BattleOutcome | undefined) ?? null),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      resolvedAt: r.resolved_at,
    };
  }

  /**
   * Throws HttpError(500) (and logs) when the serialized setup exceeds MAX_SETUP_BYTES (32 KiB); throws a
   * distinguishable BattleIdCollisionError on a PRIMARY KEY conflict.
   */
  insert(row: BattleRow): void {
    const setup = JSON.stringify(row.setup ?? {});
    if (Buffer.byteLength(setup) > MAX_SETUP_BYTES) {
      this.deps.logger.error({ id: row.id, bytes: Buffer.byteLength(setup) }, 'battle setup exceeds the storage limit');
      throw new HttpError(500, 'battle setup too large');
    }
    try {
      this.deps.sqlite
        .prepare(
          `INSERT INTO battles (id, project_id, status, npc_kind, encounter_id, setup, loot_seed, party_hero_ids, log, log_hash, outcome, created_at, expires_at, resolved_at)
           VALUES (@id, @projectId, @status, @npcKind, @encounterId, @setup, @lootSeed, @party, @log, @logHash, @outcome, @createdAt, @expiresAt, @resolvedAt)`,
        )
        .run({
          id: row.id, projectId: row.projectId, status: row.status, npcKind: row.npcKind, encounterId: row.encounterId, setup,
          lootSeed: row.lootSeed, party: JSON.stringify(row.partyHeroIds), log: row.log ? JSON.stringify(row.log) : null,
          logHash: row.logHash, outcome: row.outcome ? JSON.stringify(row.outcome) : null, createdAt: row.createdAt,
          expiresAt: row.expiresAt, resolvedAt: row.resolvedAt,
        });
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') throw new BattleIdCollisionError(row.id);
      throw err;
    }
  }

  get(id: string): BattleRow | undefined {
    const r = this.deps.sqlite.prepare('SELECT * FROM battles WHERE id = ?').get(id) as DbRow | undefined;
    return r && this.toRow(r);
  }

  /** UPDATE ... SET status = to, <patch> WHERE id = ? AND status = from; true when exactly one row changed. */
  transition(id: string, from: BattleStatus, to: BattleStatus, patch: Partial<Pick<BattleRow, 'log' | 'logHash' | 'outcome' | 'resolvedAt'>> = {}): boolean {
    const sets = ['status = @to'];
    const params: Record<string, unknown> = { id, from, to };
    if (patch.log !== undefined) (sets.push('log = @log'), (params.log = patch.log && JSON.stringify(patch.log)));
    if (patch.logHash !== undefined) (sets.push('log_hash = @logHash'), (params.logHash = patch.logHash));
    if (patch.outcome !== undefined) (sets.push('outcome = @outcome'), (params.outcome = patch.outcome && JSON.stringify(patch.outcome)));
    if (patch.resolvedAt !== undefined) (sets.push('resolved_at = @resolvedAt'), (params.resolvedAt = patch.resolvedAt));
    return this.deps.sqlite.prepare(`UPDATE battles SET ${sets.join(', ')} WHERE id = @id AND status = @from`).run(params).changes === 1;
  }

  /** Open battles of this floor become abandoned. */
  abandonOpen(projectId: string, _now: number): number {
    return this.deps.sqlite.prepare(`UPDATE battles SET status = 'abandoned' WHERE project_id = ? AND status = 'open'`).run(projectId).changes;
  }

  /** Open battles (any floor) whose party contains any of these heroes become abandoned (F6). */
  abandonOpenWithHeroes(heroIds: readonly string[], _now: number): number {
    if (heroIds.length === 0) return 0;
    return this.deps.sqlite
      .prepare(
        `UPDATE battles SET status = 'abandoned' WHERE status = 'open'
         AND EXISTS (SELECT 1 FROM json_each(party_hero_ids) WHERE value IN (SELECT value FROM json_each(?)))`,
      )
      .run(JSON.stringify(heroIds)).changes;
  }

  /** Open battles past their stored `expires_at` become expired (F9). */
  expireOpenBefore(now: number): number {
    return this.deps.sqlite.prepare(`UPDATE battles SET status = 'expired' WHERE status = 'open' AND expires_at < ?`).run(now).changes;
  }

  /** Non-open rows created before ts lose setup and log; outcome and log_hash are kept (F1). */
  stripBefore(ts: number): number {
    return this.deps.sqlite
      .prepare(`UPDATE battles SET setup = '{}', log = NULL WHERE status != 'open' AND created_at < ? AND (setup != '{}' OR log IS NOT NULL)`)
      .run(ts).changes;
  }

  /** Deletes non-open rows created before ts. */
  prune(beforeTs: number): number {
    return this.deps.sqlite.prepare(`DELETE FROM battles WHERE status != 'open' AND created_at < ?`).run(beforeTs).changes;
  }

  /** Deletes non-open rows beyond the newest `keep` by created_at; returns the count (F1). */
  pruneExcess(keep: number): number {
    return this.deps.sqlite
      .prepare(`DELETE FROM battles WHERE status != 'open' AND id NOT IN (SELECT id FROM battles WHERE status != 'open' ORDER BY created_at DESC, id DESC LIMIT ?)`)
      .run(Math.max(0, keep)).changes;
  }
}
