import { randomBytes } from 'node:crypto';
import {
  type AttributionImportResult,
  type AttributionProfile,
  AttributionProfileSchema,
  AttributionWriteCommandSchema,
  type AttributionWriteResult,
  CLAUDE_SESSION_ID_RE,
  hasLayoutErrors,
  HeroAppearanceSchema,
  type HeroCreate,
  HERO_LOOK_STYLES,
  HeroStyleOverrideSchema,
  type HeroStyles,
  type OfficeLayout,
  type OfficeLayoutInput,
  type PendingProfileImport,
  type Project,
  validateLayout,
} from '@tagconn/shared';
import { isStrictlyUnder, normPath } from '../../core/db/index.js';
import { redactValue } from '../../core/redact/index.js';
import type { Deps } from '../../core/di/index.js';
import { HttpError, notFound } from '../../core/http/index.js';
import type { AttributionRepository } from './attribution.repository.js';
import { toPending } from './attribution.repository.js';
import pkg from '../../../package.json';

type AttributionDeps = Deps<
  | 'attributionRepository'
  | 'sessionsRepository'
  | 'projectsRepository'
  | 'projectsService'
  | 'layoutsRepository'
  | 'layoutsService'
  | 'heroesRepository'
  | 'heroesService'
  | 'rolesService'
  | 'settings'
  | 'bus'
  | 'logger'
  // The runner gateway/dispatch port (`modules/runs`), used only to forward `attribution:write` (§6.4)
  // to the verified runner — see `save()`. Not imported directly; typed via the shared DI `Cradle`.
  | 'runsService'
>;

/** Keys `HeroAppearanceSchema` actually accepts; every other key in a hero's `look` is dropped. */
const KNOWN_APPEARANCE_KEYS = new Set(Object.keys(HeroAppearanceSchema.shape));
const KNOWN_STYLE_KEYS = new Set([...KNOWN_APPEARANCE_KEYS, 'title']);

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'floor';

const ignored = (reason: AttributionImportResult['reason']): AttributionImportResult => ({ status: 'ignored', reason });
const rejected = (reason: AttributionImportResult['reason']): AttributionImportResult => ({ status: 'rejected', reason });

/**
 * M8 8j attribution import (S4): validates and (with consent) applies a project's `.tagconn/office.json`
 * profile, posted by the hook to `POST /api/attribution/import`. See
 * docs/design/runner-and-helpdesk.md §6.3. SC4: a rejected/invalid profile is never echoed, logged or
 * stored — only a generic reason code and sizes ever reach the logger or the hook's own response.
 */
export class AttributionService {
  constructor(private readonly deps: AttributionDeps) {}

  private get repo(): AttributionRepository {
    return this.deps.attributionRepository;
  }

  /**
   * `sessionId` is whatever the `x-tagconn-session-id` header contained (unvalidated); `rawBody` is the
   * parsed JSON body (never logged as-is). The project is resolved ONLY from the session, never from
   * anything inside the body, so a forged header naming another session can only ever target that
   * session's own project (and only within its `importWindowSec` window).
   */
  importProfile(sessionId: string | undefined, rawBody: unknown, now = Date.now(), opts: { sourceDir?: string } = {}): AttributionImportResult {
    const sizeBytes = this.approxSize(rawBody);
    const { attribution } = this.deps.settings.get();

    if (!this.deps.settings.get().server.hookToken) return this.log(ignored('no-hook-token'), sizeBytes);
    if (!attribution.enabled || attribution.autoImport === 'off') return this.log(ignored('disabled'), sizeBytes);

    if (!sessionId || !CLAUDE_SESSION_ID_RE.test(sessionId)) return this.log(ignored('unknown-session'), sizeBytes);
    const session = this.deps.sessionsRepository.get(sessionId);
    if (!session) return this.log(ignored('unknown-session'), sizeBytes);
    if (now - session.startedAt > attribution.importWindowSec * 1000) return this.log(ignored('stale-session'), sizeBytes, session.projectId);

    const projectId = session.projectId;
    const project = this.deps.projectsRepository.get(projectId);
    if (!project) return this.log(ignored('unknown-session'), sizeBytes);

    if (sizeBytes > attribution.maxProfileBytes) return this.log(rejected('too-large'), sizeBytes, projectId);

    const existing = this.repo.get(projectId);
    if (existing?.status === 'imported') return this.log(ignored('already-configured'), sizeBytes, projectId);
    if (existing?.status === 'ignored') return this.log(ignored('dismissed-before'), sizeBytes, projectId);

    const profile = this.validateProfile(rawBody);
    if (!profile) return this.log(rejected('invalid'), sizeBytes, projectId);

    const unknownRoles = [...new Set(profile.heroes.map((h) => h.role).filter((role) => !this.deps.rolesService.get(role)))];
    const hasLayout = profile.layout !== undefined;
    const heroCount = profile.heroes.length;

    // The profile was read from `sourceDir`; when that is not inside the session's pinned floor (e.g. the
    // session was pinned elsewhere), never auto-apply it: record where it came from and ask the admin.
    const foreign =
      opts.sourceDir !== undefined && normPath(opts.sourceDir) !== normPath(project.cwd) && !isStrictlyUnder(opts.sourceDir, project.cwd);
    const projectCwd = foreign ? opts.sourceDir! : project.cwd;

    if (attribution.autoImport === 'auto' && !foreign) {
      const alreadyConfigured = Boolean(project.layoutId) || this.deps.heroesRepository.list(projectId).length > 0;
      if (alreadyConfigured) return this.log(ignored('already-configured'), sizeBytes, projectId);
      this.apply(projectId, profile);
      this.repo.recordAutoImported({ projectId, projectCwd: project.cwd, receivedAt: now, floorName: profile.floor.name, tagconnVersion: profile.tagconnVersion, hasLayout, heroCount, unknownRoles, profile }, now);
      return this.log({ status: 'imported', projectId }, sizeBytes, projectId);
    }

    // autoImport: 'ask' (default). Store as pending and let the admin decide (attribution:pending toast).
    this.repo.upsertPending({ projectId, projectCwd, receivedAt: now, floorName: profile.floor.name, tagconnVersion: profile.tagconnVersion, hasLayout, heroCount, unknownRoles, profile });
    const pending: PendingProfileImport = { projectId, projectCwd, receivedAt: now, floorName: profile.floor.name, tagconnVersion: profile.tagconnVersion, hasLayout, heroCount, unknownRoles };
    this.deps.bus.emit('attribution.pending', pending);
    return this.log({ status: 'pending', projectId }, sizeBytes, projectId);
  }

