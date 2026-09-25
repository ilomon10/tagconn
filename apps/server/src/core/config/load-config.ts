import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultSettings, SettingsSchema, type Settings, type SettingsPatch } from '@tagconn/shared';
import YAML from 'yaml';
import { deepMerge, expandHome, getPath, isPlainObject, type PlainObject, setPath } from './merge.js';

export interface LoadConfigOptions {
  /** Explicit YAML file; `false` disables file loading. Default: $OFFICE_CONFIG or the first existing candidate. */
  configFile?: string | false;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Extra layer applied after env (not persisted), e.g. from tests. */
  overrides?: SettingsPatch;
}

export interface LoadedConfig {
  /** Validated settings from defaults → YAML → env → overrides (no DB layer yet). */
  base: Settings;
  /** The raw layered object before validation (what DB overrides are merged onto). */
  layered: PlainObject;
  configFile?: string;
}

const CANDIDATES = ['./config/office.yaml', '../../config/office.yaml'];
/** Env vars with an OFFICE_ prefix that are not settings paths. */
const RESERVED_ENV = new Set(['OFFICE_CONFIG', 'OFFICE_TEMPLATES_DIR', 'OFFICE_HOOK_TOKEN']);

export function resolveConfigFile(opts: LoadConfigOptions): string | undefined {
  if (opts.configFile === false) return undefined;
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.configFile ?? opts.env?.OFFICE_CONFIG;
  if (explicit) {
    const path = resolve(cwd, expandHome(explicit));
    if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
    return path;
  }
  return CANDIDATES.map((c) => resolve(cwd, c)).find((p) => existsSync(p));
}

const snakeToCamel = (s: string) => s.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Parses an env string into the type of the default value at that path. */
function coerceEnvValue(raw: string, defaultValue: unknown): unknown {
  if (typeof defaultValue === 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    if (Array.isArray(defaultValue)) return raw.split(',').map((s) => s.trim()).filter(Boolean);
    return raw;
  }
}

/** OFFICE_<SECTION>__<KEY_IN_SNAKE>=value → { section: { keyInSnake: value } }; OFFICE_HOOK_TOKEN → server.hookToken. */
export function envLayer(env: Record<string, string | undefined>): PlainObject {
  const defaults = defaultSettings();
  const out: PlainObject = {};
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || !name.startsWith('OFFICE_') || RESERVED_ENV.has(name)) continue;
    const parts = name.slice('OFFICE_'.length).split('__').filter(Boolean);
    if (parts.length < 2) continue;
    const path = parts.map(snakeToCamel);
    setPath(out, path, coerceEnvValue(raw, getPath(defaults, path)));
  }
  if (env.OFFICE_HOOK_TOKEN !== undefined) setPath(out, ['server', 'hookToken'], env.OFFICE_HOOK_TOKEN);
  return out;
}

/** Expands a leading `~` in paths.* and storage.dbPath. */
export function normalizeSettings(s: Settings): Settings {
  return {
    ...s,
    storage: { ...s.storage, dbPath: s.storage.dbPath === ':memory:' ? s.storage.dbPath : expandHome(s.storage.dbPath) },
    paths: {
      claudeDir: expandHome(s.paths.claudeDir),
      agentsDir: expandHome(s.paths.agentsDir),
      projectsDir: expandHome(s.paths.projectsDir),
    },
  };
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const configFile = resolveConfigFile({ ...opts, env });
  let layered: PlainObject = {};
  if (configFile) {
    const parsed: unknown = YAML.parse(readFileSync(configFile, 'utf8'));
    if (parsed != null && !isPlainObject(parsed)) throw new Error(`Config file must be a YAML mapping: ${configFile}`);
    layered = deepMerge(layered, parsed ?? {});
  }
  layered = deepMerge(layered, envLayer(env));
  if (opts.overrides) layered = deepMerge(layered, opts.overrides as PlainObject);
  const result = SettingsSchema.safeParse(layered);
  if (!result.success) {
    throw new Error(`Invalid configuration${configFile ? ` (${configFile})` : ''}: ${result.error.message}`);
  }
  return { base: normalizeSettings(result.data), layered, configFile };
}
