import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttributionWriteError, writeAttributionProfile } from '../../src/attributionWrite.js';
import { mkSandbox, rmSandbox } from '../helpers.js';

function validProfile() {
  return JSON.stringify({
    kind: 'tagconn.office-profile',
    version: 1,
    tagconnVersion: '0.3.0',
    savedAt: new Date().toISOString(),
    floor: { name: 'Test Floor' },
    heroes: [],
  });
}

function makeProject(): { root: string; project: string } {
  const root = mkSandbox();
  const project = join(root, 'proj');
  mkdirSync(join(project, '.git'), { recursive: true });
  return { root, project };
}

describe('writeAttributionProfile', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('writes .tagconn/office.json inside an allowed project with a .git dir', () => {
    const { root, project } = makeProject();
    sandboxes.push(root);
    const result = writeAttributionProfile({ projectDir: project, content: validProfile(), overwrite: false }, [project]);
    expect(result).toEqual({ written: true, existed: false, relativePath: '.tagconn/office.json' });
    const written = readFileSync(join(project, '.tagconn', 'office.json'), 'utf8');
    expect(JSON.parse(written).floor.name).toBe('Test Floor');
  });

  it('refuses a project outside allowedProjectDirs', () => {
    const { root, project } = makeProject();
    sandboxes.push(root);
    expect(() => writeAttributionProfile({ projectDir: project, content: validProfile(), overwrite: false }, ['/somewhere/else'])).toThrow(AttributionWriteError);
  });

  it('refuses a project with no .git', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    const project = join(root, 'proj-no-git');
    mkdirSync(project, { recursive: true });
    expect(() => writeAttributionProfile({ projectDir: project, content: validProfile(), overwrite: false }, [project])).toThrow(AttributionWriteError);
  });

  it('does not overwrite an existing office.json unless overwrite is true', () => {
    const { root, project } = makeProject();
    sandboxes.push(root);
    mkdirSync(join(project, '.tagconn'), { recursive: true });
    writeFileSync(join(project, '.tagconn', 'office.json'), '{"old":true}');
    const result = writeAttributionProfile({ projectDir: project, content: validProfile(), overwrite: false }, [project]);
    expect(result).toEqual({ written: false, existed: true, relativePath: '.tagconn/office.json' });
    expect(readFileSync(join(project, '.tagconn', 'office.json'), 'utf8')).toBe('{"old":true}');
  });

  it('overwrites when overwrite is true', () => {
    const { root, project } = makeProject();
    sandboxes.push(root);
    mkdirSync(join(project, '.tagconn'), { recursive: true });
    writeFileSync(join(project, '.tagconn', 'office.json'), '{"old":true}');
    const result = writeAttributionProfile({ projectDir: project, content: validProfile(), overwrite: true }, [project]);
    expect(result.written).toBe(true);
    expect(JSON.parse(readFileSync(join(project, '.tagconn', 'office.json'), 'utf8')).floor.name).toBe('Test Floor');
  });

  it('refuses a symlinked .tagconn directory', () => {
    const { root, project } = makeProject();
    sandboxes.push(root);
    const outside = mkSandbox();
    sandboxes.push(outside);
    symlinkSync(outside, join(project, '.tagconn'));
    expect(() => writeAttributionProfile({ projectDir: project, content: validProfile(), overwrite: false }, [project])).toThrow(AttributionWriteError);
  });

  it('refuses a symlinked office.json file', () => {
    const { root, project } = makeProject();
    sandboxes.push(root);
    mkdirSync(join(project, '.tagconn'), { recursive: true });
    const outsideDir = mkSandbox();
    sandboxes.push(outsideDir);
    const outsideFile = join(outsideDir, 'other.json');
    writeFileSync(outsideFile, '{}');
    symlinkSync(outsideFile, join(project, '.tagconn', 'office.json'));
    expect(() => writeAttributionProfile({ projectDir: project, content: validProfile(), overwrite: true }, [project])).toThrow(AttributionWriteError);
  });

  it('re-validates content and refuses invalid JSON', () => {
    const { root, project } = makeProject();
    sandboxes.push(root);
    expect(() => writeAttributionProfile({ projectDir: project, content: 'not json', overwrite: false }, [project])).toThrow(AttributionWriteError);
  });

  it('re-validates content and refuses a profile failing schema (e.g. a host path)', () => {
    const { root, project } = makeProject();
    sandboxes.push(root);
    const bad = JSON.stringify({ kind: 'tagconn.office-profile', version: 1, tagconnVersion: '0.3.0', savedAt: new Date().toISOString(), floor: { name: '/home/alice/leak' }, heroes: [] });
    expect(() => writeAttributionProfile({ projectDir: project, content: bad, overwrite: false }, [project])).toThrow(AttributionWriteError);
  });

  it('does not create anything outside .tagconn/office.json (never .gitignore etc.)', () => {
    const { root, project } = makeProject();
    sandboxes.push(root);
    writeAttributionProfile({ projectDir: project, content: validProfile(), overwrite: false }, [project]);
    expect(existsSync(join(project, '.gitignore'))).toBe(false);
  });
});
