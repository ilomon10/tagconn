import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Project } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import type { HookContext } from '../../core/event-bus/index.js';
import { notFound } from '../../core/http/index.js';
import type { ProjectsRepository } from './projects.repository.js';

/** Don't re-broadcast a project just because lastActivityAt moved by less than this. */
const ACTIVITY_BROADCAST_MS = 5_000;
const UNKNOWN_CWD = '(unknown)';

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';

/** Stable floor id for a working directory: slug(basename(cwd)) + '-' + sha1(cwd)[0..6]. */
export const projectIdFor = (cwd: string) =>
  `${slugify(basename(cwd))}-${createHash('sha1').update(cwd).digest('hex').slice(0, 6)}`;

export class ProjectsService {
  constructor(private readonly deps: Deps<'projectsRepository' | 'bus'>) {}

  list(): Project[] {
    return this.deps.projectsRepository.list();
  }

  /** Resolves (and creates/touches) the project for a hook; sets ctx.projectId. */
  onHook(ctx: HookContext): void {
    const repo = this.deps.projectsRepository;
    const cwd = ctx.payload.cwd;
    const id = cwd ? projectIdFor(cwd) : (repo.projectIdOfSession(ctx.sessionId) ?? projectIdFor(UNKNOWN_CWD));
    ctx.projectId = id;

    const existing = repo.get(id);
    if (!existing) {
      const path = cwd ?? UNKNOWN_CWD;
      const project: Project = { id, cwd: path, name: basename(path) || path, archived: false, createdAt: ctx.ts, lastActivityAt: ctx.ts };
      repo.upsert(project);
      this.deps.bus.emit('project.upserted', project);
      return;
    }
    if (ctx.ts <= existing.lastActivityAt) return;
    const updated = { ...existing, lastActivityAt: ctx.ts };
    repo.upsert(updated);
    if (ctx.ts - existing.lastActivityAt >= ACTIVITY_BROADCAST_MS) this.deps.bus.emit('project.upserted', updated);
  }

  update(id: string, patch: { name?: string; archived?: boolean }): Project {
    const existing = this.deps.projectsRepository.get(id);
    if (!existing) throw notFound(`Project ${id}`);
    const updated: Project = { ...existing, ...(patch.name !== undefined && { name: patch.name }), ...(patch.archived !== undefined && { archived: patch.archived }) };
    this.deps.projectsRepository.upsert(updated);
    this.deps.bus.emit('project.upserted', updated);
    return updated;
  }
}
