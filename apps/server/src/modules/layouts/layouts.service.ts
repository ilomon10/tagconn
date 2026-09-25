import { randomBytes } from 'node:crypto';
import {
  DEFAULT_LAYOUT,
  DEFAULT_LAYOUT_ID,
  hasLayoutErrors,
  type LayoutIssue,
  type OfficeLayout,
  type OfficeLayoutInput,
  OfficeLayoutInputSchema,
  validateLayout,
} from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { HttpError, notFound } from '../../core/http/index.js';
import type { LayoutsRepository } from './layouts.repository.js';

/**
 * Thrown when `validateLayout` reports errors. REST turns this into the standard
 * `{ error: 'Invalid layout', statusCode: 400, details: issues }` via `HttpError`; the socket layer
 * (`layouts.socket.ts`) reads `.issues` itself to build the `issues.map(i => i.message).join('; ')`
 * message the contract in docs/design/guild-hall.md §7 asks for.
 */
export class LayoutValidationError extends HttpError {
  constructor(readonly issues: LayoutIssue[]) {
    super(400, 'Invalid layout', issues);
  }
}

/** Same slugify as projects (lowercase, non-alnum runs collapse to one dash), capped so the
 * `-xxxx` suffix always fits inside `LAYOUT_ID_RE`'s 64 character limit. */
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 58) || 'layout';

export class LayoutsService {
  constructor(private readonly deps: Deps<'layoutsRepository' | 'projectsRepository' | 'bus' | 'logger'>) {}

  private get repo(): LayoutsRepository {
    return this.deps.layoutsRepository;
  }

  list(): OfficeLayout[] {
    return this.repo.list();
  }

  get(id: string): OfficeLayout {
    const layout = this.repo.get(id);
    if (!layout) throw notFound(`Layout ${id}`);
    return layout;
  }

  /** Boot-time: always overwrite the builtin default with the shipped `DEFAULT_LAYOUT`, keeping its `createdAt`. */
  seedDefault(now = Date.now()): void {
    const existing = this.repo.get(DEFAULT_LAYOUT_ID);
    this.repo.upsert({ ...DEFAULT_LAYOUT, createdAt: existing?.createdAt ?? now, updatedAt: now });
  }

  /** Fills in field defaults (`background`, `corridorWidth`) before geometry validation and storage;
   * safe to call again even when the REST/socket boundary already parsed the same schema. */
  create(rawInput: OfficeLayoutInput): OfficeLayout {
    const input = OfficeLayoutInputSchema.parse(rawInput);
    const issues = validateLayout(input);
    if (hasLayoutErrors(issues)) throw new LayoutValidationError(issues);
    const now = Date.now();
    const layout: OfficeLayout = { ...input, id: this.freshId(input.name), builtin: false, createdAt: now, updatedAt: now };
    this.repo.upsert(layout);
    this.deps.bus.emit('layout.upserted', layout);
    return layout;
  }

  /** Create (id unused so far) or replace (id already stored, must not be builtin). */
  replace(id: string, rawInput: OfficeLayoutInput): OfficeLayout {
    const input = OfficeLayoutInputSchema.parse(rawInput);
    if (input.id !== undefined && input.id !== id) throw new HttpError(400, 'Layout id in body does not match the URL');
    const existing = this.repo.get(id);
    if (existing?.builtin) throw new HttpError(409, `Layout "${id}" is builtin and read-only; duplicate it to edit`);
    const issues = validateLayout(input);
    if (hasLayoutErrors(issues)) throw new LayoutValidationError(issues);
    const now = Date.now();
    const layout: OfficeLayout = { ...input, id, builtin: false, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.repo.upsert(layout);
    this.deps.bus.emit('layout.upserted', layout);
    return layout;
  }

  /** Deletes the layout and clears it from any project that used it (re-broadcasting each project). */
  delete(id: string): void {
    const existing = this.repo.get(id);
    if (!existing) throw notFound(`Layout ${id}`);
    if (existing.builtin) throw new HttpError(409, `Layout "${id}" is builtin and cannot be deleted`);
    this.repo.delete(id);
    for (const project of this.deps.projectsRepository.list()) {
      if (project.layoutId !== id) continue;
      const updated = { ...project, layoutId: undefined };
      this.deps.projectsRepository.upsert(updated);
      this.deps.bus.emit('project.upserted', updated);
    }
    this.deps.bus.emit('layout.removed', id);
  }

  private freshId(name: string): string {
    const base = slugify(name);
    for (let i = 0; i < 20; i++) {
      const id = `${base}-${randomBytes(2).toString('hex')}`;
      if (!this.repo.get(id)) return id;
    }
    throw new HttpError(500, 'Could not generate a unique layout id');
  }
}
