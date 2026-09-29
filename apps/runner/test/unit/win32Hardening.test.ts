// M11 Wave 1 review fixes on the runner side (H1, M2-M4, L6-L8), exercised through an injected win32 Platform.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_QUEST_ALWAYS_DENY, DEFAULT_QUEST_MAX_ALLOWED_TOOLS, type RunnerCapabilities, type RunStartCommand } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { buildReceptionistArgv } from '../../src/argv.js';
import { ConfigError, loadRunnerConfig } from '../../src/config.js';
import { loadLedger } from '../../src/ledger.js';
import { createLogger } from '../../src/logger.js';
import { makePlatform, type Platform } from '../../src/platform.js';
import { createRunManager } from '../../src/runManager.js';
import { spawnRun } from '../../src/runProcess.js';
import { checkQuestPolicy } from '../../src/toolPolicy.js';
import { validateQuestStart } from '../../src/validate.js';
import { verifyWindowsConfigAcl } from '../../src/winAcl.js';
import { tagconnOwnDirs, windowsSensitiveDenyRules, windowsTagconnDirDenyRules } from '../../src/windowsDeny.js';
import { mkSandbox, rmSandbox } from '../helpers.js';

const HOME = 'C:\\Users\\Ann';
const ENV = { USERPROFILE: HOME, APPDATA: `${HOME}\\AppData\\Roaming`, LOCALAPPDATA: `${HOME}\\AppData\\Local`, SystemRoot: 'C:\\Windows' };

function win(run: Platform['run'] = () => ({ status: 0, stdout: '' }), env: NodeJS.ProcessEnv = ENV): Platform {
  return makePlatform({ os: 'win32', env, homedir: () => HOME, exists: () => true, realpath: (p) => p, run });
}

/** Every path form of one rule for one tool. */
const forms = (tool: string, winPath: string) => {
  const p = winPath.replace(/\\/g, '/');
  const rest = p.slice(2);
  return [`${tool}(//C:${rest})`, `${tool}(C:${rest})`, `${tool}(//c:${rest})`, `${tool}(c:${rest})`];
};

describe('N3: PATH entries under the user dirs are edit-denied', () => {
  const env = { ...ENV, Path: `C:\\Windows\\System32;${HOME}\\AppData\\Local\\Microsoft\\WindowsApps;D:\\tools;%USERPROFILE%\\mybin;${HOME}\\AppData\\Roaming\\Foo\\;relative\\dir;${HOME}` };
  const rules = windowsSensitiveDenyRules(env, HOME);
  it('emits both forms for every tool for each user PATH entry, and the well-known bin dirs', () => {
    for (const d of [`${HOME}\\AppData\\Local\\Microsoft\\WindowsApps`, `${HOME}\\mybin`, `${HOME}\\AppData\\Roaming\\Foo`]) {
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(rules, `${tool} ${d}`).toEqual(expect.arrayContaining(forms(tool, `${d}\\**`)));
    }
    const bare = windowsSensitiveDenyRules(ENV, HOME);
    for (const d of ['.cargo\\bin', 'scoop\\shims', '.bun\\bin', '.deno\\bin', 'AppData\\Local\\Microsoft\\WindowsApps', 'AppData\\Roaming\\Python\\*\\Scripts', 'AppData\\Local\\Programs\\Python\\*\\Scripts']) {
      expect(bare, d).toEqual(expect.arrayContaining(forms('Write', `${HOME}\\${d}\\**`)));
    }
  });
  it('ignores system, foreign-drive, relative and whole-profile entries', () => {
    expect(rules.some((r) => r.includes('System32') || r.includes('D:/tools') || r.includes('relative'))).toBe(false);
    expect(rules).not.toContain('Edit(//C:/Users/Ann/**)');
  });
});

