import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Project, ProjectRootKind } from '@tagconn/shared';
import { backupBeforeMerge, isFoldTarget, mergeNestedInto, nearestFoldTarget, normPath, pendingMergeChildren } from '../../core/db/index.js';
import type { Deps } from '../../core/di/index.js';
import type { HookContext } from '../../core/event-bus/index.js';
import { HttpError, notFound } from '../../core/http/index.js';
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
  /** Git roots whose nested floors were already merged (or checked) in this process. */
  private readonly scanned = new Set<string>();
  private backedUp = false;

  constructor(private readonly deps: Deps<'projectsRepository' | 'layoutsRepository' | 'bus' | 'sqlite' | 'config' | 'settings' | 'logger'>) {}

  list(): Project[] {
    return this.deps.projectsRepository.list();
  }

  /**
   * Resolves (and creates/touches) the project for a hook; sets ctx.projectId. A session is pinned to
   * the project it first landed in, whatever cwd later events carry (the agent may `cd` into a
   * subdirectory). A new session's root is the hook's validated project-root header, else its cwd. An
   * equal (normalised) path is the same project; a root strictly inside a CONFIRMED git root (see
   * `isFoldTarget`) belongs to that nearest root, unless it is a git root itself. A git-kind header
   * confirms its project as a git root and merges the non-git floors nested in it.
   */
  onHook(ctx: HookContext): void {
    const repo = this.deps.projectsRepository;
    const pinned = repo.projectIdOfSession(ctx.sessionId);
    const root = ctx.projectRoot ?? ctx.payload.cwd;
    const kind: ProjectRootKind | undefined = ctx.projectRoot ? (ctx.projectRootKind ?? 'dir') : undefined;
    let id: string;
    let path = root ?? UNKNOWN_CWD;
    if (pinned) {
      id = pinned;
    } else {
      const rows = root ? repo.listRecords() : [];
      const same = root ? rows.find((r) => normPath(r.cwd) === normPath(root)) : undefined;
      const ancestor = root && !same && kind !== 'git' ? nearestFoldTarget(root, rows) : undefined;
      const found = same ?? ancestor;
      if (found) {
        id = found.id;
        path = found.cwd;
      } else {
        id = projectIdFor(path);
      }
    }
    ctx.projectId = id;

    const existing = repo.get(id);
    if (!existing) {
      const project: Project = { id, cwd: path, name: basename(path) || path, archived: false, createdAt: ctx.ts, lastActivityAt: ctx.ts };
      repo.upsert(project, root ? (kind ?? 'cwd') : null);
      this.deps.bus.emit('project.upserted', project);
    } else if (ctx.ts > existing.lastActivityAt) {
      const updated = { ...existing, lastActivityAt: ctx.ts };
      repo.upsert(updated);
      if (ctx.ts - existing.lastActivityAt >= ACTIVITY_BROADCAST_MS) this.deps.bus.emit('project.upserted', updated);
    }
    if (kind === 'git' && root) this.confirmGitRoot(ctx, root);
  }

  /** The project at exactly `root` becomes a confirmed git root; its nested non-git floors merge into it. */
  private confirmGitRoot(ctx: HookContext, root: string): void {
    const repo = this.deps.projectsRepository;
    const key = normPath(root);
    if (this.scanned.has(key)) return;
    const target = repo.listRecords().find((r) => normPath(r.cwd) === key);
    if (!target) return;
    if (target.rootSource !== 'git') {
      repo.setRootSource(target.id, 'git');
      this.deps.bus.emit('project.upserted', repo.get(target.id) ?? target);
    }
    if (!isFoldTarget({ ...target, rootSource: 'git' })) {
      if (!target.archived) this.scanned.add(key); // too shallow to absorb anything; archived may change
      return;
    }
    const children = pendingMergeChildren(this.deps.sqlite, target.id);
    if (children.length > 0 && !this.mergeNested(target.id)) return; // backup failed: retry on the next event
    this.scanned.add(key);
    // The session's pinned floor may have been one of the merged children.
    if (!repo.get(ctx.projectId)) ctx.projectId = target.id;
  }

  /** Backs up the DB once per process, then merges. False when the backup failed (nothing was merged). */
  private mergeNested(parentId: string): boolean {
    const { sqlite, config, settings, logger, bus, projectsRepository } = this.deps;
    if (!this.backedUp) {
      try {
        const file = backupBeforeMerge(sqlite, config.base.storage.dbPath);
        if (file) logger.info({ file }, 'project merge: database backed up');
        this.backedUp = true;
      } catch (err) {
        logger.warn({ err }, 'project merge skipped: could not back up the database first');
        return false;
      }
    }
    const { maxPerRole, maxPerProject } = settings.get().heroes;
    const res = mergeNestedInto(sqlite, parentId, { maxPerRole, maxPerProject });
    for (const p of res.pairs) logger.info({ child: p.child.name, childCwd: p.child.cwd, parent: p.parent.cwd }, 'project merge: folded into its git root');
    if (res.merged > 0) {
      for (const p of res.pairs) bus.emit('project.merged', { from: p.child.id, into: p.parent.id });
      const parent = projectsRepository.get(parentId);
      if (parent) bus.emit('project.upserted', parent);
    }
    return true;
  }

  update(id: string, patch: { name?: string; archived?: boolean; layoutId?: string | null }): Project {
    const existing = this.deps.projectsRepository.get(id);
    if (!existing) throw notFound(`Project ${id}`);
    if (patch.layoutId != null && !this.deps.layoutsRepository.get(patch.layoutId)) {
      throw new HttpError(400, `Unknown layout "${patch.layoutId}"`);
    }
    const updated: Project = {
      ...existing,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.archived !== undefined && { archived: patch.archived }),
      ...(patch.layoutId !== undefined && { layoutId: patch.layoutId ?? undefined }),
    };
    this.deps.projectsRepository.upsert(updated);
    this.deps.bus.emit('project.upserted', updated);
    return updated;
  }

  /** `layouts:assign` (socket): same rules as `PATCH /api/projects/:id { layoutId }`. */
  assignLayout(projectId: string, layoutId: string | null): Project {
    return this.update(projectId, { layoutId });
  }
}
