import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { DEFAULT_DESKTOP_CONFIG, DesktopConfigSchema, type DesktopConfig } from '@tagconn/shared';
import { warnBroadAllowDirs, writeFileAtomic, writeSecretFile, type ExecFn } from '@tagconn/setup';
import { ensureDataDir } from './dataDir.ts';
import { RpcFailure } from './errors.ts';
import type { Environment } from './paths.ts';

export interface ConfigStoreOptions {
  configDir: string;
  env?: Environment;
  platform?: NodeJS.Platform;
  warn?: (msg: string) => void;
  /** Home dir for the validation below (default: the OS one). */
  homeDir?: string;
  exec?: ExecFn;
}

export const officeUrl = (port: number): string => `http://127.0.0.1:${port}`;

/** The Origins the server accepts when the desktop app serves the web itself on `port`. */
export const corsOriginsFor = (port: number): string[] => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

/** <configDir>/desktop.json: the DesktopConfig, merged over DEFAULT_DESKTOP_CONFIG. */
export class ConfigStore {
  private readonly path: string;
  private readonly warn: (msg: string) => void;

  constructor(private readonly opts: ConfigStoreOptions) {
    this.path = join(opts.configDir, 'desktop.json');
    this.warn = opts.warn ?? (() => {});
  }

