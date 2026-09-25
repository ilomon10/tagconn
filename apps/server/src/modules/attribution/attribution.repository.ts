import type { AttributionImportStatus, AttributionProfile, PendingProfileImport } from '@tagconn/shared';
import { eq } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { attributionImports } from './attribution.tables.js';

export interface AttributionRow {
  projectId: string;
  status: AttributionImportStatus & ('pending' | 'imported' | 'ignored');
  projectCwd: string;
  receivedAt: number;
  floorName: string;
  tagconnVersion: string;
  hasLayout: boolean;
  heroCount: number;
  unknownRoles: string[];
  profile: AttributionProfile;
  importedAt?: number;
  source?: 'hook' | 'manual';
}

type Row = typeof attributionImports.$inferSelect;

const toRow = (r: Row): AttributionRow => ({
  projectId: r.projectId,
  status: r.status,
  projectCwd: r.projectCwd,
  receivedAt: r.receivedAt,
  floorName: r.floorName,
  tagconnVersion: r.tagconnVersion,
  hasLayout: r.hasLayout,
  heroCount: r.heroCount,
  unknownRoles: r.unknownRoles,
  profile: r.profile,
  importedAt: r.importedAt ?? undefined,
  source: r.source ?? undefined,
});

export const toPending = (r: AttributionRow): PendingProfileImport => ({
  projectId: r.projectId,
  projectCwd: r.projectCwd,
  receivedAt: r.receivedAt,
  floorName: r.floorName,
  tagconnVersion: r.tagconnVersion,
  hasLayout: r.hasLayout,
  heroCount: r.heroCount,
  unknownRoles: r.unknownRoles,
});

/** DB access for `attribution_imports` (M8 8j, S4). Never imported outside this module. */
export class AttributionRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  get(projectId: string): AttributionRow | undefined {
    const row = this.deps.db.select().from(attributionImports).where(eq(attributionImports.projectId, projectId)).get();
    return row && toRow(row);
  }

  listPending(): AttributionRow[] {
    return this.deps.db
      .select()
      .from(attributionImports)
      .where(eq(attributionImports.status, 'pending'))
      .all()
      .map(toRow);
  }

  /** Records a new pending review, or refreshes an existing one with the latest hook POST. */
  upsertPending(row: Omit<AttributionRow, 'status' | 'importedAt' | 'source'>): void {
    const values = {
      projectId: row.projectId,
      status: 'pending' as const,
      projectCwd: row.projectCwd,
      receivedAt: row.receivedAt,
      floorName: row.floorName,
      tagconnVersion: row.tagconnVersion,
      hasLayout: row.hasLayout,
      heroCount: row.heroCount,
      unknownRoles: row.unknownRoles,
      profile: row.profile,
      importedAt: null,
      source: null,
    };
    const { projectId: _id, ...set } = values;
    this.deps.db.insert(attributionImports).values(values).onConflictDoUpdate({ target: attributionImports.projectId, set }).run();
  }

  /** Records an import applied straight from the hook (autoImport: 'auto'), skipping the pending phase. */
  recordAutoImported(row: Omit<AttributionRow, 'status' | 'importedAt' | 'source'>, importedAt: number): void {
    const values = {
      projectId: row.projectId,
      status: 'imported' as const,
      projectCwd: row.projectCwd,
      receivedAt: row.receivedAt,
      floorName: row.floorName,
      tagconnVersion: row.tagconnVersion,
      hasLayout: row.hasLayout,
      heroCount: row.heroCount,
      unknownRoles: row.unknownRoles,
      profile: row.profile,
      importedAt,
      source: 'hook' as const,
    };
    const { projectId: _id, ...set } = values;
    this.deps.db.insert(attributionImports).values(values).onConflictDoUpdate({ target: attributionImports.projectId, set }).run();
  }

  /** Admin resolved a pending review: 'imported' (source always 'manual', a human clicked import) or 'ignored'. */
  resolve(projectId: string, status: 'imported' | 'ignored', now: number): void {
    this.deps.db
      .update(attributionImports)
      .set(status === 'imported' ? { status, importedAt: now, source: 'manual' } : { status })
      .where(eq(attributionImports.projectId, projectId))
      .run();
  }
}
