import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// M8 8m migration slot 5 (core/db/migrations.ts). Owned by this module, not core/db/schema.ts, per
// the migrations.ts comment: "Define new drizzle tables inside your module."

/**
 * Admin sessions (docs/design/runner-and-helpdesk.md §5.2). The raw `tca_...` token is never
 * persisted, only its sha256 hex digest, so a DB leak alone can't be used to authenticate. Sliding
 * (idle) expiry capped by an absolute max age; both are recomputed on every `touch`.
 */
export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    label: text('label'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('admin_sessions_expires_idx').on(t.expiresAt)],
);