describe('windowsSensitiveDenyRules', () => {
  const rules = windowsSensitiveDenyRules(ENV, HOME);

  it('denies Read and every edit tool for credential stores, in all four forms', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      for (const p of [
        `${HOME}\\AppData\\Roaming\\Microsoft\\Credentials\\**`,
        `${HOME}\\AppData\\Roaming\\Microsoft\\Protect\\**`,
        `${HOME}\\AppData\\Roaming\\Microsoft\\Vault\\**`,
        `${HOME}\\AppData\\Local\\Microsoft\\Credentials\\**`,
        `${HOME}\\AppData\\Local\\Microsoft\\Vault\\**`,
        `${HOME}\\AppData\\Local\\Google\\Chrome\\User Data\\**`,
        `${HOME}\\AppData\\Local\\Microsoft\\Edge\\User Data\\**`,
        `${HOME}\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\**`,
        `${HOME}\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\**`,
        `${HOME}\\AppData\\Roaming\\GitHub CLI\\**`,
        `${HOME}\\AppData\\Roaming\\gcloud\\**`,
        `${HOME}\\AppData\\Roaming\\npm\\etc\\npmrc`,
        `${HOME}\\AppData\\Roaming\\pip\\pip.ini`,
        `${HOME}\\AppData\\Roaming\\NuGet\\NuGet.Config`,
        `${HOME}\\.nuget\\**`,
        `${HOME}\\AppData\\Roaming\\Code\\User\\globalStorage\\**`,
      ]) {
        for (const f of forms(tool, p)) expect(rules, f).toContain(f);
      }
    }
  });

  it('denies only the edit tools (not Read) for persistence points', () => {
    for (const p of [
      `${HOME}\\AppData\\Roaming\\npm\\**`,
      `${HOME}\\AppData\\Local\\pnpm\\**`,
      `${HOME}\\.local\\bin\\**`,
      `${HOME}\\.local\\share\\claude\\**`,
      `${HOME}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\**`,
      `${HOME}\\Documents\\PowerShell\\*profile.ps1`,
      `${HOME}\\Documents\\WindowsPowerShell\\*profile.ps1`,
      `${HOME}\\AppData\\Roaming\\Code\\User\\settings.json`,
      `${HOME}\\AppData\\Roaming\\Code\\User\\tasks.json`,
      `${HOME}\\AppData\\Roaming\\Code\\User\\keybindings.json`,
      `${HOME}\\AppData\\Local\\Packages\\Microsoft.WindowsTerminal_*\\LocalState\\settings.json`,
    ]) {
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) for (const f of forms(tool, p)) expect(rules, f).toContain(f);
      for (const f of forms('Read', p)) expect(rules, f).not.toContain(f);
    }
  });

  it('adds OneDrive PowerShell profiles only when OneDrive is set', () => {
    const od = windowsSensitiveDenyRules({ ...ENV, OneDrive: 'C:\\Users\\Ann\\OneDrive' }, HOME);
    expect(od).toContain('Write(//C:/Users/Ann/OneDrive/Documents/PowerShell/*profile.ps1)');
    expect(rules.some((r) => r.includes('OneDrive'))).toBe(false);
  });

  it('falls back to paths under the home dir when APPDATA/LOCALAPPDATA/USERPROFILE are unset', () => {
    const fb = windowsSensitiveDenyRules({}, HOME);
    expect(fb).toContain('Read(C:/Users/Ann/AppData/Roaming/Microsoft/Credentials/**)');
    expect(fb).toContain('Read(c:/Users/Ann/AppData/Local/Microsoft/Vault/**)');
    expect(fb).toContain('Edit(C:/Users/Ann/.local/bin/**)');
  });

  it('honors relocated env dirs', () => {
    const r = windowsSensitiveDenyRules({ ...ENV, APPDATA: 'D:\\Roam' }, HOME);
    expect(r).toContain('Read(//D:/Roam/GitHub CLI/**)');
    expect(r).toContain('Read(d:/Roam/GitHub CLI/**)');
  });
});

