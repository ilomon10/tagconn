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

describe('M3: runner.json ACL on win32', () => {
  const FILE = 'C:\\Users\\Ann\\AppData\\Roaming\\tagconn\\runner.json';
  const WHOAMI = '"desktop\\ann","S-1-5-21-1-2-3-1001"\r\n';
  const ICACLS = (aces: string[]) => `${FILE} ${aces[0]}\r\n${aces.slice(1).map((a) => `                                                  ${a}`).join('\r\n')}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
  const DIR = (owner: string) => `${owner}\r\n`;
  const plat = (o: { whoami?: string; icacls?: string; dir?: string; icaclsStatus?: number }) => {
    const calls: string[] = [];
    const runs: Array<[string, string[], Record<string, string> | undefined]> = [];
    const p = win((command, args, opts) => {
      calls.push(command);
      runs.push([command, args, opts?.env]);
      if (command.endsWith('whoami.exe')) return { status: o.whoami === undefined ? 1 : 0, stdout: o.whoami ?? '' };
      if (command.endsWith('icacls.exe')) return { status: o.icaclsStatus ?? 0, stdout: o.icacls ?? '' };
      return { status: 0, stdout: o.dir ?? '' };
    });
    return { p, calls, runs };
  };
  const good = { whoami: WHOAMI, icacls: ICACLS(['DESKTOP\\ann:(F)', 'NT AUTHORITY\\SYSTEM:(F)', 'BUILTIN\\Administrators:(F)']), dir: DIR('DESKTOP\\ann') };

  it('accepts a file private to the current user, SYSTEM and Administrators, using absolute System32 binaries', () => {
    const { p, calls } = plat(good);
    expect(verifyWindowsConfigAcl(FILE, p)).toBeUndefined();
    expect(calls.every((c) => c.startsWith('C:\\Windows\\System32\\'))).toBe(true);
  });

  it('matches the current user by SID as well as by name', () => {
    const { p } = plat({ ...good, icacls: ICACLS(['*S-1-5-21-1-2-3-1001:(F)', 'NT AUTHORITY\\SYSTEM:(F)']) });
    expect(verifyWindowsConfigAcl(FILE, p)).toBeUndefined();
  });

  it('refuses when another principal can write, and names it', () => {
    for (const ace of ['BUILTIN\\Users:(M)', 'Everyone:(F)', 'DESKTOP\\bob:(I)(W)', 'BUILTIN\\Users:(OI)(CI)(WD,AD)']) {
      const { p } = plat({ ...good, icacls: ICACLS(['DESKTOP\\ann:(F)', ace]) });
      expect(verifyWindowsConfigAcl(FILE, p), ace).toMatch(/write access/);
    }
  });

  it('allows other principals that only read', () => {
    const { p } = plat({ ...good, icacls: ICACLS(['DESKTOP\\ann:(F)', 'BUILTIN\\Users:(R)', 'Everyone:(RX)']) });
    expect(verifyWindowsConfigAcl(FILE, p)).toBeUndefined();
  });

  it('N10: any right outside the read-only allow-list from a non-owner is a write', () => {
    for (const ace of ['BUILTIN\\Users:(RX,WA)', 'Everyone:(CI)(DE)', 'BUILTIN\\Users:(X,GW)', 'Everyone:(NEWTOKEN)', 'BUILTIN\\Users:(RC,WDAC)']) {
      const { p } = plat({ ...good, icacls: ICACLS(['DESKTOP\\ann:(F)', ace]) });
      expect(verifyWindowsConfigAcl(FILE, p), ace).toMatch(/write access/);
    }
    const ok = plat({ ...good, icacls: ICACLS(['DESKTOP\\ann:(F)', 'BUILTIN\\Users:(I)(OI)(CI)(IO)(NP)(RX,GR,GE,S,RD,REA,RA,RC)']) });
    expect(verifyWindowsConfigAcl(FILE, ok.p)).toBeUndefined();
  });

  it('N10: reads the owner via powershell with the path in the env (not argv) and no cmd.exe', () => {
    const { p, runs } = plat(good);
    expect(verifyWindowsConfigAcl(FILE, p)).toBeUndefined();
    const ps = runs.find(([c]) => c.endsWith('powershell.exe'));
    expect(ps?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(ps?.[2]).toEqual({ TAGCONN_ACL_PATH: FILE });
    expect(ps?.[1].join(' ')).not.toContain(FILE);
    expect(runs.some(([c]) => c.endsWith('cmd.exe'))).toBe(false);
  });

  it('N10: strips NUL/BOM from helper output, and fails closed on a truncated or multi-line owner', () => {
    expect(verifyWindowsConfigAcl(FILE, plat({ ...good, dir: '\uFEFF' + 'DESKTOP\\ann'.split('').join('\u0000') + '\r\n' }).p)).toBeUndefined();
    expect(verifyWindowsConfigAcl(FILE, plat({ ...good, dir: 'DESKTOP\\an\r\n' }).p)).toMatch(/owner is "DESKTOP\\an"/);
    expect(verifyWindowsConfigAcl(FILE, plat({ ...good, dir: 'DESKTOP\\ann\r\nWARNING\r\n' }).p)).toMatch(/file owner/);
    expect(verifyWindowsConfigAcl(FILE, plat({ ...good, dir: '' }).p)).toMatch(/file owner/);
  });

  it('N10: a localised current-user name matches (whoami is the same locale); a localised Administrators name is not trusted by name', () => {
    const who = '"büro\\änne","S-1-5-21-1-2-3-1001"\r\n';
    expect(verifyWindowsConfigAcl(FILE, plat({ ...good, whoami: who, icacls: ICACLS(['BÜRO\\ÄNNE:(F)', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)']), dir: DIR('BÜRO\\ÄNNE') }).p)).toBeUndefined();
    expect(verifyWindowsConfigAcl(FILE, plat({ ...good, dir: DIR('VORDEFINIERT\\Administratoren') }).p)).toMatch(/owner is/);
    expect(verifyWindowsConfigAcl(FILE, plat({ ...good, dir: DIR('*S-1-5-32-544') }).p)).toBeUndefined();
  });

  it('refuses a file owned by someone else', () => {
    const { p } = plat({ ...good, dir: DIR('DESKTOP\\bob') });
    expect(verifyWindowsConfigAcl(FILE, p)).toMatch(/owner is "DESKTOP\\bob"/);
    expect(verifyWindowsConfigAcl(FILE, plat({ ...good, dir: DIR('BUILTIN\\Administrators') }).p)).toBeUndefined();
  });

  it('fails closed on unparseable or failing helper output, with a hint', () => {
    for (const o of [
      { ...good, whoami: undefined },
      { ...good, icacls: 'garbage' },
      { ...good, icaclsStatus: 5 },
      { ...good, dir: 'nothing here' },
      { ...good, icacls: ICACLS(['NT AUTHORITY\\SYSTEM:(F)']) },
    ]) {
      expect(verifyWindowsConfigAcl(FILE, plat(o).p)).toMatch(/icacls|whoami|owner|current user/);
    }
  });

  it('loadRunnerConfig throws a ConfigError on win32 when the ACL check fails', () => {
    const root = mkSandbox();
    try {
      const path = join(root, 'runner.json');
      writeFileSync(path, JSON.stringify({ token: 'a'.repeat(32), stateDir: join(root, 'state') }), { mode: 0o600 });
      expect(() => loadRunnerConfig(path, plat({ whoami: undefined }).p)).toThrow(ConfigError);
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
