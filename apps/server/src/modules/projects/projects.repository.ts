import type { Project } from '@tagconn/shared';
import { desc, eq } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { type RootSource, schema } from '../../core/db/index.js';

const { projects, sessions } = schema;
type Row = typeof projects.$inferSelect;

/** `Project` plus how its cwd was established (service-internal, not public). */
export type ProjectRecord = Project & { rootSource: RootSource | null };

const toProject = ({ rootSource: _rootSource, ...r }: Row): Project => ({ ...r, layoutId: r.layoutId ?? undefined });
const toRecord = (r: Row): ProjectRecord => ({ ...toProject(r), rootSource: r.rootSource });

export class ProjectsRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  get(id: string): Project | undefined {
    const row = this.deps.db.select().from(projects).where(eq(projects.id, id)).get();
    return row && toProject(row);
  }

  /** Like `get`, plus the root source (service-internal). */
  getRecord(id: string): ProjectRecord | undefined {
    const row = this.deps.db.select().from(projects).where(eq(projects.id, id)).get();
    return row && toRecord(row);
  }

  listRecords(): ProjectRecord[] {
    return this.deps.db.select().from(projects).orderBy(desc(projects.lastActivityAt)).all().map(toRecord);
  }

  setRootSource(id: string, rootSource: RootSource): void {
    this.deps.db.update(projects).set({ rootSource }).where(eq(projects.id, id)).run();
  }

  list(): Project[] {
    return this.deps.db.select().from(projects).orderBy(desc(projects.lastActivityAt)).all().map(toProject);
  }

  /** `rootSource` only applies when the row is inserted; an update never changes it (see `setRootSource`). */
  upsert(p: Project, rootSource: RootSource | null = null): void {
    const layoutId = p.layoutId ?? null;
    this.deps.db
      .insert(projects)
      .values({ ...p, layoutId, rootSource })
      .onConflictDoUpdate({
        target: projects.id,
        set: { cwd: p.cwd, name: p.name, archived: p.archived, lastActivityAt: p.lastActivityAt, layoutId },
      })
      .run();
  }

  /** Project of an already known session (for payloads that lack `cwd`). */
  projectIdOfSession(sessionId: string): string | undefined {
    return this.deps.db.select({ id: sessions.projectId }).from(sessions).where(eq(sessions.id, sessionId)).get()?.id;
  }
}
