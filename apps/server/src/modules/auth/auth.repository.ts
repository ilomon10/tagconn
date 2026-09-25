import { asc, desc, eq, lt } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { adminSessions } from './auth.tables.js';

export type AdminSessionRow = typeof adminSessions.$inferSelect;

export interface NewAdminSession {
  id: string;
  tokenHash: string;
  label?: string;
  userAgent?: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

export class AuthRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  insert(row: NewAdminSession): void {
    this.deps.db.insert(adminSessions).values(row).run();
  }

  findByHash(tokenHash: string): AdminSessionRow | undefined {
    return this.deps.db.select().from(adminSessions).where(eq(adminSessions.tokenHash, tokenHash)).get();
  }

  /** Slides the idle/max-age expiry and bumps `lastUsedAt` on every successful verify. */
  touch(id: string, lastUsedAt: number, expiresAt: number): void {
    this.deps.db.update(adminSessions).set({ lastUsedAt, expiresAt }).where(eq(adminSessions.id, id)).run();
  }

  deleteById(id: string): boolean {
    return this.deps.db.delete(adminSessions).where(eq(adminSessions.id, id)).run().changes > 0;
  }

  deleteAll(): void {
    this.deps.db.delete(adminSessions).run();
  }

  /** Opportunistic cleanup: called from `verify` when a looked-up row turns out to be expired. */
  deleteExpired(now: number): void {
    this.deps.db.delete(adminSessions).where(lt(adminSessions.expiresAt, now)).run();
  }

  /** Newest-used first (for the sessions list; `current` is computed by the caller). */
  listByLastUsedDesc(): AdminSessionRow[] {
    return this.deps.db.select().from(adminSessions).orderBy(desc(adminSessions.lastUsedAt)).all();
  }

  countActive(now: number): number {
    return this.deps.db
      .select()
      .from(adminSessions)
      .all()
      .filter((r) => r.expiresAt > now).length;
  }

  /** Deletes the oldest-used rows until at most `maxSessions - 1` remain (room for the one about to be inserted). */
  enforceMaxSessions(maxSessions: number): void {
    const rows = this.deps.db.select().from(adminSessions).orderBy(asc(adminSessions.lastUsedAt)).all();
    const overBy = rows.length - (maxSessions - 1);
    if (overBy <= 0) return;
    for (const row of rows.slice(0, overBy)) this.deleteById(row.id);
  }
}