  pendingList(): PendingProfileImport[] {
    return this.repo.listPending().map(toPending);
  }

  /** Admin-gated (REST `/api/attribution/resolve` + socket `attribution:resolve`). */
  resolve(projectId: string, action: 'import' | 'dismiss'): true {
    const row = this.repo.get(projectId);
    if (!row || row.status !== 'pending') throw notFound(`Pending attribution import for project ${projectId}`);

    if (action === 'dismiss') {
      this.repo.resolve(projectId, 'ignored', Date.now());
      this.deps.bus.emit('attribution.pendingCleared', projectId);
      return true;
    }

    this.apply(projectId, row.profile);
    this.repo.resolve(projectId, 'imported', Date.now());
    this.deps.bus.emit('attribution.pendingCleared', projectId);
    return true;
  }

  /** `GET /api/attribution/export?cwd=` (public): the portable profile of the project at `cwd`. */
  export(cwd: string, projectIdFor: (cwd: string) => string, now = Date.now()): AttributionProfile {
    const project = this.deps.projectsRepository.get(projectIdFor(cwd));
    if (!project) throw notFound(`Project for cwd "${cwd}"`);
    return this.buildProfile(project, now);
  }

  /**
   * "Save profile to project" (§6.4, M8 8k/8l), admin-gated (REST `POST /api/attribution/save` +
   * socket `attribution:save`). Builds the same portable profile `export()` does, then forwards it to
   * the verified host runner's `attribution:write`, which is the only thing that ever touches the
   * repo: it re-checks `allowedProjectDirs` by realpath, refuses a symlinked `.tagconn`/`office.json`,
   * and never overwrites without `overwrite: true`. `runsService.sendAttributionWrite` throws a
   * client-safe `HttpError` for every refusal (runner disabled/offline, dir not allowed, runner-side
   * refusal) — this method does no error translation of its own.
   */
  async save(projectId: string, overwrite: boolean, now = Date.now()): Promise<AttributionWriteResult> {
    const project = this.deps.projectsRepository.get(projectId);
    if (!project) throw notFound(`Project ${projectId}`);
    const profile = this.buildProfile(project, now);
    const cmd = AttributionWriteCommandSchema.parse({ projectDir: project.cwd, content: JSON.stringify(profile, null, 2), overwrite });
    return this.deps.runsService.sendAttributionWrite(cmd);
  }

  private buildProfile(project: Project, now: number): AttributionProfile {
    const layout = project.layoutId ? this.deps.layoutsRepository.get(project.layoutId) : undefined;
    const heroes = this.deps.heroesRepository.list(project.id);
    return {
      kind: 'tagconn.office-profile',
      version: 1,
      tagconnVersion: pkg.version,
      savedAt: new Date(now).toISOString(),
      floor: { name: project.name, style: layout?.style },
      layout: layout ? this.toProfileLayout(layout) : undefined,
      heroes: heroes.map((h) => ({
        role: h.role,
        name: h.name,
        ...(h.title ? { title: h.title } : {}),
        look: this.toProfileLook(h.appearance),
        ...(h.styles && Object.keys(h.styles).length > 0 ? { styles: this.toProfileStyles(h.styles) } : {}),
      })),
    };
  }

