// Tests for the M8 additions to scripts/install.ts: the attribution README
// prompt (default "no"), the attribution.conf/runner.json files, the
// --allow-dir broad-dir warning, and their unit-level helpers. Always
// sandboxed (see CLAUDE.md) - never the real ~/.config/tagconn.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { countGitReposBelow, isBroadAllowDir, isValidRunnerToken } from '../install.ts';
import { createSandbox, runInstall, type Sandbox } from './support/sandbox.ts';

/** Temporarily overrides $HOME for the current (in-process) test only - never touches real files. */
function withFakeHome<T>(fakeHome: string, fn: () => T): T {
  const original = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

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

  it('is broad for an ancestor of $HOME, not just $HOME itself (SC4 L5)', () => {
    const sandbox = createSandbox('tagconn-broaddir-test-');
    const fakeHome = join(sandbox.home, 'nested', 'home');
    mkdirSync(fakeHome, { recursive: true });
    withFakeHome(fakeHome, () => {
      expect(isBroadAllowDir(join(sandbox.home, 'nested'))).toBe(true); // one level up from $HOME
      expect(isBroadAllowDir(sandbox.home)).toBe(true); // further up still
    });
  });

  it('is not fooled by a trailing slash on the allow-dir (SC4 L1/L5 string-compare bypass)', () => {
    const sandbox = createSandbox('tagconn-broaddir-test-');
    const fakeHome = join(sandbox.home, 'real-home');
    mkdirSync(fakeHome, { recursive: true });
    withFakeHome(fakeHome, () => {
      expect(isBroadAllowDir(`${fakeHome}/`)).toBe(true);
    });
  });

  it('is broad for a symlink that resolves into $HOME (SC4 L5)', () => {
    const sandbox = createSandbox('tagconn-broaddir-test-');
    const fakeHome = join(sandbox.home, 'real-home-2');
    mkdirSync(fakeHome, { recursive: true });
    const link = join(sandbox.home, 'link-to-home');
    symlinkSync(fakeHome, link);
    withFakeHome(fakeHome, () => {
      expect(isBroadAllowDir(link)).toBe(true);
    });
  });

  it('is NOT broad for an unrelated sibling directory next to a fake $HOME', () => {
    const sandbox = createSandbox('tagconn-broaddir-test-');
    const fakeHome = join(sandbox.home, 'real-home-3');
    const sibling = join(sandbox.home, 'unrelated-project');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(sibling, '.git'), { recursive: true });
    withFakeHome(fakeHome, () => {
      expect(isBroadAllowDir(sibling)).toBe(false);
    });
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

  it('writes secret files atomically: no leftover .tagconn-tmp-* files after install (SC4 L4)', () => {
    runInstall(sandbox, ['--attribution', 'yes']);
    const entries = readdirSync(sandbox.configDir);
    const tmpFiles = entries.filter((e) => e.includes('.tagconn-tmp-'));
    expect(tmpFiles).toEqual([]);
    // And the real files came through with the right content/mode, i.e. the rename succeeded.
    expect(existsSync(join(sandbox.configDir, 'runner.json'))).toBe(true);
    expect((statSync(join(sandbox.configDir, 'runner.json')).mode & 0o777).toString(8)).toBe('600');
  });

  it('a reinstall (overwriting an existing runner.json) still leaves it mode 600 with valid JSON (SC4 L4)', () => {
    runInstall(sandbox, ['--attribution', 'no']);
    runInstall(sandbox, ['--attribution', 'no']); // second write over the same path
    const runnerPath = join(sandbox.configDir, 'runner.json');
    expect((statSync(runnerPath).mode & 0o777).toString(8)).toBe('600');
    expect(() => JSON.parse(readFileSync(runnerPath, 'utf8'))).not.toThrow();
  });
});

describe('installer: does not chmod a pre-existing, non-tagconn config dir (SC4 INFO)', () => {
  it('leaves an existing --config-dir\'s mode alone when its basename is not "tagconn" (e.g. `--config-dir ~`)', () => {
    const sandbox = createSandbox();
    // A directory that already existed before this install run, is NOT named "tagconn", and
    // must therefore never have its mode changed - simulating a misdirected `--config-dir`
    // pointed at something like the user's home directory.
    const notTagconn = join(sandbox.home, 'pre-existing-dir');
    mkdirSync(notTagconn, { recursive: true, mode: 0o755 });
    expect((statSync(notTagconn).mode & 0o777).toString(8)).toBe('755');

    runInstall(sandbox, ['--attribution', 'no', '--config-dir', notTagconn]);

    expect((statSync(notTagconn).mode & 0o777).toString(8)).toBe('755');
    // Sanity: the install still worked (wrote its files into that dir).
    expect(existsSync(join(notTagconn, 'runner.json'))).toBe(true);
  });

  it('still normalizes the mode of a dir it creates itself, or one literally named "tagconn"', () => {
    const sandbox = createSandbox();
    // sandbox.configDir (…/.config/tagconn) does not exist yet: the installer creates it, so
    // 700 is expected (this is the existing, already-covered happy path - asserted again here
    // for contrast with the "pre-existing, differently-named dir" case above).
    runInstall(sandbox, ['--attribution', 'no']);
    expect((statSync(sandbox.configDir).mode & 0o777).toString(8)).toBe('700');
  });
});

describe('installer: <configDir>/server-url (SC4 M2 - non-secret URL for skills)', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  it('writes a plain-text server-url file with no secrets in it', () => {
    runInstall(sandbox, ['--attribution', 'no', '--url', 'http://127.0.0.1:4317']);
    const path = join(sandbox.configDir, 'server-url');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content.trim()).toBe('http://127.0.0.1:4317');
    // It must never contain the hook or runner token.
    const hookToken = readFileSync(sandbox.envFile, 'utf8').match(/OFFICE_HOOK_TOKEN=([0-9a-f]+)/)?.[1];
    const runnerToken = JSON.parse(readFileSync(join(sandbox.configDir, 'runner.json'), 'utf8')).token as string;
    expect(content).not.toContain(hookToken);
    expect(content).not.toContain(runnerToken);
  });

  it('is not mode-restricted like the secret files (world-readable is fine: it holds no secret)', () => {
    runInstall(sandbox, ['--attribution', 'no']);
    const mode = statSync(join(sandbox.configDir, 'server-url')).mode & 0o777;
    // Not asserting an exact mode (umask-dependent) - just that install didn't need to (and
    // didn't) force it down to 600 the way it does for curl.conf/attribution.conf/runner.json.
    expect(mode & 0o600).toBe(0o600); // owner can always read/write what they just wrote
  });

  it('uninstall removes server-url', () => {
    runInstall(sandbox, ['--attribution', 'no']);
    expect(existsSync(join(sandbox.configDir, 'server-url'))).toBe(true);
    runInstall(sandbox, ['--uninstall']);
    expect(existsSync(join(sandbox.configDir, 'server-url'))).toBe(false);
  });
});
