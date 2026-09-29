import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DESKTOP_CONFIG, DesktopConfigSchema, type DesktopConfig } from '@tagconn/shared';
import { writeFileAtomic, writeSecretFile } from '@tagconn/setup';
import type { Environment } from './paths.ts';

export interface ConfigStoreOptions {
  configDir: string;
  env?: Environment;
  platform?: NodeJS.Platform;
  warn?: (msg: string) => void;
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
    writeFileAtomic(this.path, JSON.stringify(merged, null, 2) + '\n');
    if (merged.serverPort !== before.serverPort) this.rewritePort(merged.serverPort);
    if (JSON.stringify(merged.allowedProjectDirs) !== JSON.stringify(before.allowedProjectDirs)) this.rewriteAllowedDirs(merged.allowedProjectDirs);
    return merged;
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

  /** Rewrites a secret JSON file in place (keeping every other field); a missing file is skipped. */
  private rewriteJson(name: string, edit: (o: Record<string, unknown>) => Record<string, unknown>): void {
    const path = join(this.opts.configDir, name);
    if (!existsSync(path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      const next = edit(parsed as Record<string, unknown>);
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
