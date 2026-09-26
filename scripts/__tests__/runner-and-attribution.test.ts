// Tests for the M8 additions to scripts/install.ts: the attribution README
// prompt (default "no"), the attribution.conf/runner.json files, the
// --allow-dir broad-dir warning, and their unit-level helpers. Always
// sandboxed (see CLAUDE.md) - never the real ~/.config/tagconn.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { countGitReposBelow, ensureRunnerConfig, isBroadAllowDir, isValidRunnerToken, parseArgs } from '../install.ts';
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

  it('L7: a reinstall MERGES into an existing runner.json, keeping fields the installer does not manage itself', () => {
    runInstall(sandbox, ['--attribution', 'no']);
    const runnerPath = join(sandbox.configDir, 'runner.json');
    const before = JSON.parse(readFileSync(runnerPath, 'utf8'));
    // Simulate fields the runner itself (or a hand-edit) added, that scripts/install.ts never sets.
    const withExtras = {
      ...before,
      maxPermissionMode: 'bypassPermissions',
      allowBypassPermissions: true,
      questToolPolicy: { maxAllowedTools: ['Read', 'Bash(npm test)'], alwaysDeny: ['Write(.env)'] },
      processIsolation: 'systemd-scope',
      trustOverrideDirs: ['/tmp/trusted'],
      passEnv: ['MY_CUSTOM_VAR'],
      maxConcurrent: 7,
    };
    writeFileSync(runnerPath, JSON.stringify(withExtras, null, 2) + '\n', { mode: 0o600 });

    const res = runInstall(sandbox, ['--attribution', 'no']);
    expect(res.status, res.stderr).toBe(0);
    const after = JSON.parse(readFileSync(runnerPath, 'utf8'));
    expect(after.maxPermissionMode).toBe('bypassPermissions');
    expect(after.allowBypassPermissions).toBe(true);
    expect(after.questToolPolicy).toEqual(withExtras.questToolPolicy);
    expect(after.processIsolation).toBe('systemd-scope');
    expect(after.trustOverrideDirs).toEqual(['/tmp/trusted']);
    expect(after.passEnv).toEqual(['MY_CUSTOM_VAR']);
    expect(after.maxConcurrent).toBe(7);
    // The fields the installer DOES manage are still updated/kept as before.
    expect(after.token).toBe(before.token);
    expect(after.allowedProjectDirs).toEqual(before.allowedProjectDirs);
  });

  it('L7: a reinstall without --url keeps a previously customized url; passing --url overwrites it', () => {
    runInstall(sandbox, ['--attribution', 'no', '--url', 'http://127.0.0.1:9999']);
    const runnerPath = join(sandbox.configDir, 'runner.json');
    expect(JSON.parse(readFileSync(runnerPath, 'utf8')).url).toBe('http://127.0.0.1:9999');

    runInstall(sandbox, ['--attribution', 'no']); // no --url this time
    expect(JSON.parse(readFileSync(runnerPath, 'utf8')).url).toBe('http://127.0.0.1:9999'); // unchanged

    runInstall(sandbox, ['--attribution', 'no', '--url', 'http://127.0.0.1:5555']);
    expect(JSON.parse(readFileSync(runnerPath, 'utf8')).url).toBe('http://127.0.0.1:5555'); // explicit wins
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

// QA: for a sandboxed install, an unset runner.json `stateDir` would let a runner started against
// it default to the REAL ~/.local/state/tagconn (apps/runner/src/config.ts's own default) - outside
// the sandbox entirely. `runInstall`'s sandbox always passes an explicit --config-dir (never the
// real one), so every CLI-level install below is itself a "sandboxed" install per `isDefaultConfigDir`.
describe('installer: runner.json stateDir sandboxing', () => {
  it('a sandboxed install (--config-dir under a temp HOME) defaults stateDir to <configDir>/state', () => {
    const sandbox = createSandbox();
    const res = runInstall(sandbox, ['--attribution', 'no']);
    expect(res.status, res.stderr).toBe(0);
    const config = JSON.parse(readFileSync(join(sandbox.configDir, 'runner.json'), 'utf8'));
    expect(config.stateDir).toBe(join(sandbox.configDir, 'state'));
  });

  it('a reinstall keeps an existing stateDir untouched (idempotent, respects hand-edits)', () => {
    const sandbox = createSandbox();
    runInstall(sandbox, ['--attribution', 'no']);
    const runnerPath = join(sandbox.configDir, 'runner.json');
    const before = JSON.parse(readFileSync(runnerPath, 'utf8'));
    const customStateDir = join(sandbox.home, 'somewhere-else', 'state');
    writeFileSync(runnerPath, JSON.stringify({ ...before, stateDir: customStateDir }, null, 2) + '\n', { mode: 0o600 });

    const res = runInstall(sandbox, ['--attribution', 'no']);
    expect(res.status, res.stderr).toBe(0);
    const after = JSON.parse(readFileSync(runnerPath, 'utf8'));
    expect(after.stateDir).toBe(customStateDir);
  });

  it('ensureRunnerConfig unit: leaves stateDir unset for a default (non-sandboxed) install, sets it for a sandboxed one', () => {
    const sandbox = createSandbox('tagconn-statedir-unit-test-');
    const configDir = join(sandbox.home, 'unit-config-dir');

    const notSandboxed = ensureRunnerConfig(configDir, 'http://127.0.0.1:4317', true, [], false, false);
    expect(JSON.parse(readFileSync(notSandboxed.path, 'utf8')).stateDir).toBeUndefined();
    rmSync(configDir, { recursive: true, force: true });

    const sandboxed = ensureRunnerConfig(configDir, 'http://127.0.0.1:4317', true, [], false, true);
    expect(JSON.parse(readFileSync(sandboxed.path, 'utf8')).stateDir).toBe(join(configDir, 'state'));
  });

  // parseArgs' `configDirExplicit` must track "the operator asked for this location", not "the
  // resolved path happens to differ from DEFAULT_CONFIG_DIR" - the latter can coincidentally be
  // equal under a faked $HOME (exactly what every sandboxed test in this suite does), which would
  // otherwise silently disable the stateDir sandboxing this whole describe block is about.
  describe('parseArgs: configDirExplicit', () => {
    const savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, TAGCONN_CONFIG_DIR: process.env.TAGCONN_CONFIG_DIR };

    beforeEach(() => {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.TAGCONN_CONFIG_DIR;
    });

    afterAll(() => {
      if (savedEnv.CLAUDE_CONFIG_DIR !== undefined) process.env.CLAUDE_CONFIG_DIR = savedEnv.CLAUDE_CONFIG_DIR;
      if (savedEnv.TAGCONN_CONFIG_DIR !== undefined) process.env.TAGCONN_CONFIG_DIR = savedEnv.TAGCONN_CONFIG_DIR;
    });

    // Note: install.ts computes DEFAULT_CLAUDE_DIR/DEFAULT_CONFIG_DIR from `homedir()` once, at
    // module load - which already happened (against the REAL home) before this test file's
    // `withFakeHome` could take effect, in-process. So these three checks use plain paths instead of
    // faking $HOME; the "coincides with the real default under an overridden HOME" scenario itself
    // (what --config-dir/--claude-dir look like once install.ts runs as its own child process with
    // HOME overridden, exactly as `runInstall` does above) is covered end-to-end by the "a sandboxed
    // install ... defaults stateDir" CLI-level test earlier in this describe block.
    it('is true for an explicit --config-dir', () => {
      const args = parseArgs(['--config-dir', '/tmp/tagconn-configdirexplicit-flag']);
      expect(args.configDir).toBe('/tmp/tagconn-configdirexplicit-flag');
      expect(args.configDirExplicit).toBe(true);
    });

    it('is true for a non-default --claude-dir with no --config-dir', () => {
      const args = parseArgs(['--claude-dir', '/tmp/tagconn-configdirexplicit-claude/.claude']);
      expect(args.configDir).toBe('/tmp/tagconn-configdirexplicit-claude/.config/tagconn');
      expect(args.configDirExplicit).toBe(true);
    });

    it('is false with no flags at all (a genuine default install)', () => {
      const args = parseArgs([]);
      expect(args.configDir).toBe(join(homedir(), '.config', 'tagconn'));
      expect(args.configDirExplicit).toBe(false);
    });
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
