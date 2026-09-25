import type { Role } from '@tagconn/shared';
import { asc, eq } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { schema } from '../../core/db/index.js';

const { roles, meta } = schema;
type Row = typeof roles.$inferSelect;

const toRole = ({ updatedAt: _u, ...r }: Row): Role => ({
  ...r,
  model: r.model as Role['model'],
  zone: r.zone as Role['zone'],
  tools: r.tools ?? null,
});

export class RolesRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  list(): Role[] {
    return this.deps.db.select().from(roles).orderBy(asc(roles.name)).all().map(toRole);
  }

  get(name: string): Role | undefined {
    const row = this.deps.db.select().from(roles).where(eq(roles.name, name)).get();
    return row && toRole(row);
  }

  upsert(role: Role, now = Date.now()): void {
    const { name: _n, ...set } = { ...role, updatedAt: now };
    this.deps.db.insert(roles).values({ ...role, updatedAt: now }).onConflictDoUpdate({ target: roles.name, set }).run();
  }

  insertIfMissing(role: Role, now = Date.now()): void {
    this.deps.db.insert(roles).values({ ...role, updatedAt: now }).onConflictDoNothing().run();
  }

  delete(name: string): boolean {
    return this.deps.db.delete(roles).where(eq(roles.name, name)).run().changes > 0;
  }

  getMeta(key: string): string | undefined {
    return this.deps.db.select().from(meta).where(eq(meta.key, key)).get()?.value;
  }

  setMeta(key: string, value: string): void {
    this.deps.db.insert(meta).values({ key, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();
  }
}