describe('H1: tagconn own dirs', () => {
  it('derives the config dir, state dir, %LOCALAPPDATA%\\tagconn and %APPDATA%\\tagconn', () => {
    const dirs = tagconnOwnDirs(ENV, HOME, { configPath: 'D:\\cfg\\runner.json', stateDir: 'E:\\state' });
    expect(dirs).toEqual([`${HOME}\\AppData\\Local\\tagconn`, `${HOME}\\AppData\\Roaming\\tagconn`, 'D:\\cfg', 'E:\\state']);
    const rules = windowsTagconnDirDenyRules(dirs);
    for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(rules).toContain(`${tool}(//D:/cfg/**)`);
      expect(rules).toContain(`${tool}(d:/cfg/**)`);
      expect(rules).toContain(`${tool}(C:/Users/Ann/AppData/Local/tagconn/**)`);
    }
  });

  it('validateQuestStart denies Read and Edit of the runner.json dir on win32, none of it on POSIX', () => {
    const root = mkSandbox();
    try {
      const project = join(root, 'proj');
      mkdirSync(project);
      const claudeJson = join(root, '.claude.json');
      writeFileSync(claudeJson, JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
      const run = (p: Platform) =>
        validateQuestStart(
          { projectDir: project, permissionMode: 'acceptEdits', allowedTools: ['Read'], disallowedTools: [] },
          {
            allowedProjectDirs: [root],
            trustOverrideDirs: [],
            maxPermissionMode: 'acceptEdits',
            allowBypassPermissions: false,
            questToolPolicy: { maxAllowedTools: ['Read'], alwaysDeny: [...DEFAULT_QUEST_ALWAYS_DENY] },
            processIsolation: 'none',
            stateDir: 'E:\\state',
            configPath: 'D:\\cfg\\runner.json',
          },
          { permissionModes: ['acceptEdits'], systemdScope: false },
          claudeJson,
          new Map(),
          p,
        );
      const r = run(win());
      if (!r.ok) throw new Error(r.failure);
      expect(r.disallowedTools).toContain('Read(//D:/cfg/**)');
      expect(r.disallowedTools).toContain('Read(d:/cfg/**)');
      expect(r.disallowedTools).toContain('Write(C:/Users/Ann/AppData/Local/tagconn/**)');
      expect(r.disallowedTools).toContain('Edit(//E:/state/**)');
      expect(r.disallowedTools).toContain('Read(C:/Users/Ann/AppData/Roaming/Microsoft/Credentials/**)');
    } finally {
      rmSandbox(root);
    }
  });

  it('the Receptionist gets the sensitive list and the tagconn dirs on win32, and neither on POSIX', () => {
    const base = {
      claudePath: 'claude.exe', scope: 'general' as const, model: 'haiku' as const, maxTurns: 5, webSearch: false, webFetchDomains: [],
      sandboxed: false, safeMode: false, extraDisallowedTools: [], stdinPrompt: true, prompt: 'hi',
    };
    const denied = (a: string[]) => a.find((x) => x.startsWith('--disallowedTools='))!;
    const w = denied(buildReceptionistArgv({ ...base, platform: win(), tagconnDirs: ['D:\\cfg'] }).argv);
    expect(w).toContain('Read(//D:/cfg/**)');
    expect(w).toContain('Read(c:/Users/Ann/AppData/Roaming/Microsoft/Credentials/**)');
    expect(w.split(',')).toContain('PowerShell');
    const posix = denied(buildReceptionistArgv({ ...base, platform: makePlatform({ os: 'linux' }) }).argv);
    expect(posix).not.toContain('Microsoft');
    expect(posix.split(',')).not.toContain('PowerShell');
  });
});

describe('M4: PowerShell', () => {
  const ctx = (platform: Platform) => ({
    maxPermissionMode: 'acceptEdits' as const,
    allowBypassPermissions: false,
    questToolPolicy: { maxAllowedTools: [...DEFAULT_QUEST_MAX_ALLOWED_TOOLS, 'PowerShell(Get-Date)', 'PowerShell'], alwaysDeny: [] },
    systemdScopeAvailable: false,
    platform,
  });

  it('hard-denies PowerShell and PowerShell(*), drops allow rules for it, and never lists it in --tools on win32', () => {
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['Read', 'PowerShell(Get-Date)', 'PowerShell'], availablePermissionModes: ['acceptEdits'] }, ctx(win()));
    if (!r.ok) throw new Error('expected ok');
    expect(r.disallowedTools).toEqual(expect.arrayContaining(['PowerShell', 'PowerShell(*)', 'Bash']));
    expect(r.allowedTools).toEqual(['Read']);
    expect(r.toolSet).not.toContain('PowerShell');
    expect(r.toolSet).not.toContain('Bash');
  });

  it('is not denied on POSIX', () => {
    const r = checkQuestPolicy({ mode: 'acceptEdits', allowedTools: ['Read'], availablePermissionModes: ['acceptEdits'] }, ctx(makePlatform({ os: 'linux' })));
    if (!r.ok) throw new Error('expected ok');
    expect(r.disallowedTools).not.toContain('PowerShell');
  });
});

