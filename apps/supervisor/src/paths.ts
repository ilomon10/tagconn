import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultResources, resolveConfigDir, resolveSetupPaths, type SetupPaths, type SetupResources } from '@tagconn/setup';

export type Environment = Record<string, string | undefined>;

/**
 * Where tagconn keeps things. Same rules as the CLIs except POSIX honours XDG_CONFIG_HOME (no legacyPosixConfig,
 * the desktop app registers the node hook, which reads hook.json from the config dir). TAGCONN_CONFIG_DIR wins,
 * then a non-default CLAUDE_CONFIG_DIR derives a sibling config dir, so sandboxed runs never touch the real one.
 */
export function resolvePaths(env: Environment = process.env, platform: NodeJS.Platform = process.platform): SetupPaths {
  const base = resolveSetupPaths({ env, platform });
  const config = resolveConfigDir(
    { configDirFlag: undefined, configDirEnv: env.TAGCONN_CONFIG_DIR || undefined, claudeDirExplicit: Boolean(env.CLAUDE_CONFIG_DIR), claudeDir: base.claudeDir },
    { env, platform },
  );
  return { ...base, config };
}

/** True when the config dir is not the OS default (a sandbox): runner.json then gets a sandboxed stateDir. */
export function isSandboxedConfig(env: Environment = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return resolvePaths(env, platform).config !== resolveSetupPaths({ env, platform }).config;
}

export interface Bundle {
  /** The packaged resources dir (TAGCONN_BUNDLE_DIR); absent in the repo layout, where the bundle is the checkout. */
  dir?: string;
  serverJs: string;
  runnerJs: string;
  webDir: string;
  composeFile: string;
  resources: SetupResources;
}

/** apps/supervisor/{src,dist} -> the repo root (dev layout). */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The files the services run from. TAGCONN_BUNDLE_DIR is the packaged resources dir:
 *   server/main.js  runner/main.js  web/  hook/office-hook.mjs  agent-templates/{roles,skills,attribution}
 *   docker-compose.yml
 * Without it: the repo layout (apps/*\/dist), for `tauri dev` and tests.
 */
export function resolveBundle(env: Environment = process.env): Bundle {
  const dir = env.TAGCONN_BUNDLE_DIR;
  if (!dir) {
    return {
      serverJs: join(repoRoot, 'apps', 'server', 'dist', 'main.js'),
      runnerJs: join(repoRoot, 'apps', 'runner', 'dist', 'main.js'),
      webDir: join(repoRoot, 'apps', 'web', 'dist'),
      composeFile: join(repoRoot, 'apps', 'supervisor', 'compose', 'docker-compose.yml'),
      resources: defaultResources(repoRoot),
    };
  }
  const root = resolve(dir);
  const templates = join(root, 'agent-templates');
  return {
    dir: root,
    serverJs: join(root, 'server', 'main.js'),
    runnerJs: join(root, 'runner', 'main.js'),
    webDir: join(root, 'web'),
    composeFile: join(root, 'docker-compose.yml'),
    resources: {
      hookShPath: join(root, 'hook', 'office-hook.sh'),
      hookMjsPath: join(root, 'hook', 'office-hook.mjs'),
      rolesDir: join(templates, 'roles'),
      skillsDir: join(templates, 'skills'),
      attributionTemplate: join(templates, 'attribution', 'README.md.tmpl'),
      envExample: join(root, '.env.example'),
    },
  };
}
