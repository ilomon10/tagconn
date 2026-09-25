import { describe, expect, it } from 'vitest';
import { questSpawnSpec, receptionistSpawnSpec, wrapWithBwrap, wrapWithSystemdScope } from '../../src/spawnPlan.js';
import type { BwrapPaths } from '../../src/bwrap.js';

describe('wrapWithSystemdScope', () => {
  it('produces a deterministic --unit name derived from the runId, usable to stop() later', () => {
    const wrapped = wrapWithSystemdScope(['claude', '-p'], 'run-abc', { memoryMax: '4G', tasksMax: 512 });
    expect(wrapped.command).toBe('systemd-run');
    expect(wrapped.args).toContain('--unit=tagconn-quest-run-abc');
    expect(wrapped.scopeUnitName).toBe('tagconn-quest-run-abc.scope');
  });

  it('sets KillMode=control-group so a setsid grandchild is still reachable (V13)', () => {
    const wrapped = wrapWithSystemdScope(['claude'], 'r1', { memoryMax: '2G', tasksMax: 100 });
    expect(wrapped.args.join(' ')).toContain('-p KillMode=control-group');
    expect(wrapped.args.join(' ')).toContain('-p MemoryMax=2G');
    expect(wrapped.args.join(' ')).toContain('-p TasksMax=100');
  });

  it('appends the claude argv after --', () => {
    const wrapped = wrapWithSystemdScope(['claude', '-p', '--model=sonnet'], 'r1', { memoryMax: '1G', tasksMax: 10 });
    const dashIdx = wrapped.args.indexOf('--');
    expect(wrapped.args.slice(dashIdx + 1)).toEqual(['claude', '-p', '--model=sonnet']);
  });
});

describe('wrapWithBwrap', () => {
  const paths: BwrapPaths = {
    home: '/home/test',
    claudeBinDir: '/opt/claude',
    claudeDir: '/home/test/.claude',
    transcriptDir: '/home/test/.claude/projects/-home-test-p',
    credentialsPath: '/home/test/.claude/.credentials.json',
    disposableClaudeJsonPath: '/state/runs/r1/claude.json',
    bindDir: '/home/test/p',
    cwd: '/home/test/p',
  };

  it('appends the claude argv after -- and uses the bwrap command', () => {
    const wrapped = wrapWithBwrap(['claude', '-p'], paths, { bin: true, lib: true, lib64: true });
    expect(wrapped.command).toBe('bwrap');
    expect(wrapped.args.at(-2)).toBe('claude');
    expect(wrapped.args.at(-1)).toBe('-p');
    expect(wrapped.args).not.toContain('bwrap'); // the literal command name isn't duplicated into args
  });
});

describe('questSpawnSpec', () => {
  it('wraps with systemd-scope when requiresScope is true', () => {
    const spec = questSpawnSpec(['claude', '-p'], 'r1', '/proj', { PATH: '/bin' }, true, { memoryMax: '4G', tasksMax: 512 });
    expect(spec.wrapper).toBe('systemd-scope');
    expect(spec.command).toBe('systemd-run');
    expect(spec.scopeUnitName).toBe('tagconn-quest-r1.scope');
  });

  it('spawns claude directly (plain) when requiresScope is false', () => {
    const spec = questSpawnSpec(['claude', '-p', '--model=sonnet'], 'r1', '/proj', { PATH: '/bin' }, false, { memoryMax: '4G', tasksMax: 512 });
    expect(spec.wrapper).toBe('plain');
    expect(spec.command).toBe('claude');
    expect(spec.args).toEqual(['-p', '--model=sonnet']);
  });
});

describe('receptionistSpawnSpec', () => {
  const paths: BwrapPaths = {
    home: '/home/test',
    claudeBinDir: '/opt/claude',
    claudeDir: '/home/test/.claude',
    transcriptDir: '/home/test/.claude/projects/-home-test-p',
    credentialsPath: '/home/test/.claude/.credentials.json',
    disposableClaudeJsonPath: '/state/runs/r1/claude.json',
    bindDir: '/home/test/p',
    cwd: '/home/test/p',
  };

  it('wraps with bwrap when sandboxed', () => {
    const spec = receptionistSpawnSpec(['claude', '-p'], '/home/test/p', {}, true, paths, { bin: true, lib: true, lib64: true });
    expect(spec.wrapper).toBe('bwrap');
    expect(spec.command).toBe('bwrap');
  });

  it('falls back to plain when not sandboxed', () => {
    const spec = receptionistSpawnSpec(['claude', '-p'], '/home/test/p', {}, false);
    expect(spec.wrapper).toBe('plain');
    expect(spec.command).toBe('claude');
  });
});
