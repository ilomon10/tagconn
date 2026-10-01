import {
  emptyCore, progressView, type HeroProgress, type HeroProgressCore, type Settings, type UsageCounters,
} from '@tagconn/shared';
import { and, eq } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { StoredCoreSchema, StoredScalarsSchema } from './progression.schema.js';
import { usageMarks } from './progression.tables.js';

/** F14: stored JSON is parsed through zod into null-prototype records. */
export type CoreRead = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'ok'; core: HeroProgressCore };

interface ProgressRow {
  hero_id: string;
  class_id: string;
  xp: number;
  bonus_points: number;
  skills: string;
  ko_until: number | null;
  wins: number;
  losses: number;
  flees: number;
  loot: string;
  equipped_title: string | null;
  updated_at: number;
}
type JoinedRow = ProgressRow & { project_id: string; role: string };

export class ProgressionRepository {
  constructor(private readonly deps: Deps<'db' | 'sqlite' | 'logger'>) {}

  private parseRow(r: ProgressRow): HeroProgressCore | undefined {
    try {
      const scalars = StoredScalarsSchema.parse({
        classId: r.class_id, xp: r.xp, bonusPoints: r.bonus_points, koUntil: r.ko_until, wins: r.wins, losses: r.losses,
        flees: r.flees, equippedTitle: r.equipped_title, updatedAt: r.updated_at,
      });
      const json = StoredCoreSchema.parse({ skills: JSON.parse(r.skills), loot: JSON.parse(r.loot) });
      return { ...scalars, skills: json.skills, loot: json.loot };
    } catch (err) {
      this.deps.logger.warn({ heroId: r.hero_id, err: err instanceof Error ? err.message : String(err) }, 'corrupt stored hero progress');
      return undefined;
    }
  }

  /**
   * 'missing' = no row; 'corrupt' = a row whose JSON/zod parse fails (logged as a warning; the row is never overwritten).
   * Skill keys failing SKILL_ID_RE (e.g. a stored `__proto__`) are dropped on read, not treated as corrupt.
   */
  getCore(heroId: string): CoreRead {
    const row = this.deps.sqlite.prepare('SELECT * FROM hero_progress WHERE hero_id = ?').get(heroId) as ProgressRow | undefined;
    if (!row) return { kind: 'missing' };
    const core = this.parseRow(row);
    return core ? { kind: 'ok', core } : { kind: 'corrupt' };
  }

  /** Creates or updates the row; false (nothing inserted) when the hero no longer exists (F5). */
  upsertCore(heroId: string, core: HeroProgressCore): boolean {
    const r = this.deps.sqlite
      .prepare(
        `INSERT INTO hero_progress (hero_id, class_id, xp, bonus_points, skills, ko_until, wins, losses, flees, loot, equipped_title, updated_at)
         SELECT @heroId, @classId, @xp, @bonusPoints, @skills, @koUntil, @wins, @losses, @flees, @loot, @equippedTitle, @updatedAt
         WHERE EXISTS (SELECT 1 FROM heroes WHERE id = @heroId)
         ON CONFLICT(hero_id) DO UPDATE SET class_id = excluded.class_id, xp = excluded.xp, bonus_points = excluded.bonus_points,
           skills = excluded.skills, ko_until = excluded.ko_until, wins = excluded.wins, losses = excluded.losses, flees = excluded.flees,
           loot = excluded.loot, equipped_title = excluded.equipped_title, updated_at = excluded.updated_at`,
      )
      .run({
        heroId, classId: core.classId, xp: core.xp, bonusPoints: core.bonusPoints, skills: JSON.stringify(Object.fromEntries(Object.entries(core.skills))),
        koUntil: core.koUntil, wins: core.wins, losses: core.losses, flees: core.flees, loot: JSON.stringify(core.loot),
        equippedTitle: core.equippedTitle, updatedAt: core.updatedAt,
      });
    return r.changes > 0;
  }

  delete(heroId: string): boolean {
    return this.deps.sqlite.prepare('DELETE FROM hero_progress WHERE hero_id = ?').run(heroId).changes > 0;
  }

  /** Rows of heroes that no longer exist (merge-projects deletes with raw SQL and emits no event). */
  pruneOrphans(): number {
    return this.deps.sqlite.prepare('DELETE FROM hero_progress WHERE hero_id NOT IN (SELECT id FROM heroes)').run().changes;
  }

  private cfg(s: Settings) {
    const p = s.progression;
    return { curve: { levelBase: p.levelBase, levelExponent: p.levelExponent, maxLevel: p.maxLevel }, skillPointsPerLevel: p.skillPointsPerLevel };
  }

  /** JOIN heroes; heroes WITHOUT a row are not listed (the client shows level 1). Corrupt rows are skipped. */
  listViews(projectId: string | undefined, s: Settings): HeroProgress[] {
    const sql = `SELECT hp.*, h.project_id AS project_id, h.role AS role FROM hero_progress hp JOIN heroes h ON h.id = hp.hero_id`;
    const rows = (projectId
      ? this.deps.sqlite.prepare(`${sql} WHERE h.project_id = ?`).all(projectId)
      : this.deps.sqlite.prepare(sql).all()) as JoinedRow[];
    const out: HeroProgress[] = [];
    for (const r of rows) {
      const core = this.parseRow(r);
      if (core) out.push(progressView(r.hero_id, r.project_id, r.role, core, this.cfg(s)));
    }
    return out;
  }

  /**
   * The row's view, or the default (level 1) view when the hero exists without a row; undefined when the hero is
   * unknown. A corrupt row also yields undefined (callers needing the distinction use `getCore`).
   */
  view(heroId: string, s: Settings): HeroProgress | undefined {
    const hero = this.deps.sqlite.prepare('SELECT project_id, role FROM heroes WHERE id = ?').get(heroId) as { project_id: string; role: string } | undefined;
    if (!hero) return undefined;
    const read = this.getCore(heroId);
    if (read.kind === 'corrupt') return undefined;
    const core = read.kind === 'ok' ? read.core : emptyCore(hero.role, 0);
    return progressView(heroId, hero.project_id, hero.role, core, this.cfg(s));
  }

  getMark(sessionId: string, agentId: string): UsageCounters | undefined {
    const r = this.deps.db.select().from(usageMarks).where(and(eq(usageMarks.sessionId, sessionId), eq(usageMarks.agentId, agentId))).get();
    return r && { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheCreationTokens: r.cacheCreationTokens };
  }

  upsertMark(sessionId: string, agentId: string, m: UsageCounters, now: number): void {
    const values = {
      sessionId, agentId, inputTokens: m.inputTokens, outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens, cacheCreationTokens: m.cacheCreationTokens, updatedAt: now,
    };
    const { sessionId: _s, agentId: _a, ...set } = values;
    this.deps.db.insert(usageMarks).values(values).onConflictDoUpdate({ target: [usageMarks.sessionId, usageMarks.agentId], set }).run();
  }

  tx<T>(fn: () => T): T {
    return this.deps.sqlite.transaction(fn)();
  }

  /** BEGIN IMMEDIATE (F7). Used by battle create and resolve. */
  txImmediate<T>(fn: () => T): T {
    return this.deps.sqlite.transaction(fn).immediate();
  }
}
