import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAIN_ROLE, type Role, type RoleInput, RoleSchema } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { HttpError, notFound } from '../../core/http/index.js';
import type { RolesRepository } from './roles.repository.js';
import { isSafeAgentsDir, isValidRoleName, type SyncResult, syncRolesToDir } from './roles.sync.js';
import { loadTemplates } from './roles.templates.js';

const SEEDED_KEY = 'roles.seeded';

export class RolesService {
  constructor(private readonly deps: Deps<'rolesRepository' | 'settings' | 'bus' | 'logger' | 'templatesDir'>) {}

  private get repo(): RolesRepository {
    return this.deps.rolesRepository;
  }

  /** First boot only: import the default roles from the templates dir. */
  seed(): number {
    if (this.repo.getMeta(SEEDED_KEY)) return 0;
    const dir = this.deps.templatesDir;
    if (!dir) {
      this.deps.logger.warn('role templates dir not found (set OFFICE_TEMPLATES_DIR); starting without default roles');
      return 0;
    }
    const roles = loadTemplates(dir, (file, err) => this.deps.logger.warn({ err, file }, 'skipping invalid role template'));
    for (const role of roles) this.repo.insertIfMissing(role);
    this.repo.setMeta(SEEDED_KEY, new Date().toISOString());
    this.deps.logger.info({ count: roles.length, dir }, 'seeded roles from templates');
    return roles.length;
  }

  list(): Role[] {
    return this.repo.list();
  }

  get(name: string): Role | undefined {
    return this.repo.get(name);
  }

  save(name: string, input: Omit<RoleInput, 'name'> & { name?: string }): Role {
    if (!isValidRoleName(name)) throw new HttpError(400, `Invalid role name "${name}"`);
    if (input.name !== undefined && input.name !== name) throw new HttpError(400, 'Role name in body does not match URL');
    const parsed = RoleSchema.safeParse({ ...input, name, builtin: this.repo.get(name)?.builtin ?? false });
    if (!parsed.success) throw new HttpError(400, `Invalid role: ${parsed.error.message}`, parsed.error.issues);
    this.repo.upsert(parsed.data);
    this.changed();
    return parsed.data;
  }

  delete(name: string): void {
    if (name === MAIN_ROLE) throw new HttpError(400, `Role "${MAIN_ROLE}" is the main session and cannot be deleted`);
    if (!this.repo.delete(name)) throw notFound(`Role ${name}`);
    this.changed();
  }

  /** Explicit sync: creates the agents dir if needed. */
  sync(): SyncResult {
    const { agentsDir: dir, claudeDir } = this.deps.settings.get().paths;
    if (!isSafeAgentsDir(dir, claudeDir)) {
      this.deps.logger.warn({ agentsDir: dir, claudeDir }, 'refusing to sync roles: agentsDir must be a distinct directory named "agents"');
      return { written: [], removed: [], skipped: [] };
    }
    const result = syncRolesToDir(this.repo.list(), dir);
    if (result.written.length || result.removed.length || result.skipped.length) {
      this.deps.logger.info({ dir, ...result }, 'synced roles to Claude agents dir');
    }
    return result;
  }

  /** Auto-sync only when the agents dir (or at least its parent, e.g. ~/.claude) already exists. */
  autoSync(): SyncResult | undefined {
    const dir = this.deps.settings.get().paths.agentsDir;
    if (!existsSync(dir) && !existsSync(dirname(dir))) return undefined;
    try {
      return this.sync();
    } catch (err) {
      this.deps.logger.error({ err, dir }, 'role sync failed');
      return undefined;
    }
  }

  private changed(): void {
    this.autoSync();
    this.deps.bus.emit('roles.changed', this.repo.list());
  }
}
