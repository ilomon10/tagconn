// Tests for the M8 additions to scripts/install.ts: the attribution README
// prompt (default "no"), the attribution.conf/runner.json files, the
// --allow-dir broad-dir warning, and their unit-level helpers. Always
// sandboxed (see CLAUDE.md) - never the real ~/.config/tagconn.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { countGitReposBelow, isBroadAllowDir, isValidRunnerToken } from '../install.ts';
import { createSandbox, runInstall, type Sandbox } from './support/sandbox.ts';

describe('isValidRunnerToken', () => {
  it('accepts 32-128 lowercase hex chars (the shape scripts/install.ts generates)', () => {
    expect(isValidRunnerToken('a'.repeat(32))).toBe(true);
    expect(isValidRunnerToken('f'.repeat(64))).toBe(true);
    expect(isValidRunnerToken('0'.repeat(128))).toBe(true);
  });

  it('rejects too-short, uppercase, or non-hex tokens', () => {
    expect(isValidRunnerToken('a'.repeat(31))).toBe(false);
    expect(isValidRunnerToken('A'.repeat(32))).toBe(false);
    expect(isValidRunnerToken('not-hex')).toBe(false);
    expect(isValidRunnerToken('')).toBe(false);
  });
});

describe('countGitReposBelow / isBroadAllowDir', () => {
  it('counts nested git repos up to the cap, ignoring dotfiles and node_modules', () => {
    const sandbox = createSandbox('tagconn-broaddir-test-');
    const root = join(sandbox.home, 'many-repos');
    for (let i = 0; i < 5; i++) mkdirSync(join(root, `repo-${i}`, '.git'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '.git'), { recursive: true }); // must be ignored
    mkdirSync(join(root, '.hidden', '.git'), { recursive: true }); // must be ignored
    expect(countGitReposBelow(root)).toBe(4); // capped at the default cap (4)
  });

  it('is not broad for a single project directory', () => {
    const sandbox = createSandbox('tagconn-broaddir-test-');
    const dir = join(sandbox.home, 'my-project');
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(isBroadAllowDir(dir)).toBe(false);
  });

  it('is broad for $HOME itself, regardless of contents', () => {
    expect(isBroadAllowDir(homedir())).toBe(true);
  });

  it('is broad for a directory containing more than 3 git repos', () => {
    const sandbox = createSandbox('tagconn-broaddir-test-');
    const root = join(sandbox.home, 'projects');
    for (let i = 0; i < 5; i++) mkdirSync(join(root, `repo-${i}`, '.git'), { recursive: true });
    expect(isBroadAllowDir(root)).toBe(true);
  });
});

describe('installer: attribution README prompt', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  it('defaults to "no" (no README template installed) when --attribution is omitted and stdin is not a TTY', () => {
    const res = runInstall(sandbox);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/defaulting to "no"/);
    expect(res.stdout).toContain('README writes disabled');
    expect(existsSync(join(sandbox.configDir, 'attribution-README.md'))).toBe(false);
    // Import config is still installed by default (safe: writes nothing to the repo).
    expect(existsSync(join(sandbox.configDir, 'attribution.conf'))).toBe(true);
  });

  it('--attribution yes installs the README template', () => {
    const res = runInstall(sandbox, ['--attribution', 'yes']);
    expect(res.status, res.stderr).toBe(0);
    const dest = join(sandbox.configDir, 'attribution-README.md');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toContain('.tagconn');
  });

  it('--attribution no explicitly disables it (and removes a previously installed template)', () => {
    runInstall(sandbox, ['--attribution', 'yes']);
    expect(existsSync(join(sandbox.configDir, 'attribution-README.md'))).toBe(true);
    const res = runInstall(sandbox, ['--attribution', 'no']);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(sandbox.configDir, 'attribution-README.md'))).toBe(false);
  });

  it('rejects an invalid --attribution value (prints an error and falls back to --help, like any bad argument)', () => {
    const res = runInstall(sandbox, ['--attribution', 'maybe']);
    expect(res.stderr).toMatch(/--attribution must be "yes" or "no"/);
    expect(res.stdout).toContain('tagconn installer');
    expect(existsSync(join(sandbox.configDir, 'attribution-README.md'))).toBe(false);
    expect(existsSync(join(sandbox.configDir, 'runner.json'))).toBe(false);
  });

  it('attribution.conf is mode 600 and points at the import endpoint with the hook token', () => {
    runInstall(sandbox);
    const confPath = join(sandbox.configDir, 'attribution.conf');
    const mode = statSync(confPath).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
    const content = readFileSync(confPath, 'utf8');
    expect(content).toMatch(/url = ".*\/api\/attribution\/import"/);
    const envToken = readFileSync(sandbox.envFile, 'utf8').match(/OFFICE_HOOK_TOKEN=([0-9a-f]+)/)?.[1];
    expect(envToken).toBeTruthy();
    expect(content).toContain(`x-office-token: ${envToken}`);
  });
});

