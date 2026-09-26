import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditUserSettings } from '../../src/userSettingsAudit.js';
import { mkSandbox, rmSandbox } from '../helpers.js';

describe('auditUserSettings', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  function writeSettings(content: unknown): string {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = join(dir, 'settings.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it('reports nothing when the file does not exist', () => {
    const result = auditUserSettings(join(mkSandbox(), 'nope', 'settings.json'));
    expect(result.findings).toEqual([]);
    expect(result.bareWebFetchAllowed).toBe(false);
  });

  it('reports nothing for a clean settings file', () => {
    const path = writeSettings({ permissions: { allow: ['Read', 'Edit(./**)'] } });
    expect(auditUserSettings(path).findings).toEqual([]);
  });

  it('fails safe (no findings, never throws) on invalid JSON', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = join(dir, 'settings.json');
    writeFileSync(path, 'not json');
    expect(() => auditUserSettings(path)).not.toThrow();
    expect(auditUserSettings(path).findings).toEqual([]);
  });

  it('flags a Bash allow rule', () => {
    const path = writeSettings({ permissions: { allow: ['Bash(echo:*)'] } });
    expect(auditUserSettings(path).findings).toContain('a Bash allow rule');
  });

  it('flags any WebFetch allow rule, and separately flags a BARE one', () => {
    const scoped = writeSettings({ permissions: { allow: ['WebFetch(domain:example.com)'] } });
    expect(auditUserSettings(scoped).findings).toContain('a WebFetch allow rule');
    expect(auditUserSettings(scoped).bareWebFetchAllowed).toBe(false);

    const bare = writeSettings({ permissions: { allow: ['WebFetch'] } });
    expect(auditUserSettings(bare).findings).toContain('a WebFetch allow rule');
    expect(auditUserSettings(bare).bareWebFetchAllowed).toBe(true);
  });

  it('flags an mcp__ allow rule', () => {
    const path = writeSettings({ permissions: { allow: ['mcp__somemcp__someTool'] } });
    expect(auditUserSettings(path).findings).toContain('an mcp__ allow rule');
  });

  it('flags additionalDirectories', () => {
    const path = writeSettings({ permissions: { additionalDirectories: ['/tmp/other'] } });
    expect(auditUserSettings(path).findings).toContain('additionalDirectories');
  });

  it('flags a non-default defaultMode', () => {
    const path = writeSettings({ permissions: { defaultMode: 'bypassPermissions' } });
    expect(auditUserSettings(path).findings).toContain('defaultMode=bypassPermissions');
  });

  it('does not flag defaultMode "default"', () => {
    const path = writeSettings({ permissions: { defaultMode: 'default' } });
    expect(auditUserSettings(path).findings).toEqual([]);
  });
});
