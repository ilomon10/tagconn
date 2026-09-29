import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultExec, type ExecFn, type SecretOptions } from './secrets.ts';

/** packages/setup/src -> the repo root. Only valid in a checkout; the packaged app passes `resources`. */
export const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where the files the installer copies live. Defaults to the repo checkout; the desktop bundle overrides them. */
export interface SetupResources {
  hookShPath: string;
  hookMjsPath: string;
  rolesDir: string;
  skillsDir: string;
  attributionTemplate: string;
  /** .env.example, used to seed the repo .env (CLI only). */
  envExample: string;
}

export function defaultResources(repoRoot: string = defaultRepoRoot): SetupResources {
  return {
    hookShPath: join(repoRoot, 'packages', 'hook', 'office-hook.sh'),
    hookMjsPath: join(repoRoot, 'packages', 'hook', 'office-hook.mjs'),
    rolesDir: join(repoRoot, 'packages', 'agent-templates', 'roles'),
    skillsDir: join(repoRoot, 'packages', 'agent-templates', 'skills'),
    attributionTemplate: join(repoRoot, 'packages', 'agent-templates', 'attribution', 'README.md.tmpl'),
    envExample: join(repoRoot, '.env.example'),
  };
}

/** Everything the orchestration needs from its environment. All of it is injectable for tests. */
export interface SetupContext {
  log: (msg: string) => void;
  /** Goes to stderr in the CLIs. */
  warn: (msg: string) => void;
  dryRun: boolean;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exec: ExecFn;
  resources: SetupResources;
  /** Files written or removed (non-dry-run), for InstallResult.changed. */
  changed: string[];
}

export function createContext(partial: Partial<SetupContext> = {}): SetupContext {
  return {
    log: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    dryRun: false,
    platform: process.platform,
    env: process.env,
    exec: defaultExec,
    resources: defaultResources(),
    changed: [],
    ...partial,
  };
}

export function secretOptions(ctx: SetupContext): SecretOptions {
  return { platform: ctx.platform, env: ctx.env, exec: ctx.exec };
}

/** Records a changed path once. */
export function touch(ctx: SetupContext, path: string): void {
  if (!ctx.changed.includes(path)) ctx.changed.push(path);
}
