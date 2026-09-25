import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveHookTranscriptPath, subagentTranscriptPath } from '../transcripts.paths.js';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'transcript-paths-'));

describe('resolveHookTranscriptPath', () => {
  it('uses the reported path as-is when it exists on this filesystem (no Docker split)', () => {
    const projectsDir = tmp();
    const file = join(projectsDir, 'proj-slug', 'session.jsonl');
    mkdirSync(join(projectsDir, 'proj-slug'), { recursive: true });
    writeFileSync(file, '');
    expect(resolveHookTranscriptPath(file, projectsDir)).toBe(file);
  });

  it('maps a host-style path (not present locally) onto projectsDir via the /.claude/projects/ marker', () => {
    const projectsDir = tmp();
    const local = join(projectsDir, 'proj-slug', 'session.jsonl');
    mkdirSync(join(projectsDir, 'proj-slug'), { recursive: true });
    writeFileSync(local, '');
    const hostPath = '/home/someone/.claude/projects/proj-slug/session.jsonl';
    expect(resolveHookTranscriptPath(hostPath, projectsDir)).toBe(local);
  });

  it('also maps via the bare /projects/ marker (Docker mount without .claude in between)', () => {
    const projectsDir = tmp();
    const local = join(projectsDir, 'proj-slug', 'session.jsonl');
    mkdirSync(join(projectsDir, 'proj-slug'), { recursive: true });
    writeFileSync(local, '');
    expect(resolveHookTranscriptPath('/claude/projects/proj-slug/session.jsonl', projectsDir)).toBe(local);
  });

  it('rejects a mapped path that escapes projectsDir via traversal', () => {
    const projectsDir = tmp();
    // Maps to <parent of projectsDir>/secret.jsonl, outside projectsDir, whether or not it exists.
    const hostPath = '/home/someone/.claude/projects/../secret.jsonl';
    expect(resolveHookTranscriptPath(hostPath, projectsDir)).toBeUndefined();
  });

  it('rejects a non-.jsonl file', () => {
    const projectsDir = tmp();
    expect(resolveHookTranscriptPath('/home/someone/.claude/projects/proj-slug/session.json', projectsDir)).toBeUndefined();
    expect(resolveHookTranscriptPath(undefined, projectsDir)).toBeUndefined();
  });

  it('rejects a path with no projects-dir marker and nothing at that location', () => {
    const projectsDir = tmp();
    expect(resolveHookTranscriptPath('/some/unrelated/place/file.jsonl', projectsDir)).toBeUndefined();
  });

  it('rejects when projectsDir itself does not exist', () => {
    expect(resolveHookTranscriptPath('/home/someone/.claude/projects/proj-slug/session.jsonl', '/does/not/exist')).toBeUndefined();
  });
});

describe('subagentTranscriptPath', () => {
  it('derives <main dir>/<sessionId>/subagents/agent-<agentId>.jsonl, contained in projectsDir', () => {
    const projectsDir = tmp();
    mkdirSync(join(projectsDir, 'proj-slug'), { recursive: true });
    const mainPath = join(projectsDir, 'proj-slug', 'sess-1.jsonl');
    const result = subagentTranscriptPath(mainPath, 'sess-1', 'agent-abc', projectsDir);
    expect(result).toBe(join(projectsDir, 'proj-slug', 'sess-1', 'subagents', 'agent-agent-abc.jsonl'));
  });

  it('rejects a derived path that would escape projectsDir (crafted sessionId)', () => {
    const projectsDir = tmp();
    mkdirSync(join(projectsDir, 'proj-slug'), { recursive: true });
    const mainPath = join(projectsDir, 'proj-slug', 'sess-1.jsonl');
    const result = subagentTranscriptPath(mainPath, '../../../../etc', 'agent-abc', projectsDir);
    expect(result).toBeUndefined();
  });
});
