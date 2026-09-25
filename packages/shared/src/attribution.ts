import { z } from 'zod';
import { OFFICE_STYLES, OfficeLayoutInputSchema } from './layout.js';
import type { Ack } from './socket.js';

/**
 * M8 tagconn attribution in projects (8j). A small `.tagconn/` marker inside project repos:
 *   .tagconn/README.md   what tagconn is + how to restore (written by the hook, only if absent)
 *   .tagconn/office.json optional portable office profile (written only on an explicit save)
 * Repo content is UNTRUSTED input (a cloned repo can contain anything), so the profile is strictly
 * validated, size-capped and imported only with consent by default (settings.attribution.autoImport).
 * See docs/design/runner-and-helpdesk.md ("Attribution").
 */

export const ATTRIBUTION_DIR = '.tagconn';
export const ATTRIBUTION_README = 'README.md';
export const ATTRIBUTION_PROFILE = 'office.json';
export const ATTRIBUTION_PROFILE_KIND = 'tagconn.office-profile';
export const ATTRIBUTION_PROFILE_VERSION = 1;
/** Hard ceiling; settings.attribution.maxProfileBytes may only lower it. */
export const ATTRIBUTION_MAX_PROFILE_BYTES = 65_536;
/** Header the hook sends with a profile import (value validated as a Claude session id). */
export const ATTRIBUTION_SESSION_HEADER = 'x-tagconn-session-id';

/**
 * Rejects strings that look like host-specific absolute paths, so a profile never leaks or depends on
 * one machine's layout (e.g. "/home/alice/...", "C:\\Users\\...", "~/..."), and never contains secrets
 * we can recognise cheaply. The server additionally runs its redaction patterns and rejects on a hit.
 */
const HOST_PATH_RE = /^(\/(home|Users|root|mnt|media|var|opt|srv|tmp|etc|private)\/|~\/|[A-Za-z]:[\\/]|\\\\)/;
export const looksLikeHostPath = (s: string): boolean => HOST_PATH_RE.test(s.trim());

const collectStrings = (v: unknown, out: string[], depth = 0): void => {
  if (depth > 12) return;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
};

/** Portable hero entry. Mapped onto the heroes module (8i) on import; unknown look keys are dropped there. */
export const HeroProfileSchema = z.strictObject({
  role: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(40),
  title: z.string().trim().max(60).optional(),
  look: z
    .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/), z.union([z.string().max(64), z.number(), z.boolean()]))
    .refine((r) => Object.keys(r).length <= 32, 'too many look keys')
    .optional(),
});
export type HeroProfile = z.infer<typeof HeroProfileSchema>;

/** Layout as stored in a profile: the M7 input shape without server/optimistic-concurrency fields. */
export const ProfileLayoutSchema = OfficeLayoutInputSchema.omit({ baseUpdatedAt: true, id: true });

export const AttributionProfileSchema = z
  .strictObject({
    kind: z.literal(ATTRIBUTION_PROFILE_KIND),
    version: z.literal(ATTRIBUTION_PROFILE_VERSION),
    /** tagconn version that saved it, e.g. "0.3.0". */
    tagconnVersion: z.string().regex(/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]{1,20})?$/),
    /** ISO-8601 timestamp. */
    savedAt: z.string().max(40),
    floor: z.strictObject({
      name: z.string().trim().min(1).max(80),
      style: z.enum(OFFICE_STYLES).optional(),
    }),
    layout: ProfileLayoutSchema.optional(),
    heroes: z.array(HeroProfileSchema).max(64).default([]),
    notes: z.string().max(2_000).optional(),
  })
  .superRefine((p, ctx) => {
    const strings: string[] = [];
    collectStrings(p, strings);
    for (const s of strings) {
      if (looksLikeHostPath(s)) {
        ctx.addIssue({ code: 'custom', message: 'profile must not contain absolute host paths' });
        return;
      }
    }
  });
export type AttributionProfile = z.infer<typeof AttributionProfileSchema>;
export type AttributionProfileInput = z.input<typeof AttributionProfileSchema>;

/** Stored on the project after a successful import (domain patch: Project.profile). */
export interface ProjectProfileMeta {
  importedAt: number;
  tagconnVersion: string;
  source: 'hook' | 'manual';
}

export const ATTRIBUTION_IMPORT_STATUSES = ['imported', 'pending', 'ignored', 'rejected'] as const;
export type AttributionImportStatus = (typeof ATTRIBUTION_IMPORT_STATUSES)[number];

/** Reply of POST /api/attribution/import (hook token). The hook discards it; tests assert on it. */
export interface AttributionImportResult {
  status: AttributionImportStatus;
  /** e.g. "disabled", "already-configured", "unknown-session", "stale-session", "too-large", "invalid". */
  reason?: string;
  projectId?: string;
}

/** A profile received with autoImport = "ask", waiting for the admin to accept or dismiss. */
export interface PendingProfileImport {
  projectId: string;
  receivedAt: number;
  floorName: string;
  tagconnVersion: string;
  hasLayout: boolean;
  heroCount: number;
}

export const AttributionResolveSchema = z.strictObject({
  projectId: z.string().min(1).max(200),
  action: z.enum(['import', 'dismiss']),
});
export type AttributionResolve = z.infer<typeof AttributionResolveSchema>;

export const AttributionSaveSchema = z.strictObject({
  projectId: z.string().min(1).max(200),
  /** false (default): fail if .tagconn/office.json already exists. */
  overwrite: z.boolean().default(false),
});
export type AttributionSave = z.input<typeof AttributionSaveSchema>;

/**
 * server -> runner. The runner validates projectDir (realpath, inside allowedProjectDirs or
 * readOnlyProjectDirs, contains .git, not $HOME or /), refuses symlinked `.tagconn` or `office.json`,
 * re-parses `content` with AttributionProfileSchema, and writes atomically (tmp + rename, 0644).
 */
export const AttributionWriteCommandSchema = z.strictObject({
  projectDir: z.string().min(1).max(4096).startsWith('/'),
  /** Pretty-printed JSON of an AttributionProfile, <= ATTRIBUTION_MAX_PROFILE_BYTES. */
  content: z.string().min(2).max(ATTRIBUTION_MAX_PROFILE_BYTES),
  overwrite: z.boolean(),
});
export type AttributionWriteCommand = z.infer<typeof AttributionWriteCommandSchema>;

export interface AttributionWriteResult {
  written: boolean;
  /** Whether office.json existed before (written = false with existed = true means "not overwritten"). */
  existed: boolean;
  /** Always relative: ".tagconn/office.json". */
  relativePath: string;
}

export interface AttributionServerToClientEvents {
  /** Admin room only. */
  'attribution:pending': (p: PendingProfileImport) => void;
  'attribution:pendingCleared': (projectId: string) => void;
}

export interface AttributionClientToServerEvents {
  'attribution:pendingList': (ack: Ack<PendingProfileImport[]>) => void;
  'attribution:resolve': (req: AttributionResolve, ack: Ack<true>) => void;
  'attribution:save': (req: AttributionSave, ack: Ack<AttributionWriteResult>) => void;
}