  get(): DesktopConfig {
    if (!existsSync(this.path)) return { ...DEFAULT_DESKTOP_CONFIG };
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      const parsed = DesktopConfigSchema.safeParse({ ...DEFAULT_DESKTOP_CONFIG, ...(raw as object) });
      if (parsed.success) return parsed.data;
      this.warn(`desktop.json is invalid (${parsed.error.issues[0]?.message ?? 'unknown'}); using defaults`);
    } catch (err) {
      this.warn(`desktop.json could not be read (${(err as Error).message}); using defaults`);
    }
    return { ...DEFAULT_DESKTOP_CONFIG };
  }

  /** Persists a partial update. A port change is propagated to hook.json, runner.json and server-url. */
  set(patch: Partial<DesktopConfig>): DesktopConfig {
    const before = this.get();
    const merged = DesktopConfigSchema.parse({ ...before, ...definedOnly(patch) });
    this.validatePaths(merged, patch);
    if (merged.dataDir) {
      try {
        ensureDataDir(merged.dataDir, { platform: this.opts.platform, env: this.opts.env, exec: this.opts.exec });
      } catch (err) {
        throw new RpcFailure('invalid_request', `Cannot create the data folder ${merged.dataDir}: ${(err as Error).message}`, 'Choose another data folder.');
      }
    }
    writeFileAtomic(this.path, JSON.stringify(merged, null, 2) + '\n');
    if (merged.serverPort !== before.serverPort) this.rewritePort(merged.serverPort);
    if (JSON.stringify(merged.allowedProjectDirs) !== JSON.stringify(before.allowedProjectDirs)) this.rewriteAllowedDirs(merged.allowedProjectDirs);
    return merged;
  }

  /**
   * N8: dataDir and allowedProjectDirs come from the UI. Both must be absolute and neither may be a filesystem
   * root or the home folder; the data dir must not sit inside an allowed dir (a quest could then read or replace
   * the database and tokens). Broad parents (many repos below) only draw the setup warning.
   */
  private validatePaths(merged: DesktopConfig, patch: Partial<DesktopConfig>): void {
    const platform = this.opts.platform ?? process.platform;
    const p = platform === 'win32' ? path.win32 : path.posix;
    const canon = (d: string): string => {
      let out = p.resolve(d);
      if (platform === process.platform) {
        try {
          out = realpathSync(out);
        } catch {
          /* not created yet: compared as given */
        }
      }
      out = out.length > p.parse(out).root.length ? out.replace(/[\\/]+$/, '') : out;
      return platform === 'win32' ? out.toLowerCase() : out;
    };
    const home = canon(this.opts.homeDir ?? this.opts.env?.HOME ?? this.opts.env?.USERPROFILE ?? homedir());
    const check = (what: string, dir: string): string => {
      if (!p.isAbsolute(dir)) throw new RpcFailure('invalid_request', `${what} must be an absolute path (got "${dir}").`, 'Pick the folder with the folder chooser.');
      const c = canon(dir);
      if (p.dirname(c) === c) throw new RpcFailure('invalid_request', `${what} cannot be a drive or filesystem root (${dir}).`, 'Pick a project folder instead.');
      if (c === home) throw new RpcFailure('invalid_request', `${what} cannot be your home folder (${dir}).`, 'Pick a specific folder inside it.');
      return c;
    };
    // Only what this patch touches is checked, so an old saved value can never block an unrelated change.
    const dataDir = merged.dataDir ? (patch.dataDir !== undefined ? check('The data folder', merged.dataDir) : canon(merged.dataDir)) : undefined;
    const allowed = merged.allowedProjectDirs.map((d) => (patch.allowedProjectDirs !== undefined ? check('An allowed project folder', d) : canon(d)));
    if (dataDir) {
      const hit = allowed.find((a) => dataDir === a || dataDir.startsWith(a + p.sep));
      if (hit !== undefined) {
        throw new RpcFailure('invalid_request', `The data folder ${merged.dataDir} is inside an allowed project folder, where quests could reach the database.`, 'Choose a data folder outside every allowed project folder.');
      }
    }
    if (patch.allowedProjectDirs !== undefined) warnBroadAllowDirs(merged.allowedProjectDirs, this.warn);
  }

  /**
   * Design doc, "Ports and origin": web, hook and runner must never disagree about the port. The server's own
   * port and corsOrigins come from the env at every start (services.ts), so only the files are rewritten here.
   */
  private rewritePort(port: number): void {
    const url = officeUrl(port);
    const isLoopback = (u: unknown): boolean => {
      try {
        return ['127.0.0.1', 'localhost'].includes(new URL(String(u)).hostname);
      } catch {
        return false;
      }
    };
    for (const name of ['hook.json', 'runner.json']) {
      this.rewriteJson(name, (o) => (isLoopback(o.url) || o.url === undefined ? { ...o, url } : o));
    }
    if (existsSync(join(this.opts.configDir, 'server-url'))) writeFileAtomic(join(this.opts.configDir, 'server-url'), `${url}\n`);
  }

  private rewriteAllowedDirs(dirs: string[]): void {
    this.rewriteJson('runner.json', (o) => ({ ...o, allowedProjectDirs: dirs }));
  }

  /** Merges `fields` (undefined values skipped) into runner.json when any differ. False when missing or unchanged. */
  updateRunnerJson(fields: Record<string, unknown>): boolean {
    const defined = definedOnly(fields);
    let changed = false;
    this.rewriteJson('runner.json', (o) => {
      changed = Object.entries(defined).some(([k, v]) => JSON.stringify(o[k]) !== JSON.stringify(v));
      return changed ? { ...o, ...defined } : o;
    }, () => changed);
    return changed;
  }

  /** Rewrites a secret JSON file in place (keeping every other field); a missing file is skipped. */
  private rewriteJson(name: string, edit: (o: Record<string, unknown>) => Record<string, unknown>, shouldWrite: () => boolean = () => true): void {
    const path = join(this.opts.configDir, name);
    if (!existsSync(path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      const next = edit(parsed as Record<string, unknown>);
      if (!shouldWrite()) return;
      writeSecretFile(path, JSON.stringify(next, null, 2) + '\n', { env: this.opts.env, platform: this.opts.platform });
    } catch (err) {
      this.warn(`could not update ${path}: ${(err as Error).message}`);
    }
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Reads a string field from a JSON file (a token), or undefined. */
export function readJsonField(path: string, field: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)[field];
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
  }
}
