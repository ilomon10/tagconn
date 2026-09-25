import type { AttributionImportStatus, AttributionProfile } from '@tagconn/shared';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * M8 8j attribution table (S4, migration slot 9). Defined here (not in core/db/schema.ts) per
 * docs/design/runner-and-helpdesk.md §9: "Define new drizzle tables inside your module."
 * Keep the DDL in `core/db/migrations.ts` (slot 9) in sync with this shape.
 *
 * One row per project: doubles as the "pending admin review" store (status = 'pending') AND the
 * per-project history that makes a repeat hook POST for the same project a no-op ('imported' ->
 * `already-configured`, 'ignored' -> `dismissed-before`; see attribution.service.ts). The full
 * validated `profile` is kept so a later admin `resolve({action:'import'})` can apply it without the
 * hook needing to re-POST it.
 */
export const attributionImports = sqliteTable('attribution_imports', {
  projectId: text('project_id').primaryKey(),
  status: text('status').$type<AttributionImportStatus & ('pending' | 'imported' | 'ignored')>().notNull(),
  /** Host path of the repo the profile came from (shown in the admin toast). Never used to resolve the project. */
  projectCwd: text('project_cwd').notNull(),
  receivedAt: integer('received_at').notNull(),
  floorName: text('floor_name').notNull(),
  tagconnVersion: text('tagconn_version').notNull(),
  hasLayout: integer('has_layout', { mode: 'boolean' }).notNull(),
  heroCount: integer('hero_count').notNull(),
  /** Heroes that would be / were dropped because their role doesn't exist on this host. */
  unknownRoles: text('unknown_roles', { mode: 'json' }).notNull().$type<string[]>(),
  /** The full validated profile, so `resolve({action:'import'})` can apply it without a re-POST. */
  profile: text('profile', { mode: 'json' }).notNull().$type<AttributionProfile>(),
  importedAt: integer('imported_at'),
  source: text('source').$type<'hook' | 'manual' | null>(),
});
