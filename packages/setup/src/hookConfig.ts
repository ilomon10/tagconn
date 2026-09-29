import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join as hostJoin } from 'node:path';
import { ensureConfigDir } from './fsutil.ts';
import { secretOptions, touch, type SetupContext } from './context.ts';
import { writeSecretFile } from './secrets.ts';

export const HOOK_CONFIG_VERSION = 1;

export interface HookConfig {
  version: 1;
  url: string;
  token: string;
  attributionReadme: boolean;
  /** Import a repo's .tagconn/office.json profile (mirrors the sh hook's "attribution.conf exists" gate). */
  attributionImport: boolean;
}

/**
 * Writes <configDir>/hook.json ({version, url, token, attributionReadme, attributionImport}) as a secret file (0600 / user-only
 * ACL): the node hook (office-hook.mjs) reads its URL and token from here, so the token never goes on argv.
 * Throws SecretFileError if the file cannot be locked down; the caller must refuse to continue.
 */
export function writeHookConfig(
  ctx: SetupContext,
  configDir: string,
  cfg: { url: string; token: string; attributionReadme: boolean; attributionImport?: boolean },
): string {
  const path = hostJoin(configDir, 'hook.json');
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would write ${path} (user-only)`);
    return path;
  }
  ensureConfigDir(ctx, configDir);
  const body: HookConfig = { version: HOOK_CONFIG_VERSION, url: cfg.url, token: cfg.token, attributionReadme: cfg.attributionReadme,
    // On by default, like attribution.conf: importing writes nothing to the repo and the server asks first.
    attributionImport: cfg.attributionImport ?? true,
  };
  writeSecretFile(path, JSON.stringify(body, null, 2) + '\n', secretOptions(ctx));
  touch(ctx, path);
  ctx.log(`  wrote ${path}`);
  return path;
}

/** Reads the token back out of an existing hook.json (undefined if missing or malformed). */
export function readHookConfigToken(configDir: string): string | undefined {
  const path = hostJoin(configDir, 'hook.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const token = (parsed as { token?: unknown } | null)?.token;
    return typeof token === 'string' && token ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Copies packages/hook/office-hook.mjs to <configDir>/office-hook.mjs. Returns the installed path. */
export function installNodeHookScript(ctx: SetupContext, configDir: string): string {
  const dest = hostJoin(configDir, 'office-hook.mjs');
  const src = ctx.resources.hookMjsPath;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would copy ${src} -> ${dest}`);
    return dest;
  }
  if (!existsSync(src)) {
    throw new Error(`The node hook script is missing (${src}); this install is incomplete.`);
  }
  ensureConfigDir(ctx, configDir);
  copyFileSync(src, dest);
  if (ctx.platform !== 'win32') chmodSync(dest, 0o644);
  touch(ctx, dest);
  ctx.log(`  installed node hook script at ${dest}`);
  return dest;
}

/** Removes <configDir>/hook.json (holds the shared secret) on uninstall. The hook script stays, like office-hook.sh. */
export function removeHookConfig(ctx: SetupContext, configDir: string): void {
  const path = hostJoin(configDir, 'hook.json');
  if (!existsSync(path)) return;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would remove ${path}`);
    return;
  }
  rmSync(path);
  touch(ctx, path);
  ctx.log(`  removed ${path}`);
}