// ---- shared ACL fixtures (identical in apps/runner/test/unit/win32Hardening.test.ts and packages/setup/test/winAclCore.test.ts)
const ME = 'S-1-5-21-1-2-3-1001';
const ace = (sid: string, rights: number, o: { type?: string; inherited?: boolean; inh?: number; prop?: number } = {}) => ({
  sid, rights, type: o.type ?? 'Allow', inherited: o.inherited ?? false, inheritanceFlags: o.inh ?? 0, propagationFlags: o.prop ?? 0,
});
const FULL = 2032127; // FileSystemRights.FullControl
const MODIFY = 1245631;
const READ_EXEC = 1179817;
const aclJson = (aces: unknown[], owner: string | null = ME) => JSON.stringify({ owner, user: ME, aces });
/** English and German Windows print different names, but the SIDs (all this code sees) are the same. */
const ENGLISH = aclJson([ace(ME, FULL), ace('S-1-5-18', FULL), ace('S-1-5-32-544', FULL), ace('S-1-5-32-545', READ_EXEC, { inherited: true, inh: 3 })]);
const GERMAN = ENGLISH;
const UNTRANSLATABLE = aclJson([ace(ME, FULL), ace('S-1-5-21-9-9-9-1234', MODIFY)]);
const AUTH_USERS_WRITE = aclJson([ace(ME, FULL), ace('S-1-5-11', MODIFY, { inh: 3 })]);
const DENY_ONLY_OTHERS = aclJson([ace(ME, FULL), ace('S-1-1-0', FULL, { type: 'Deny' }), ace('S-1-5-11', READ_EXEC)]);
const INHERITED_WRITE = aclJson([ace(ME, FULL), ace('S-1-5-32-545', MODIFY, { inherited: true, inh: 3 })]);
const INHERIT_ONLY_WRITE = aclJson([ace(ME, FULL), ace('S-1-5-11', MODIFY, { inherited: true, inh: 3, prop: 2 })]);
const OWNED_BY_OTHER = aclJson([ace(ME, FULL)], 'S-1-5-21-1-2-3-1002');
// ---- end shared ACL fixtures

