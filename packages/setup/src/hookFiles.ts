import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretOptions, touch, type SetupContext } from './context.ts';
import { ensureConfigDir } from './fsutil.ts';
import { writeSecretFile } from './secrets.ts';
import { validateUrl } from './validate.ts';

// The sh-hook side of the install (curl.conf, the copied office-hook.sh) plus the attribution files
// that both hook kinds share (see docs/design/runner-and-helpdesk.md §6.2).

/**
 * Writes <configDir>/curl.conf, mode 600: a curl `-K` config file holding the
 * shared secret and target URL, so the hook never puts the token on a
 * command line (visible to any local user via `ps`).
 */
export function ensureCurlConf(ctx: SetupContext, configDir: string, token: string, urlIn: string): string {
  // The URL is written between quotes into a curl config: a quote or newline would inject more options.
  const url = validateUrl(urlIn);
  const confPath = join(configDir, 'curl.conf');
  const content =
    `# Written by tagconn scripts/install.ts. Contains the hook's shared secret -\n` +
    `# mode 600, read by curl -K, never passed on a command line.\n` +
    `header = "x-office-token: ${token}"\n` +
    `url = "${url}/api/hooks"\n`;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would write ${confPath} (mode 600)`);
    return confPath;
  }
  ensureConfigDir(ctx, configDir);
  writeSecretFile(confPath, content, secretOptions(ctx));
  touch(ctx, confPath);
  ctx.log(`  wrote ${confPath}`);
  return confPath;
}

/**
 * Writes <configDir>/server-url: a plain-text, NON-secret file holding just the server URL, so
 * skills/scripts that need it (e.g. the tagconn-save skill, SC4 M2) don't have to read the repo
 * `.env` - which holds OFFICE_HOOK_TOKEN and OFFICE_RUNNER__TOKEN and should never be read by an
 * agent skill just to learn a URL.
 */
export function ensureServerUrlFile(ctx: SetupContext, configDir: string, url: string): string {
  const path = join(configDir, 'server-url');
  const content = `${url}\n`;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would write ${path}`);
    return path;
  }
  ensureConfigDir(ctx, configDir);
  const tmpPath = join(configDir, `.server-url.tagconn-tmp-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
  renameSync(tmpPath, path);
  touch(ctx, path);
  ctx.log(`  wrote ${path}`);
  return path;
}

/** Removes <configDir>/server-url on uninstall. */
export function removeServerUrlFile(ctx: SetupContext, configDir: string): void {
  const path = join(configDir, 'server-url');
  if (!existsSync(path)) return;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would remove ${path}`);
    return;
  }
  rmSync(path);
  touch(ctx, path);
  ctx.log(`  removed ${path}`);
}

/** Removes <configDir>/curl.conf (holds the shared secret) on uninstall. */
export function removeCurlConf(ctx: SetupContext, configDir: string): void {
  const confPath = join(configDir, 'curl.conf');
  if (!existsSync(confPath)) return;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would remove ${confPath}`);
    return;
  }
  rmSync(confPath);
  touch(ctx, confPath);
  ctx.log(`  removed ${confPath}`);
}

/** Removes the legacy shell-sourced hook.env, superseded by curl.conf (MED-5 / LOW-1). */
export function removeLegacyHookEnv(ctx: SetupContext, configDir: string): void {
  const legacyPath = join(configDir, 'hook.env');
  if (!existsSync(legacyPath)) return;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would remove legacy ${legacyPath} (superseded by curl.conf)`);
    return;
  }
  rmSync(legacyPath);
  touch(ctx, legacyPath);
  ctx.log(`  removed legacy ${legacyPath} (superseded by curl.conf)`);
}

export function ensureHookScript(ctx: SetupContext, configDir: string): string {
  const dest = join(configDir, 'office-hook.sh');
  const src = ctx.resources.hookShPath;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would copy ${src} -> ${dest} (mode 755)`);
    return dest;
  }
  ensureConfigDir(ctx, configDir);
  cpSync(src, dest);
  touch(ctx, dest);
  if (ctx.platform !== 'win32') chmodSync(dest, 0o755);
  ctx.log(`  installed hook script at ${dest}`);
  return dest;
}
/** Installs the opt-in README template; the hook only ever writes .tagconn/README.md when this exists. */
export function installAttributionReadme(ctx: SetupContext, configDir: string): string {
  const dest = join(configDir, 'attribution-README.md');
  const src = ctx.resources.attributionTemplate;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would copy ${src} -> ${dest}`);
    return dest;
  }
  ensureConfigDir(ctx, configDir);
  cpSync(src, dest);
  touch(ctx, dest);
  ctx.log(`  installed ${dest} (the hook will write .tagconn/README.md into repos you open)`);
  return dest;
}

/** Removes the opt-in README template, so the hook stops writing .tagconn/README.md. */
export function removeAttributionReadme(ctx: SetupContext, configDir: string): void {
  const dest = join(configDir, 'attribution-README.md');
  if (!existsSync(dest)) return;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would remove ${dest}`);
    return;
  }
  rmSync(dest);
  touch(ctx, dest);
  ctx.log(`  removed ${dest}`);
}

/**
 * Writes <configDir>/attribution.conf, mode 600: a curl `-K` config pointed at the
 * import endpoint, reusing the hook token (same "hook" access level as /api/hooks).
 * Installed by default - unlike the README template, importing writes nothing to the
 * repo and the server always asks before applying an import (settings.attribution.autoImport).
 */
export function ensureAttributionConf(ctx: SetupContext, configDir: string, token: string, urlIn: string): string {
  const url = validateUrl(urlIn);
  const confPath = join(configDir, 'attribution.conf');
  const content =
    `# Written by tagconn scripts/install.ts. Used by the hook to POST\n` +
    `# .tagconn/office.json profiles for import - mode 600, read by curl -K.\n` +
    `header = "x-office-token: ${token}"\n` +
    `url = "${url}/api/attribution/import"\n`;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would write ${confPath} (mode 600)`);
    return confPath;
  }
  ensureConfigDir(ctx, configDir);
  writeSecretFile(confPath, content, secretOptions(ctx));
  touch(ctx, confPath);
  ctx.log(`  wrote ${confPath}`);
  return confPath;
}

/** Removes <configDir>/attribution.conf on uninstall. */
export function removeAttributionConf(ctx: SetupContext, configDir: string): void {
  const confPath = join(configDir, 'attribution.conf');
  if (!existsSync(confPath)) return;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would remove ${confPath}`);
    return;
  }
  rmSync(confPath);
  touch(ctx, confPath);
  ctx.log(`  removed ${confPath}`);
}
