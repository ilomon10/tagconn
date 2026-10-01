import type { BattleNpcKind, BattleStatus } from '@tagconn/shared';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * M14 progression tables (migration slot 12; slot 13 adds hero_progress.skills_updated_at). Defined here (not in core/db/schema.ts) per the module
 * convention; keep the DDL in `core/db/migrations.ts` (slot 12) in sync. JSON columns are stored as text
 * and parsed through zod by the repositories, never trusted.
 */

/** One row per hero that ever earned anything. No project_id: listing joins `heroes`. */
export const heroProgress = sqliteTable('hero_progress', {
  heroId: text('hero_id').primaryKey(),
  classId: text('class_id').notNull(),
  xp: integer('xp').notNull().default(0),
  bonusPoints: integer('bonus_points').notNull().default(0),
  skills: text('skills').notNull(),
  koUntil: integer('ko_until'),
  wins: integer('wins').notNull().default(0),
  losses: integer('losses').notNull().default(0),
  flees: integer('flees').notNull().default(0),
  loot: text('loot').notNull(),
  equippedTitle: text('equipped_title'),
  updatedAt: integer('updated_at').notNull(),
  skillsUpdatedAt: integer('skills_updated_at').notNull().default(0), // migration 13
});

/** Component-wise high-water mark of cumulative token counters per (session, agent): the XP double-count guard. */
export const usageMarks = sqliteTable(
  'usage_marks',
  {
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheCreationTokens: integer('cache_creation_tokens').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.agentId] })],
);

export const battles = sqliteTable(
  'battles',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    status: text('status').$type<BattleStatus>().notNull(),
    npcKind: text('npc_kind').$type<BattleNpcKind>().notNull(),
    encounterId: text('encounter_id').notNull(),
    /** BattleSetup JSON; '{}' once housekeeping stripped it. */
    setup: text('setup').notNull(),
    /** Server-only uint32 for the loot roll; never in any response (F4). */
    lootSeed: integer('loot_seed').notNull(),
    partyHeroIds: text('party_hero_ids').notNull(),
    log: text('log'),
    logHash: text('log_hash'),
    outcome: text('outcome'),
    createdAt: integer('created_at').notNull(),
    /** Fixed at create (F9). */
    expiresAt: integer('expires_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [
    index('battles_project_status_idx').on(t.projectId, t.status),
    index('battles_created_idx').on(t.createdAt),
    index('battles_status_expires_idx').on(t.status, t.expiresAt),
  ],
);
