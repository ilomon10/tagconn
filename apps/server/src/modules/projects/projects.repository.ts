import type { Project } from '@tagconn/shared';
import { desc, eq } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { schema } from '../../core/db/index.js';

const { projects, sessions } = schema;
type Row = typeof projects.$inferSelect;

const toProject = (r: Row): Project => ({ ...r, layoutId: r.layoutId ?? undefined });

export class ProjectsRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  get(id: string): Project | undefined {
    const row = this.deps.db.select().from(projects).where(eq(projects.id, id)).get();
    return row && toProject(row);
  }

  list(): Project[] {
    return this.deps.db.select().from(projects).orderBy(desc(projects.lastActivityAt)).all().map(toProject);
  }

  upsert(p: Project): void {
    const layoutId = p.layoutId ?? null;
    this.deps.db
      .insert(projects)
      .values({ ...p, layoutId })
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
