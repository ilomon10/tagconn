import { HeroSchema, type Hero } from '@tagconn/shared';
import { eq } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { schema } from '../../core/db/index.js';

const { heroes } = schema;
type Row = typeof heroes.$inferSelect;

export class HeroesRepository {
  constructor(private readonly deps: Deps<'db' | 'logger'>) {}

  /** Rows that fail `HeroSchema` (e.g. hand-edited DB, an old shape) are skipped, not thrown. */
  private toHero(row: Row): Hero | undefined {
    const parsed = HeroSchema.safeParse({
      id: row.id,
      projectId: row.projectId,
      role: row.role,
      slot: row.slot,
      name: row.name,
      title: row.title ?? null,
      appearance: row.appearance,
      customized: row.customized,
      boundAgentId: row.boundAgentId ?? null,
      boundAt: row.boundAt ?? null,
      releasedAt: row.releasedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    if (!parsed.success) {
      this.deps.logger.warn({ id: row.id, err: parsed.error.message }, 'skipping invalid stored hero');
      return undefined;
    }
    return parsed.data;
  }

  /** All heroes, optionally of one project. */
  list(projectId?: string): Hero[] {
    const rows = projectId ? this.deps.db.select().from(heroes).where(eq(heroes.projectId, projectId)).all() : this.deps.db.select().from(heroes).all();
    return rows.map((r) => this.toHero(r)).filter((h): h is Hero => h !== undefined);
  }

  get(id: string): Hero | undefined {
    const row = this.deps.db.select().from(heroes).where(eq(heroes.id, id)).get();
    return row && this.toHero(row);
  }

  upsert(hero: Hero): void {
    const values = {
      ...hero,
      title: hero.title ?? null,
      boundAgentId: hero.boundAgentId ?? null,
      boundAt: hero.boundAt ?? null,
      releasedAt: hero.releasedAt ?? null,
    };
    const { id, ...set } = values;
    this.deps.db.insert(heroes).values(values).onConflictDoUpdate({ target: heroes.id, set }).run();
  }

  delete(id: string): boolean {
    return this.deps.db.delete(heroes).where(eq(heroes.id, id)).run().changes > 0;
  }
}