  /** `HeroAppearanceSchema` allows `null` for a couple of fields (theme default); `HeroProfileSchema.look`
   *  values may only be string/number/boolean, so a `null` field is simply omitted from the export. */
  private toProfileLook(appearance: Record<string, unknown>): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(appearance)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
    return out;
  }

  /** Per-style overrides as profile records (style -> look keys plus `title`); null stays null (= theme default). */
  private toProfileStyles(styles: HeroStyles): Record<string, Record<string, string | number | boolean | null>> {
    const out: Record<string, Record<string, string | number | boolean | null>> = {};
    for (const [style, o] of Object.entries(styles)) {
      const rec: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(o)) if (v !== undefined) rec[k] = v as string | number | boolean | null;
      if (Object.keys(rec).length > 0) out[style] = rec;
    }
    return out;
  }

  /** Strips the server/optimistic-concurrency fields an `OfficeLayout` carries but a profile never does
   *  (their shapes otherwise match exactly: both come from `OfficeLayoutInputSchema` minus `id`). */
  private toProfileLayout(layout: OfficeLayout): AttributionProfile['layout'] {
    const { id: _id, builtin: _builtin, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = layout;
    return rest;
  }

  /** Schema + redaction + geometry validation. Never returns (or logs) the raw value on failure. */
  private validateProfile(rawBody: unknown): AttributionProfile | undefined {
    const parsed = AttributionProfileSchema.safeParse(rawBody);
    if (!parsed.success) return undefined;
    const profile = parsed.data;
    // Defense in depth: a profile that itself looks like it carries a secret is rejected even though
    // it passed the strict schema (e.g. a hero title someone pasted an API key into).
    const redacted = redactValue(profile, this.deps.settings.get().ingest.redactPatterns);
    if (JSON.stringify(redacted) !== JSON.stringify(profile)) return undefined;
    if (profile.layout && hasLayoutErrors(validateLayout(profile.layout))) return undefined;
    return profile;
  }

  /** Creates a new layout (never overwrites an existing one) and heroes for roles that already exist. */
  private apply(projectId: string, profile: AttributionProfile): void {
    const patch: { name?: string; layoutId?: string } = { name: profile.floor.name };

    if (profile.layout) {
      const layoutInput: OfficeLayoutInput = { ...profile.layout, name: profile.floor.name, style: profile.floor.style ?? profile.layout.style };
      if (!hasLayoutErrors(validateLayout(layoutInput))) {
        const id = this.freshLayoutId(profile.floor.name);
        this.deps.layoutsService.replace(id, layoutInput);
        patch.layoutId = id;
      } else {
        this.deps.logger.warn({ projectId }, 'attribution: stored profile layout no longer validates; skipping layout import');
      }
    }

    this.deps.projectsService.update(projectId, patch);

    for (const hero of profile.heroes) {
      if (!this.deps.rolesService.get(hero.role)) continue; // unknown role: never auto-created (M8 SC1)
      const input: HeroCreate = { projectId, role: hero.role, name: hero.name, title: hero.title, appearance: this.filterLook(hero.look), styles: this.filterStyles(hero.styles) };
      try {
        this.deps.heroesService.create(input);
      } catch (err) {
        this.deps.logger.warn({ projectId, role: hero.role, err: err instanceof Error ? err.message : String(err) }, 'attribution: could not create a hero from the profile');
      }
    }
  }

  /** Drops any `look` key `HeroAppearanceSchema` doesn't know (M8 SC1: a profile is untrusted repo content). */
  private filterLook(look: Record<string, string | number | boolean> | undefined): HeroCreate['appearance'] {
    if (!look) return undefined;
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(look)) if (KNOWN_APPEARANCE_KEYS.has(k)) out[k] = v;
    return out as HeroCreate['appearance'];
  }

  /** Keeps only known styles with schema-valid overrides (unknown styles/keys and invalid values are dropped). */
  private filterStyles(styles: Record<string, Record<string, string | number | boolean | null>> | undefined): HeroStyles | undefined {
    if (!styles) return undefined;
    const out: Record<string, unknown> = {};
    for (const style of HERO_LOOK_STYLES) {
      const raw = Object.hasOwn(styles, style) ? styles[style] : undefined;
      if (!raw) continue;
      const known: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) if (KNOWN_STYLE_KEYS.has(k)) known[k] = v;
      const parsed = HeroStyleOverrideSchema.safeParse(known);
      if (parsed.success && Object.keys(parsed.data).length > 0) out[style] = parsed.data;
    }
    return Object.keys(out).length > 0 ? (out as HeroStyles) : undefined;
  }

  private freshLayoutId(name: string): string {
    const base = `imported-${slugify(name)}`.slice(0, 55);
    for (let i = 0; i < 20; i++) {
      const id = `${base}-${randomBytes(4).toString('hex')}`;
      if (!this.deps.layoutsRepository.get(id)) return id;
    }
    throw new HttpError(500, 'Could not generate a unique layout id');
  }

  private approxSize(body: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(body) ?? '');
    } catch {
      return 0;
    }
  }

  /** SC4: only a reason code, a status, sizes and (once resolved) the project id ever reach the logger. */
  private log(result: AttributionImportResult, sizeBytes: number, projectId?: string): AttributionImportResult {
    this.deps.logger.info({ status: result.status, reason: result.reason, sizeBytes, projectId: projectId ?? result.projectId }, 'attribution import');
    return result;
  }
}