describe('installer: runner.json + OFFICE_RUNNER__TOKEN', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  it('generates a runner token and writes runner.json (mode 600) plus OFFICE_RUNNER__TOKEN in .env', () => {
    const res = runInstall(sandbox, ['--attribution', 'no']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('generated new runner token');

    const runnerPath = join(sandbox.configDir, 'runner.json');
    const mode = statSync(runnerPath).mode & 0o777;
    expect(mode.toString(8)).toBe('600');

    const config = JSON.parse(readFileSync(runnerPath, 'utf8'));
    expect(config.token).toMatch(/^[0-9a-f]{32,128}$/);
    expect(config.allowedProjectDirs).toEqual([]);

    const envText = readFileSync(sandbox.envFile, 'utf8');
    const match = envText.match(/OFFICE_RUNNER__TOKEN=([0-9a-f]+)/);
    expect(match?.[1]).toBe(config.token);
  });

  it('reinstalling keeps the same runner token', () => {
    runInstall(sandbox, ['--attribution', 'no']);
    const before = JSON.parse(readFileSync(join(sandbox.configDir, 'runner.json'), 'utf8'));
    const res = runInstall(sandbox, ['--attribution', 'no']);
    expect(res.stdout).toContain('kept existing runner token');
    const after = JSON.parse(readFileSync(join(sandbox.configDir, 'runner.json'), 'utf8'));
    expect(after.token).toBe(before.token);
  });

  it('--allow-dir sets allowedProjectDirs, and a reinstall without the flag keeps the previous dirs', () => {
    const projectDir = join(sandbox.home, 'proj-a');
    mkdirSync(projectDir, { recursive: true });
    runInstall(sandbox, ['--attribution', 'no', '--allow-dir', projectDir]);
    let config = JSON.parse(readFileSync(join(sandbox.configDir, 'runner.json'), 'utf8'));
    expect(config.allowedProjectDirs).toEqual([projectDir]);

    runInstall(sandbox, ['--attribution', 'no']);
    config = JSON.parse(readFileSync(join(sandbox.configDir, 'runner.json'), 'utf8'));
    expect(config.allowedProjectDirs).toEqual([projectDir]);
  });

  it('--allow-dir can be repeated', () => {
    const a = join(sandbox.home, 'proj-a');
    const b = join(sandbox.home, 'proj-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    runInstall(sandbox, ['--attribution', 'no', '--allow-dir', a, '--allow-dir', b]);
    const config = JSON.parse(readFileSync(join(sandbox.configDir, 'runner.json'), 'utf8'));
    expect(config.allowedProjectDirs).toEqual([a, b]);
  });

  it('warns loudly when an allow-dir is $HOME (the sandboxed one)', () => {
    const res = runInstall(sandbox, ['--attribution', 'no', '--allow-dir', sandbox.home]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toMatch(/WARNING: .*looks like a broad parent directory/);
  });

  it('prints the trust-dialog note when at least one dir is allowed', () => {
    const projectDir = join(sandbox.home, 'proj-a');
    mkdirSync(projectDir, { recursive: true });
    const res = runInstall(sandbox, ['--attribution', 'no', '--allow-dir', projectDir]);
    expect(res.stdout).toMatch(/open each allowed project once interactively in claude/);
  });

  it('uninstall removes runner.json', () => {
    runInstall(sandbox, ['--attribution', 'no']);
    expect(existsSync(join(sandbox.configDir, 'runner.json'))).toBe(true);
    runInstall(sandbox, ['--uninstall']);
    expect(existsSync(join(sandbox.configDir, 'runner.json'))).toBe(false);
  });
});
