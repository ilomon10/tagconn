import {
  GUI_IMMUTABLE_SETTINGS,
  RESTART_REQUIRED_SETTINGS,
  SettingsSchema,
  WHOLESALE_REPLACE_SETTINGS,
  type Settings,
  type SettingsPatch,
} from '@tagconn/shared';
import type { EventBus } from '../event-bus/index.js';
import { HttpError } from '../http/errors.js';
import { normalizeSettings } from './load-config.js';
import { collectLeafPaths, deepMergeReplacing, diffKeys, isPlainObject, type PlainObject, pruneByPrefixes, pruneEmpty } from './merge.js';

const MAX_REGEX_LENGTH = 500;

/** Simple heuristic: a parenthesised group containing `+`/`*`, itself followed by `+`, `*` or `{n,}`. */
function hasNestedQuantifier(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '(') continue;
    let depth = 1;
    let j = i + 1;
    for (; j < source.length && depth > 0; j++) {
      if (source[j] === '\\') {
        j++;
        continue;
      }
      if (source[j] === '(') depth++;
      else if (source[j] === ')') depth--;
    }
    if (depth !== 0) continue; // unbalanced; let RegExp construction report the real error
    const close = j - 1;
    if (!/^(\+|\*|\{\d+,\d*\})/.test(source.slice(close + 1))) continue;
    const inner = source.slice(i + 1, close).replace(/\\./g, '');
    if (/[+*]/.test(inner)) return true;
  }
  return false;
}

function assertSafeRegexSource(source: string, where: string): void {
  if (source.length > MAX_REGEX_LENGTH) throw new HttpError(400, `Regex too long in ${where} (max ${MAX_REGEX_LENGTH} chars)`);
  if (hasNestedQuantifier(source)) throw new HttpError(400, `Unsafe regex (nested quantifier) in ${where}`);
}

/** Rejects a patch that touches any key under GUI_IMMUTABLE_SETTINGS (network/paths/secrets/exec). */
function assertNoImmutablePaths(patch: PlainObject): void {
  const touched = [
    ...new Set(collectLeafPaths(patch).filter((leaf) => GUI_IMMUTABLE_SETTINGS.some((p) => leaf === p || leaf.startsWith(`${p}.`)))),
  ];
  if (touched.length > 0) throw new HttpError(400, `Cannot modify immutable settings: ${touched.join(', ')}`);
}

/** Persistence for the runtime (GUI) layer: one JSON value per top-level settings section. */
export interface SettingsOverridesStore {
  load(): PlainObject;
  save(overrides: PlainObject): void;
}

export interface SettingsUpdateResult {
  settings: Settings;
  changed: string[];
  /** Changed keys that only take effect after a restart. */
  restartRequired: string[];
}

export const needsRestart = (key: string) =>
  RESTART_REQUIRED_SETTINGS.some((r) => key === r || key.startsWith(`${r}.`));

/** A cross-module check registered with `SettingsService.addValidator`; throw `HttpError` to reject. */
export type SettingsValidator = (settings: Settings) => void;

/** Rejects regexes that would otherwise blow up later in activity mapping or redaction. */
function assertValidRegexes(s: Settings): void {
  const check = (source: string, where: string, flags = '') => {
    assertSafeRegexSource(source, where);
    try {
      new RegExp(source, flags);
    } catch (err) {
      throw new HttpError(400, `Invalid regex in ${where}: ${(err as Error).message}`);
    }
  };
  s.activity.rules.forEach((r, i) => {
    check(`^(?:${r.tool})$`, `activity.rules[${i}].tool`);
    if (r.input) check(r.input, `activity.rules[${i}].input`);
  });
  s.ingest.redactPatterns.forEach((p, i) => check(p, `ingest.redactPatterns[${i}]`, 'gi'));
}

export class SettingsService {
  private overrides: PlainObject = {};
  private current: Settings;
  /** Registered by other modules (e.g. `layouts`, to check `office.defaultLayoutId` against its
   * repository) so core/config never imports another module back. Only run from `update()`/`reset()`
   * (never the constructor's initial load), so a module registering one during its own boot can't
   * retroactively invalidate whatever was already computed and crash startup. */
  private validators: SettingsValidator[] = [];

  /**
   * @param layered defaults → YAML → env → boot overrides, unvalidated (DB overrides merge onto this).
   */
  constructor(
    private readonly layered: PlainObject,
    private readonly store: SettingsOverridesStore,
    private readonly bus: EventBus,
    onInvalidOverrides: (err: unknown) => void = () => {},
  ) {
    this.current = this.compute({});
    const rawStored = store.load();
    // Drop any GUI-immutable keys that were persisted before this check existed.
    const stored = pruneByPrefixes(rawStored, GUI_IMMUTABLE_SETTINGS);
    try {
      this.current = this.compute(stored);
      this.overrides = stored;
      if (JSON.stringify(stored) !== JSON.stringify(rawStored)) store.save(stored);
    } catch (err) {
      onInvalidOverrides(err);
    }
  }

  get(): Settings {
    return this.current;
  }

  /** Current runtime overrides (the DB layer only). */
  getOverrides(): PlainObject {
    return structuredClone(this.overrides);
  }

  addValidator(validator: SettingsValidator): void {
    this.validators.push(validator);
  }

  update(patch: SettingsPatch): SettingsUpdateResult {
    if (!isPlainObject(patch)) throw new HttpError(400, 'Settings patch must be an object');
    assertNoImmutablePaths(patch as PlainObject);
    return this.apply(pruneEmpty(deepMergeReplacing(this.overrides, patch as PlainObject, WHOLESALE_REPLACE_SETTINGS)));
  }

  reset(): SettingsUpdateResult {
    return this.apply({});
  }

  private apply(nextOverrides: PlainObject): SettingsUpdateResult {
    const next = this.compute(nextOverrides);
    for (const validate of this.validators) validate(next);
    const changed = diffKeys(this.current, next);
    this.store.save(nextOverrides);
    this.overrides = nextOverrides;
    this.current = next;
    if (changed.length > 0) this.bus.emit('settings.changed', { settings: next, changed });
    return { settings: next, changed, restartRequired: changed.filter(needsRestart) };
  }

  private compute(overrides: PlainObject): Settings {
    const result = SettingsSchema.safeParse(deepMergeReplacing(this.layered, overrides, WHOLESALE_REPLACE_SETTINGS));
    if (!result.success) throw new HttpError(400, `Invalid settings: ${result.error.message}`, result.error.issues);
    const settings = normalizeSettings(result.data);
    assertValidRegexes(settings);
    return settings;
  }
}
