import { describe, expect, it } from 'vitest';
import { ACTIVITIES, ROOM_TYPES, ZONES, type Activity } from '@tagconn/shared';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import type { ThemeDefinition } from '../types';

const THEMES: [string, ThemeDefinition][] = [
  ['modern', modernTheme],
  ['guild', guildTheme],
];

// The builtin role names from `apps/web/src/lib/defaultRoles.ts` (owned by 7e), duplicated here
// rather than imported so this test stays independent of that file's shape.
const BUILTIN_ROLE_NAMES = [
  'pm',
  'analyst',
  'architect',
  'developer',
  'qa-engineer',
  'code-reviewer',
  'security-engineer',
  'devops-engineer',
  'tech-writer',
];

describe.each(THEMES)('%s theme data', (_name, theme) => {
  it('has a zone name for every Zone (exhaustive by type, checked again at runtime)', () => {
    for (const zone of ZONES) expect(theme.zoneNames[zone]).toBeTruthy();
  });

  it('has a room name for every RoomType', () => {
    for (const type of ROOM_TYPES) expect(theme.roomNames[type]).toBeTruthy();
  });

  it('has floor colours for every RoomType and corridor', () => {
    for (const type of [...ROOM_TYPES, 'corridor'] as const) {
      expect(theme.palette.floorBase[type]).toBeTypeOf('number');
      expect(theme.palette.floorAccent[type]).toBeTypeOf('number');
    }
  });

  it('has a title for every builtin role name (identity for modern, guild flavour for guild)', () => {
    for (const name of BUILTIN_ROLE_NAMES) expect(theme.roleTitles[name], name).toBeTruthy();
  });

  it('falls back to a `default` costume for unknown roles', () => {
    expect(theme.costumes.default).toBeDefined();
    expect(theme.costumes['totally-unknown-role']).toBeUndefined();
  });

  it('declares activityFx only with values from the allowed set', () => {
    const allowed = new Set(['sparkles', 'bubbles', 'rune', 'channel', 'none']);
    for (const kind of Object.values(theme.activityFx ?? {})) expect(allowed.has(kind as string)).toBe(true);
  });

  it('produces a non-empty floor label', () => {
    expect(theme.floorLabel(0, 'tagconn').length).toBeGreaterThan(0);
    expect(theme.floorLabel(3, 'api-server')).toContain('4');
  });
});

describe('guild theme flavour', () => {
  it('matches the role table in docs/design/guild-hall.md section 3', () => {
    expect(guildTheme.roleTitles.pm).toBe('Guild Master');
    expect(guildTheme.roleTitles.analyst).toBe('Oracle');
    expect(guildTheme.roleTitles.architect).toBe('Archmage');
    expect(guildTheme.roleTitles.developer).toBe('Artificer');
    expect(guildTheme.roleTitles['qa-engineer']).toBe('Alchemist');
    expect(guildTheme.roleTitles['code-reviewer']).toBe('Scribe');
    expect(guildTheme.roleTitles['security-engineer']).toBe('Paladin');
    expect(guildTheme.roleTitles['devops-engineer']).toBe('Blacksmith');
    expect(guildTheme.roleTitles['tech-writer']).toBe('Bard');
  });

  it('gives every builtin role a costume with at least one guild-specific field', () => {
    for (const name of BUILTIN_ROLE_NAMES) {
      const costume = guildTheme.costumes[name];
      expect(costume, name).toBeDefined();
      expect(Object.keys(costume ?? {}).length, name).toBeGreaterThan(0);
    }
  });

  it('gives the developer and alchemist goggles', () => {
    expect(guildTheme.costumes.developer?.goggles).toBe(true);
    expect(guildTheme.costumes['qa-engineer']?.goggles).toBe(true);
  });

  it('has a verb for every Activity', () => {
    for (const a of ACTIVITIES as readonly Activity[]) expect(guildTheme.activityVerbs[a], a).toBeTruthy();
  });

  it('renders night torches and runes brighter (glowAtNight)', () => {
    expect(guildTheme.lighting.glowAtNight).toBe(true);
  });
});

describe('modern theme is a plain, identity-titled port', () => {
  it('has no activity verbs or fx', () => {
    expect(Object.keys(modernTheme.activityVerbs)).toHaveLength(0);
    expect(Object.keys(modernTheme.activityFx ?? {})).toHaveLength(0);
  });

  it('does not add costume art beyond an empty default', () => {
    for (const name of BUILTIN_ROLE_NAMES) {
      const costume = modernTheme.costumes[name] ?? modernTheme.costumes.default;
      expect(costume?.hat ?? 'none').toBe('none');
      expect(costume?.staff ?? 'none').toBe('none');
    }
  });

  it('keeps the pre-M7 zone labels', () => {
    expect(modernTheme.zoneNames.desks).toBe('Dev Desks');
    expect(modernTheme.zoneNames['pm-office']).toBe('PM Office');
    expect(modernTheme.zoneNames['qa-lab']).toBe('QA Lab');
  });
});
