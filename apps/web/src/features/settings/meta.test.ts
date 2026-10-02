import { describe, expect, it } from 'vitest';
import { defaultSettings, GUI_IMMUTABLE_SETTINGS, type Settings } from '@tagconn/shared';
import { ENUM_OPTIONS, HIDDEN_SETTINGS, KEY_HINTS, NUMBER_STEP, SECTION_LABELS, envVarName, numberBounds } from './meta';

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
const M13_SECTIONS = ['labels', 'life', 'npcs', 'alerts', 'audio'] as const;
const flatten = (prefix: string, o: Record<string, unknown>): string[] =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flatten(`${prefix}.${k}`, v as Record<string, unknown>) : [`${prefix}.${k}`]));
const M14_LEAVES = [...flatten('progression', settings.progression), ...flatten('battle', settings.battle)];
const nestedLeafPaths: string[] = Object.keys(settings.office.shaders)
  .map((k) => `office.shaders.${k}`)
  // M16: `office.lighting` is a fixed-shape object whose keys carry their own hints.
  .concat(Object.keys(settings.office.lighting).map((k) => `office.lighting.${k}`))
  // M17: `office.camera` and `office.depth` are fixed-shape objects whose keys carry their own hints.
  .concat(Object.keys(settings.office.camera).map((k) => `office.camera.${k}`))
  .concat(Object.keys(settings.office.depth).map((k) => `office.depth.${k}`))
  // M12: `office.drama` is a fixed-shape object whose keys carry their own hints.
  .concat(Object.keys(settings.office.drama).map((k) => `office.drama.${k}`))
  // M13: fixed-shape sections with their own hints.
  .concat(M13_SECTIONS.flatMap((s) => Object.keys(settings.office[s]).map((k) => `office.${s}.${k}`)))
  // M14: progression and battle leaves, including the fixed-shape xpWeights / items groups.
  .concat(M14_LEAVES);

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

  it('covers every progression and battle leaf (M14)', () => {
    expect(M14_LEAVES.filter((path) => !KEY_HINTS[path])).toEqual([]);
  });

  it('covers the M15 dual-grid switch', () => {
    expect(leafPaths).toContain('office.dualGrid');
    expect(KEY_HINTS['office.dualGrid']).toBeTruthy();
  });

  it('covers every office.lighting key (M16)', () => {
    expect(Object.keys(settings.office.lighting).filter((k) => !KEY_HINTS[`office.lighting.${k}`])).toEqual([]);
    expect(ENUM_OPTIONS['office.lighting.cycle']).toEqual(['host-clock', 'fixed', 'accelerated']);
    expect(numberBounds('office.lighting.sunStepMinutes')).toEqual({ min: 1, max: 120, int: true });
  });

  it('covers every office.camera and office.depth key (M17)', () => {
    const keys = [
      ...Object.keys(settings.office.camera).map((k) => `office.camera.${k}`),
      ...Object.keys(settings.office.depth).map((k) => `office.depth.${k}`),
    ];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !KEY_HINTS[k])).toEqual([]);
    expect(ENUM_OPTIONS['office.camera.follow']).toEqual(['manual', 'selected']);
    expect(numberBounds('office.camera.deadzone')).toEqual({ min: 0, max: 0.8, int: false });
    expect(numberBounds('office.depth.maxSprites')).toEqual({ min: 0, max: 5000, int: true });
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

describe('numberBounds', () => {
  it('has bounds for every numeric M13 field and a step for the volume', () => {
    for (const sec of M13_SECTIONS)
      for (const [k, v] of Object.entries(settings.office[sec])) if (typeof v === 'number') expect(numberBounds(`office.${sec}.${k}`).min, `${sec}.${k}`).toBeDefined();
    expect(NUMBER_STEP['office.audio.volume']).toBe(0.05);
    expect(ENUM_OPTIONS['office.labels.showTask']).toEqual(['focus', 'always', 'never']);
  });
  it('has bounds for every numeric M14 field and the fine steps', () => {
    for (const path of M14_LEAVES) {
      const v = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], settings);
      if (typeof v === 'number') expect(numberBounds(path).min, path).toBeDefined();
    }
    expect(numberBounds('battle.items.coffee')).toEqual({ min: 0, max: 9, int: true });
    expect(numberBounds('progression.xpWeights.input')).toEqual({ min: 0, max: 10, int: false });
    for (const k of ['progression.xpWeights.output', 'battle.offerChance', 'battle.lootChance', 'battle.difficulty', 'battle.xpScale']) expect(NUMBER_STEP[k], k).toBe(0.05);
    expect(NUMBER_STEP['progression.levelExponent']).toBe(0.1);
  });
  it('reads min/max/int from the schema at nested depth', () => {
    expect(numberBounds('office.drama.idleChatSec')).toEqual({ min: 5, max: 3600, int: false });
    expect(numberBounds('office.drama.streakTools')).toEqual({ min: 2, max: 100, int: true });
  });
  it('is empty for non-numbers and unknown paths', () => {
    expect(numberBounds('office.drama.enabled')).toEqual({ int: false });
    expect(numberBounds('office.nope.x')).toEqual({ int: false });
  });
  it('has bounds for every numeric office.drama field', () => {
    for (const [k, v] of Object.entries(settings.office.drama)) if (typeof v === 'number') expect(numberBounds(`office.drama.${k}`).min, k).toBeDefined();
  });
});
