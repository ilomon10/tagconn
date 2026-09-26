import { describe, expect, it } from 'vitest';
import { defaultSettings, GUI_IMMUTABLE_SETTINGS, type Settings } from '@tagconn/shared';
import { HIDDEN_SETTINGS, KEY_HINTS, SECTION_LABELS, envVarName } from './meta';

const settings = defaultSettings();
const sections = Object.keys(settings) as (keyof Settings)[];
const hidden: ReadonlySet<string> = new Set(HIDDEN_SETTINGS);

/** Every leaf path the generic per-key form would render (mirrors `SectionPanel`'s filter: skip
 *  `HIDDEN_SETTINGS`, and `activity` gets its own `RulesTable` rather than per-key rows). A key that
 *  is `.optional()` with no default (currently only `runner.maxTurns`) is absent from a *parsed*
 *  settings object entirely, so it's added back by hand rather than missed by this enumeration. */
const OPTIONAL_NO_DEFAULT_KEYS = ['runner.maxTurns'] as const;
const leafPaths: string[] = sections
  .filter((s) => s !== 'activity')
  .flatMap((s) => Object.keys(settings[s] as Record<string, unknown>).map((k) => `${s}.${k}`))
  .concat(OPTIONAL_NO_DEFAULT_KEYS)
  .filter((path) => !hidden.has(path));

/**
 * `office.shaders` (M8 8o) is hidden from the generic form (it's a fixed-shape nested object — see
 * `HIDDEN_SETTINGS`'s comment) but still gets its own inline group (`ShaderEffectsGroup`) whose Fields
 * read `KEY_HINTS['office.shaders.<key>']` the same way the generic form does, so those nested paths
 * need covering too even though `leafPaths` above stops one level short of them. Unlike `office.zones`/
 * `agents.typeToRole`/`heroes.namePools` (record types — arbitrary, user-chosen keys, not a fixed
 * schema shape), `shaders`'s keys are fixed by the schema, so — unlike a record — every one of them can
 * and should have its own hint.
 */
const nestedLeafPaths: string[] = Object.keys(settings.office.shaders).map((k) => `office.shaders.${k}`);

describe('SECTION_LABELS', () => {
  it('has a title and hint for every settings section', () => {
    for (const section of sections) {
      expect(SECTION_LABELS[section]?.title, section).toBeTruthy();
      expect(SECTION_LABELS[section]?.hint, section).toBeTruthy();
    }
  });
});

describe('KEY_HINTS', () => {
  // The new M8 sections (7 in the design doc: runner, receptionist, auth, attribution) — every one of
  // their keys must explain itself, since most of the section is read-only and the hint is the only
  // place a "why" can go.
  const newSections = new Set<keyof Settings>(['runner', 'receptionist', 'auth', 'attribution']);

  it('covers every key of every new M8 section', () => {
    const missing = leafPaths.filter((path) => newSections.has(path.split('.')[0] as keyof Settings) && !KEY_HINTS[path]);
    expect(missing).toEqual([]);
  });

  it('covers every office.shaders key (M8 8o)', () => {
    const missing = nestedLeafPaths.filter((path) => !KEY_HINTS[path]);
    expect(missing).toEqual([]);
  });

  it('has no hint for a path that does not exist', () => {
    const known = new Set([...leafPaths, ...nestedLeafPaths]);
    const stale = Object.keys(KEY_HINTS).filter((path) => !known.has(path));
    expect(stale).toEqual([]);
  });
});

describe('envVarName', () => {
  it('matches the exact OFFICE_<SECTION>__<KEY_SNAKE> the server env layer reads', () => {
    // The worked example from CLAUDE.md.
    expect(envVarName('runner.allowedProjectDirs')).toBe('OFFICE_RUNNER__ALLOWED_PROJECT_DIRS');
    expect(envVarName('receptionist.webFetchAllowDomains')).toBe('OFFICE_RECEPTIONIST__WEB_FETCH_ALLOW_DOMAINS');
    expect(envVarName('auth.sessionIdleHours')).toBe('OFFICE_AUTH__SESSION_IDLE_HOURS');
    expect(envVarName('attribution.maxProfileBytes')).toBe('OFFICE_ATTRIBUTION__MAX_PROFILE_BYTES');
    expect(envVarName('server.hookToken')).toBe('OFFICE_SERVER__HOOK_TOKEN');
  });
});

describe('GUI-immutable coverage', () => {
  it('every key under a GUI-immutable section prefix has a working envVarName', () => {
    const immutablePrefixes = GUI_IMMUTABLE_SETTINGS as readonly string[];
    const immutableLeaves = leafPaths.filter((path) => immutablePrefixes.some((p) => path === p || path.startsWith(`${p}.`)));
    // Sanity: this must actually pick up something from every whole-section prefix (runner, auth), not
    // silently match nothing because of a typo'd prefix.
    expect(immutableLeaves.some((p) => p.startsWith('runner.'))).toBe(true);
    expect(immutableLeaves.some((p) => p.startsWith('auth.'))).toBe(true);
    expect(immutableLeaves.some((p) => p.startsWith('receptionist.'))).toBe(true);
    for (const path of immutableLeaves) {
      expect(envVarName(path)).toMatch(/^OFFICE_[A-Z0-9_]+__[A-Z0-9_]+$/);
    }
  });
});