describe('M3: runner.json ACL on win32 (11.5: read as SIDs through PowerShell)', () => {
  const FILE = 'C:\\Users\\Ann\\AppData\\Roaming\\tagconn\\runner.json';
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const plat = (o: { json?: string; status?: number }) => {
    const runs: Array<{ command: string; args: string[]; env?: Record<string, string>; timeoutMs?: number }> = [];
    const p = win((command, args, opts) => {
      runs.push({ command, args, env: opts?.env, timeoutMs: opts?.timeoutMs });
      return { status: 'status' in o ? (o.status as number) : 0, stdout: o.json ?? ENGLISH };
    });
    return { p, runs };
  };
  const check = (json: string) => verifyWindowsConfigAcl(FILE, plat({ json }).p);

  it('accepts a file private to the current user, SYSTEM and Administrators; English and German print the same SIDs', () => {
    expect(check(ENGLISH)).toBeUndefined();
    expect(check(GERMAN)).toBeUndefined();
  });

  it('reads the ACL with the absolute System32 powershell, the path in the env (not argv), a 10 s timeout and no cmd.exe', () => {
    const { p, runs } = plat({});
    expect(verifyWindowsConfigAcl(FILE, p)).toBeUndefined();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.command).toBe(PS);
    expect(runs[0]?.env).toEqual({ TAGCONN_ACL_PATH: FILE });
    expect(runs[0]?.timeoutMs).toBe(10_000);
    expect(runs[0]?.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text']);
    expect(runs[0]?.args.join(' ')).not.toContain(FILE);
    expect(runs[0]?.args.join(' ')).toContain('Get-Acl -LiteralPath $env:TAGCONN_ACL_PATH');
  });

  it('refuses when another principal can write, and names its SID', () => {
    expect(check(AUTH_USERS_WRITE)).toMatch(/"S-1-5-11" has write access/);
    expect(check(UNTRANSLATABLE)).toMatch(/"S-1-5-21-9-9-9-1234" has write access/);
    expect(check(INHERITED_WRITE)).toMatch(/"S-1-5-32-545" has write access/);
    expect(check(INHERIT_ONLY_WRITE)).toMatch(/write access/);
    expect(check(aclJson([ace(ME, FULL), ace('S-1-1-0', 0x2)]))).toMatch(/S-1-1-0/);
    expect(check(aclJson([ace(ME, FULL), ace('S-1-5-32-545', 0x40000)]))).toMatch(/write access/); // ChangePermissions
  });

  it('allows other principals that only read, and ignores DENY ACEs', () => {
    expect(check(aclJson([ace(ME, FULL), ace('S-1-5-32-545', READ_EXEC), ace('S-1-1-0', 0x1)]))).toBeUndefined();
    expect(check(DENY_ONLY_OTHERS)).toBeUndefined();
    expect(check(aclJson([ace(ME, FULL), ace('S-1-1-0', FULL, { type: 'Deny' })]))).toBeUndefined();
  });

  it('a localised SYSTEM/Administrators name no longer matters; TrustedInstaller is not trusted here', () => {
    expect(check(aclJson([ace(ME, FULL), ace('S-1-5-18', FULL), ace('S-1-5-32-544', FULL)]))).toBeUndefined();
    expect(check(aclJson([ace(ME, FULL), ace('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', FULL)]))).toMatch(/write access/);
  });

  it('requires the current user in the ACL, and an owner that is the current user or Administrators', () => {
    expect(check(aclJson([ace('S-1-5-18', FULL)]))).toMatch(/current user/);
    expect(check(aclJson([ace('S-1-1-0', FULL, { type: 'Deny' })]))).toMatch(/no access entries/);
    expect(check(OWNED_BY_OTHER)).toMatch(/owner is "S-1-5-21-1-2-3-1002"/);
    expect(check(aclJson([ace(ME, FULL)], 'S-1-5-32-544'))).toBeUndefined();
    expect(check(aclJson([ace(ME, FULL)], null))).toMatch(/file owner/);
  });

  it('fails closed on a PowerShell failure, a timeout (status null) or unparseable output, with a hint', () => {
    for (const o of [{ status: 1 }, { status: null as unknown as number }, { json: 'garbage' }, { json: '' }, { json: aclJson([]) }]) {
      const r = verifyWindowsConfigAcl(FILE, plat(o).p);
      expect(r, JSON.stringify(o)).toMatch(/fail closed/);
      expect(r).toContain('icacls');
    }
  });

  it('loadRunnerConfig throws a ConfigError on win32 when the ACL check fails', () => {
    const root = mkSandbox();
    try {
      const path = join(root, 'runner.json');
      writeFileSync(path, JSON.stringify({ token: 'a'.repeat(32), stateDir: join(root, 'state') }), { mode: 0o600 });
      expect(() => loadRunnerConfig(path, plat({ status: 1 }).p)).toThrow(ConfigError);
    } finally {
      rmSandbox(root);
    }
  });
});

