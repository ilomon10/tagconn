import { LAYOUT_ID_RE, OfficeLayoutSchema, type OfficeLayout } from '@tagconn/shared';
import { asc, desc, eq } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { schema } from '../../core/db/index.js';

const { layouts } = schema;
type Row = typeof layouts.$inferSelect;

/** Everything the `data` JSON column holds (the rest are their own columns; see core/db/schema.ts). */
type LayoutData = Omit<OfficeLayout, 'id' | 'name' | 'builtin' | 'createdAt' | 'updatedAt'>;

export class LayoutsRepository {
  constructor(private readonly deps: Deps<'db' | 'logger'>) {}

  /** Rows that fail `OfficeLayoutSchema` (e.g. hand-edited DB, an old shape) are skipped, not thrown. */
  private toLayout(row: Row): OfficeLayout | undefined {
    const parsed = OfficeLayoutSchema.safeParse({
      ...(row.data as LayoutData),
      id: row.id,
      name: row.name,
      builtin: row.builtin,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    if (!parsed.success) {
      this.deps.logger.warn({ id: row.id, err: parsed.error.message }, 'skipping invalid stored layout');
      return undefined;
    }
    return parsed.data;
  }

  /** Builtins first, then alphabetically by name. */
  list(): OfficeLayout[] {
    return this.deps.db
      .select()
      .from(layouts)
      .orderBy(desc(layouts.builtin), asc(layouts.name))
      .all()
      .map((r) => this.toLayout(r))
      .filter((l): l is OfficeLayout => l !== undefined);
  }

  get(id: string): OfficeLayout | undefined {
    const row = this.deps.db.select().from(layouts).where(eq(layouts.id, id)).get();
    return row && this.toLayout(row);
  }

  upsert(layout: OfficeLayout): void {
    const { id, name, builtin, createdAt, updatedAt, ...data } = layout;
    this.deps.db
      .insert(layouts)
      .values({ id, name, data, builtin, createdAt, updatedAt })
      .onConflictDoUpdate({ target: layouts.id, set: { name, data, builtin, updatedAt } })
      .run();
  }

  delete(id: string): boolean {
    return this.deps.db.delete(layouts).where(eq(layouts.id, id)).run().changes > 0;
  }

  /** Number of stored layouts (builtins included), for enforcing `office.maxStoredLayouts`. */
  count(): number {
    return this.deps.db.select({ id: layouts.id }).from(layouts).all().length;
  }

  /**
   * Startup hygiene: a row whose id fails `LAYOUT_ID_RE` (e.g. written before the PUT route
   * validated its URL param) also fails `OfficeLayoutSchema` on read, so `toLayout` skips it
   * everywhere - it can never be listed, fetched or deleted through the API. Purge it instead.
   */
  purgeInvalidIds(): void {
    for (const row of this.deps.db.select({ id: layouts.id }).from(layouts).all()) {
      if (LAYOUT_ID_RE.test(row.id)) continue;
      this.deps.logger.warn({ id: row.id }, 'purging stored layout with an invalid id');
      this.deps.db.delete(layouts).where(eq(layouts.id, row.id)).run();
    }
  }
}