describe('L8: drive-letter paths only on win32', () => {
  it('runner config rejects a drive-letter path on POSIX', () => {
    const root = mkSandbox();
    try {
      const path = join(root, 'runner.json');
      writeFileSync(path, JSON.stringify({ token: 'a'.repeat(32), stateDir: join(root, 'state'), allowedProjectDirs: ['C:/x'] }), { mode: 0o600 });
      expect(() => loadRunnerConfig(path)).toThrow(/not an absolute path/);
    } finally {
      rmSandbox(root);
    }
  });

  it('validateQuestStart rejects a drive-letter projectDir on POSIX', () => {
    const r = validateQuestStart(
      { projectDir: 'C:/x', permissionMode: 'plan', allowedTools: [], disallowedTools: [] },
      { allowedProjectDirs: ['/x'], trustOverrideDirs: [], maxPermissionMode: 'plan', allowBypassPermissions: false, questToolPolicy: { maxAllowedTools: [], alwaysDeny: [] }, processIsolation: 'none', stateDir: '/s' },
      { permissionModes: ['plan'], systemdScope: false },
      '/nope',
      new Map(),
      makePlatform({ os: 'linux' }),
    );
    expect(r).toEqual({ ok: false, failure: 'dir_not_allowed' });
  });
});

describe('L6: stop() after the child ended', () => {
  it('does not kill a reused pid', async () => {
    const kills: Array<[number, string]> = [];
    const plat = makePlatform({ os: 'linux', kill: (pid, sig) => void kills.push([pid, sig]) });
    let exited!: () => void;
    const done = new Promise<void>((r) => (exited = r));
    const h = spawnRun(
      { command: process.execPath, args: ['-e', '0'], cwd: '/tmp', env: { PATH: process.env.PATH ?? '' }, wrapper: 'plain' },
      { previewChars: 100, maxStderrLines: 5, maxLineBytes: 1024 },
      50,
      { onEvent: () => {}, onExit: () => exited() },
      plat,
    );
    await done;
    h.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(kills).toEqual([]);
  });
});

describe('L7: win32 without a resolved claude', () => {
  it('rejects quests and Receptionist turns instead of spawning a bare claude', () => {
    const root = mkSandbox();
    try {
      const ends: Array<{ status: string; reason: string }> = [];
      const caps: RunnerCapabilities = {
        stdinPrompt: true, includePartialMessages: true, settingSources: true, strictMcpConfig: true, tools: true, permissionPrompts: true,
        disableSlashCommands: true, restricted: true, safeMode: true, permissionModes: ['plan'], bwrap: false, systemdScope: false,
      };
      const rm = createRunManager({
        cfg: {
          configPath: join(root, 'runner.json'), url: 'http://127.0.0.1:0', token: 'a'.repeat(32), runnerId: '00000000-0000-4000-8000-000000000000',
          allowedProjectDirs: [root], trustOverrideDirs: [root], questToolPolicy: { maxAllowedTools: [], alwaysDeny: [] }, maxConcurrent: 2,
          maxPermissionMode: 'plan', allowBypassPermissions: false, passEnv: [], claudePath: 'claude', stateDir: root, receptionistSandbox: 'none',
          processIsolation: 'none', memoryMax: '1G', tasksMax: 10, maxLineBytes: 1024, maxStderrLines: 5, killGraceMs: 10, offlineBufferEvents: 1,
          offlineBufferBytes: 1000, sessionLedgerSize: 1, questTimeoutCapSec: 60, receptionistTimeoutCapSec: 60,
        } as never,
        caps,
        ledger: loadLedger(join(root, 'l.json')),
        ledgerPath: join(root, 'l.json'),
        claudeJsonPath: join(root, '.claude.json'),
        platform: win(),
        logger: createLogger('error'),
        emitEvent: () => {},
        emitEnd: (e) => ends.push(e),
      });
      const cmd = { runId: 'r1', kind: 'quest', projectDir: root, permissionMode: 'plan', allowedTools: [], disallowedTools: [] } as unknown as RunStartCommand;
      expect(rm.startQuest(cmd)).toEqual({ pid: null });
      expect(rm.startReceptionist({ ...cmd, runId: 'r2', kind: 'receptionist' }, { scope: 'general' })).toEqual({ pid: null });
      expect(ends.map((e) => [e.status, e.reason])).toEqual([['rejected', 'spawn_failed'], ['rejected', 'spawn_failed']]);
    } finally {
      rmSandbox(root);
    }
  });
});
