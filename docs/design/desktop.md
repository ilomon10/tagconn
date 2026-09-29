# Design: tagconn Desktop (M11)

Status: approved 2026-09-29, in progress. Live task list: `ROADMAP.md` → M11. Decisions: #27, #28.


## Context
Today tagconn is started from a repo checkout with pnpm and Docker (`pnpm office:up`, `office:install`,
`office:runner`, `office:pair`), and several parts only work on Linux:
- the hook needs `sh`, `curl` and `sed` (packages/hook/office-hook.sh);
- the runner wraps quests in `systemd-run`, sandboxes the Receptionist with `bwrap`, and stops runs with a
  negative-PID group kill (apps/runner/src/spawnPlan.ts, bwrap.ts, runProcess.ts:131-143);
- the scripts check Unix file modes and use XDG paths (scripts/install.ts, doctor.ts);
- nginx in Docker serves the web app, because the server has no static file serving.

The user wants one app for Windows and Linux that works like XAMPP. You open it, and a setup wizard
checks the system, installs the hooks and starts the services. After that, a control panel shows each
service with Start/Stop, status and logs, and opens the office.

User choices:
- **Tauri 2 + a Node sidecar**;
- **native services by default, Docker optional**;
- on Windows the runner is **allowed with stricter defaults**;
- **installer + auto-update** via GitHub Releases.

The dev machine already has Rust 1.98 and webkit2gtk-4.1, so the Linux Tauri build runs locally.
Windows builds run in CI.

## Architecture
```
tagconn Desktop (Tauri 2, Rust: window, tray, autostart, updater, single-instance)
  └─ UI (React + Vite + Tailwind, same ink/cozy tokens): setup wizard + control panel
  └─ sidecar: bundled node (24.21.0) running apps/supervisor (TypeScript)
        ├─ JSON-RPC over stdin/stdout with Tauri (no network port, no token needed)
        ├─ setup: checks, hooks install/uninstall, runner config, pairing
        ├─ child: server  (node server bundle; now also serves the web app on 127.0.0.1:4317)
        ├─ child: runner  (node runner bundle)
        └─ optional: Docker mode (`docker compose` with published ghcr.io images) instead of the native server
Office window: a Tauri window on http://127.0.0.1:4317, auto-paired via /#pair=<code>. It can also open in the browser.
```
Rust stays thin: it spawns and monitors the sidecar, relays RPC and handles OS integration. All logic is in
TypeScript, so it can be tested with vitest and reuses today's install/doctor/pair code.

## Error handling and mitigation (setup and runtime)
Principles:
- nothing fails silently: every failure shows *what* failed, *why* (a short cause) and *one next step*;
- every change to the user's system can be undone;
- the Claude Code hook can never break Claude Code.

**Setup (wizard) failures.** Each check returns `{status, detail, fix}`. `fix` is an action button where
possible, and the wizard can be re-run at any time.

| Failure | Detection | Mitigation shown to the user |
|---|---|---|
| Claude CLI missing or too old | `claude --version` (via `where`/`command -v`) | Link to the install page, "Re-check"; observer mode still works without the runner |
| Claude not logged in | the login check found in spike 2 | "Run `claude` once and log in", Re-check |
| Git for Windows missing (if Claude needs it) | registry / PATH probe | Link + Re-check |
| Port 4317 busy | bind test | Show the owning process where possible; offer the next free port (writes `server.port` + `corsOrigins` together) |
| No write access to the config/data dir | test write | Show the path; offer a custom data dir |
| `~/.claude/settings.json` invalid JSON or locked | parse / open | Never overwrite it; show the parse error line; "Open file" / "Retry" |
| Hook install is partial (a crash mid-write) | writes go to a temp file and are atomically renamed; backup first | Automatic rollback from the backup; the "Uninstall hooks" button restores it |
| ACL/chmod on a secret file fails | verify after writing | Refuse to continue (secrets must not be world-readable), with a fix hint |
| WebView2 missing (old Windows) | the NSIS installer bootstraps it | Installer downloads it; offline users get a link |
| Docker mode chosen but Docker not running | `docker info` | "Start Docker Desktop" / switch to Native |
| better-sqlite3 fails to load | the server exits early with a known error | Show the error; "Reinstall app" (it is prebuilt, so this points to a corrupt install) |

**Runtime failures.**
- **Services:**
  - the supervisor restarts a crashed child with exponential backoff (1 s → 30 s, then it gives up after 5
    crashes in 2 minutes);
  - the service turns red with the last 50 log lines and "Restart" / "Copy diagnostics";
  - health polling of `/api/health` catches hangs (no reply for 3 polls, then restart).
- **Sidecar dies:** Tauri detects the exit, relaunches it once, and otherwise shows a blocking "Service
  manager stopped" panel with the logs and Retry. On quit, children are killed as a tree (Job Object on
  Windows, process group on Linux), so there are no orphans; stale PID files are cleaned on the next start.
- **Hook:** it is time-boxed to 1 s, always exits 0, writes no stdout and catches every error. If the
  server is down, events are dropped (no queue on disk, same as today) and Claude Code is unaffected. The
  control panel shows "Hooks: installed, office offline" instead of an error.
- **Runner:** it reconnects with backoff (the existing SC5 logic); quests refused on Windows show the
  existing rejection guidance (`isolation_unavailable`, etc.); a claude binary that moved after an update
  is re-resolved on each start.
- **Ports and origin:** if the port changes, the supervisor rewrites `corsOrigins` and the runner/hook URL
  files together, so the web, hook and runner never disagree.
- **Updates:** updater packages must be signed (a bad signature is refused); a failed update keeps the
  current version, and settings and data live outside the install dir so a reinstall keeps them.
- **Diagnostics:** "Copy diagnostics" collects versions, check results and redacted recent logs (tokens
  masked with the existing redaction), for bug reports.

## Work (file-disjoint waves)

### Step 1: persist the plan in the repo (PM) — done
So this work can continue in any later session:
- `ROADMAP.md` gets a new `## M11: tagconn Desktop (Windows + Linux) → v0.5.0` with every task below as a
  checkbox (W0 spikes, A–F, packaging, docs, reviews), owners and status.
- A new `docs/design/desktop.md` holds this plan in full: architecture, RPC contract, error-handling
  table, Windows policy and verification, as the design reference.
- `docs/decisions.md` gets #27 (Tauri + Node sidecar, native default, stdio RPC, node hook) and #28
  (the Windows runner policy).
- CLAUDE.md "Start here" gets a pointer to `docs/design/desktop.md` while M11 is in progress.
- These are committed first ("docs: plan tagconn Desktop (M11)"), and ROADMAP is updated after every wave.

### Wave 0: contract + spikes (PM + QA)
- New `packages/shared/src/desktop.ts`: the RPC contract. It covers:
  - `setup.check` → a list of `{id, status: ok|warn|fail, detail, fix}`;
  - `setup.install` / `setup.uninstall`;
  - `service.start|stop|restart|status` for `server | runner | docker`;
  - `logs.tail`, `pair.mint`, and `config.get|set` (allowed dirs, attribution, ports, run mode);
  - event notifications `service.changed` and `log.line`.
- Settings: `server.webDir` (string|null, default null; restart-required, GUI-immutable). `corsOrigins`
  defaults gain `http://127.0.0.1:4317` and `http://localhost:4317`.
- Spikes on Windows (a CI `windows-latest` job plus the user's Windows machine for real-CLI checks):
  1. How Claude Code on native Windows runs hook commands (shell, quoting, PATH), and whether a
     `"<node.exe>" "<hook.mjs>"` command works.
  2. How `claude` is installed there (native `claude.exe`, or an npm `.cmd` shim), and how to detect
     "logged in".
  3. The Windows permission-rule path form for deny rules (e.g. `//C:/Users/...` vs `C:\...`), tested
     R3-style with a canary folder.
  4. That the better-sqlite3 13 prebuild covers node 24 on win-x64.

### Wave 0 results (2026-09-29)
- **W0a contract:** done. It lives in `packages/shared/src/desktop.ts`, which defines `DESKTOP_METHODS`,
  the notifications, `SetupCheck`, `DesktopConfig` and the error codes. `server.webDir` is added
  (restart-required), and `corsOrigins` gains `:4317`.
- **W0b hook execution, from the docs (hooks.md, setup.md):**
  - A hook `command` without `args` runs through a shell: `sh -c` on Linux/macOS, and on Windows Git Bash
    if it is installed, otherwise PowerShell.
  - **Exec form** (`"command": "<exe>", "args": [...]`) runs without a shell. The desktop registers the
    node hook in exec form (`command` = the bundled node, `args` = [office-hook.mjs]), which avoids all
    Windows quoting and shell differences.
  - Input on stdin and exit codes are the same on every OS.
  - The default hook timeout is 600 s, so our hook keeps enforcing its own 1 s budget.
  - Still to test on a real Windows machine: that exec form works as documented.
- **W0c claude on Windows:**
  - The native install is `%USERPROFILE%\.local\bin\claude.exe`, with the real binary under
    `%USERPROFILE%\.local\share\claude\versions\<v>\`.
  - npm installs a `claude.cmd` shim; winget has `Anthropic.ClaudeCode`.
  - Detection order: `where.exe claude`, then the native path.
  - Login check: `claude auth status` (exit 0 = logged in; `--json` exists).
  - Config is `%USERPROFILE%\.claude\settings.json`, `%USERPROFILE%\.claude.json` and
    `%USERPROFILE%\.claude\projects`. Whether `CLAUDE_CONFIG_DIR` works on Windows is undocumented, so
    sandboxed Windows tests must verify it.
- **W0d deny-rule path form on Windows:** undocumented. It needs the canary test on a real Windows machine.
  Until it is confirmed, the win32 runner policy keeps Bash denied and adds deny rules in BOTH candidate
  forms (`//C:/Users/<u>/...` and `C:/Users/<u>/...`), and the Windows tests assert both.
- **W0e better-sqlite3 on win-x64:** to be checked in the Windows CI job (G). If there's no prebuild, CI
  installs MSVC build tools (windows-latest has them).

**Hook config file (shared by B and D).** `<configDir>/hook.json`, mode 0600 / a user-only ACL:
`{ "version": 1, "url": "http://127.0.0.1:4317", "token": "<hook token>", "attributionReadme": false }`.
The node hook reads it (override with `TAGCONN_HOOK_CONFIG`). Import uses `<url>/api/attribution/import`.
The README template stays `<configDir>/attribution-README.md`. The sh hook keeps `curl.conf` and
`attribution.conf`. The desktop writes `hook.json` and registers only the node hook.

### Real Windows machine checklist (collected from Waves 0–1; run with the user)
Use a canary folder (never real dotfiles) and haiku with a small budget.
1. The hook in exec form (`command` = node.exe, `args` = [office-hook.mjs]) fires, and an event reaches the office.
2. `where.exe claude` output for the native, npm (`claude.cmd`) and winget installs. The runner's shim
   parsing launches `node cli.js` the same way the `.cmd` does.
3. The deny-rule path form: which of `//C:/Users/<u>/...` and `C:/Users/<u>/...` the CLI honours
   (canary write refused). Then drop the other form. Also try the canary through these aliases (each must
   be refused, or the gap is documented): a lowercase drive letter and mixed case, the 8.3 short name
   (`C:/Users/JOHNSM~1/...`), `\\?\C:\...`, `\\localhost\C$\Users\<u>\...`, the legacy junctions
   (`C:\Documents and Settings`, `%USERPROFILE%\Application Data`), and a WSL home
   (`\\wsl.localhost\<distro>\home\<u>\...`). Check whether Claude Code exposes a `PowerShell` tool on
   this machine: it is hard-denied on win32 either way.
10. Bare-name spawns: planted `claude.exe`, `claude.cmd` or `icacls.exe` in the current dir or a later
    PATH entry are never run (setup and the runner use absolute System32 binaries and PATH order).
4. `taskkill /PID <pid> /T /F` reaps the whole claude tree when a quest is stopped.
5. The trust key style in `%USERPROFILE%\.claude.json`: slashes and drive-letter case.
6. The stdin prompt (`-p` with stdin) works from a Node parent on win32.
7. `icacls` ACLs on hook.json, runner.json and the state dir are applied and verified by setup.
8. Whether `CLAUDE_CONFIG_DIR` is honoured on Windows. Sandboxed Windows tests depend on it.
9. better-sqlite3 13 loads under the bundled node 24.21 on win-x64.

**Wave 1 security review (2026-09-29):** 1 High, 4 Medium, 12 Low; fixes are tracked as ROADMAP 11.3.
Fixes land in S1 (runner/shared: Windows deny lists incl. tagconn's own dirs, PowerShell deny,
System32 binaries, runner.json ACL, kill/launch guards), S2 (setup: stable node for the hook, SID-based ACLs,
no `cmd /c`, symlink-preserving settings writes, URL validation), S3 (hook: token/header validation,
hook.json owner/mode, O_NOFOLLOW + dev/ino, Windows ownership fallback, fail-closed home guard) and S4
(server: no symlink escape from webDir, nosniff + no-store on /api).

**Windows follow-ups for the security review.** Consider denying more Windows-specific sensitive
locations for quests, beyond the `~/` set duplicated in both forms: `AppData\Roaming` credential
stores, the PowerShell profiles (`Documents\PowerShell\*profile.ps1`, `Documents\WindowsPowerShell\...`),
`AppData\Roaming\npm` and the `.npmrc` location.
The web's rejection guidance (`apps/web/src/features/quests/rejectionGuidance.ts`) still talks about
systemd, so give `isolation_unavailable` and `mode_not_allowed` Windows-specific text (task F, or the PM).

### Wave 1: portable core (4 developers in parallel)
- **A. Server serves the web app.** Add `@fastify/static` in a new `apps/server/src/core/web/` plugin.
  It is active only when `server.webDir` is set; `/api` and `/socket.io` are untouched.
  - SPA fallback to index.html.
  - Cache rules: assets immutable with 1y max-age, index.html no-store.
  - Security headers from ONE shared source: a new `packages/shared/src/securityHeaders.ts`. nginx.conf
    stays hand-written, with a test that asserts it matches, and vite.config.ts imports the same constants.
  - Path portability:
    - `expandHome` (core/config/merge.ts:130) also accepts `~\`;
    - `mapHostPath` (modules/transcripts/transcripts.paths.ts) handles backslash paths;
    - the `O_NOFOLLOW` fallback in transcripts.parser.ts is verified on win32.
  - Tests are added to security.test.ts.
- **B. Cross-platform hook.** A new `packages/hook/office-hook.mjs` that uses only node builtins and
  `fetch` with a 1 s AbortSignal.
  - It always exits 0, prints nothing to stdout and never throws.
  - It reads the URL and token from `hook.json`: 0600 on Linux, a user-only ACL on Windows (set with `icacls`).
  - It ports every behaviour of office-hook.sh: the SessionStart attribution README and profile import with
    its guards (no home dir or root, no symlinks, no overwrite, size caps), the receptionist-run exit and
    the run-id hint.
  - Parity tests reuse the existing hook test cases (scripts/__tests__/hooks.test.ts,
    hook-attribution*.test.ts), run against both hooks.
  - Latency budget (<60 ms p50) goes in a `*.perf.test.ts`.
  - The desktop app always registers the node hook. The sh hook stays for repo/Docker users.
- **C. Runner on Windows.** A platform layer, `apps/runner/src/platform.ts`, with:
  - claude path resolution: `where claude` on win32, which handles `.cmd` shims by spawning through the
    resolved `.exe` or `cmd /c` safely;
  - process-tree kill: `taskkill /PID <pid> /T /F` on win32, today's group kill elsewhere;
  - no systemd or bwrap probes on win32 (both capabilities false);
  - the state dir under `%LOCALAPPDATA%\tagconn`;
  - skipping the 0600 check on win32 (the ACL is set at install time);
  - trust paths through `path.win32`.
  - Policy on win32: Bash is always hard-denied, the permission mode is capped at `acceptEdits`, and the
    Receptionist gets its exact read-only tool set with `receptionistSandbox: none` plus a warning.
    This goes through the existing `toolPolicy.ts` and `validate.ts` checks, which should already return
    `isolation_unavailable` for the risky modes (confirm and add tests).
  - Deny rules are rewritten to the Windows path form found in spike 3.
- **D. `packages/setup` library.** Move the logic of scripts/install.ts, doctor.ts and pair.ts into a
  cross-platform package (node builtins only).
  - A paths module gives config `%APPDATA%\tagconn` / `~/.config/tagconn`, state `%LOCALAPPDATA%` /
    XDG state, and data `%LOCALAPPDATA%\tagconn\data` / `~/.local/share/tagconn`.
  - Secrets are written with ACLs on win32 and chmod elsewhere.
  - Settings.json hooks are merged with a backup, as today.
  - The checks return the `setup.check` shape.
  - `scripts/*.ts` become thin CLIs over it, and their behaviour and the 148 script tests stay unchanged.

### Wave 2: the app (2 developers in parallel, against the Wave 0 contract)
- **E. `apps/supervisor`** (TypeScript, bundled with tsup into one JS file):
  - a JSON-RPC stdio loop;
  - a service manager for the child processes, with restart and backoff, a log ring buffer, health
    polling of /api/health and graceful stop;
  - setup through `packages/setup`;
  - Docker mode: detect `docker compose`, then start and stop the stack with a bundled compose file that
    uses `ghcr.io/ilomon10/tagconn-{server,web}:<version>`;
  - on first start it mints a pairing code (the existing HMAC flow in `packages/setup`) so the office
    window opens already paired.
  - Tests use a fake child process.
- **F. `apps/desktop`** (Tauri 2):
  - `src-tauri/` holds the sidecar spawn and RPC relay, a tray (Open office / Start all / Stop all /
    Quit), the plugins autostart, updater, single-instance and opener, and the window for the office URL.
  - `src/` is the React UI:
    - Wizard steps: Welcome → System check → Runner folders (a folder picker) and attribution
      (default off) → "Install hooks" (shows the file it edits and where the backup goes; needs
      explicit consent) → Start services.
    - Checks on every OS: claude CLI installed, version and logged in; ports free; disk space.
    - Windows-only checks: Git for Windows if Claude Code needs it (from spike 1), WebView2 and
      the Windows runner safety notice.
    - Optional check: Docker.
    - Control panel: a row per service (Server, Runner, Hooks, and Docker in Docker mode) with a status
      light, Start/Stop/Restart, a logs drawer, "Open office" and "Open in browser". Settings cover run
      mode, ports and start with system. It also has Uninstall hooks and "Check for updates".
  - It meets the same a11y bar as the office: keyboard, focus, contrast, reduced motion.

### Wave 3: packaging, CI, docs
- `.github/workflows/desktop.yml` builds on a matrix of windows-latest and ubuntu-22.04:
  - builds the web, server, runner and supervisor bundles;
  - downloads official node 24.21.0 as the sidecar `binaries/node-<target-triple>`;
  - installs better-sqlite3 for that node ABI on each target;
  - runs `tauri build`, producing an NSIS setup .exe, an AppImage and a .deb;
  - signs with the Tauri updater key (`TAURI_SIGNING_PRIVATE_KEY` secret) and publishes `latest.json`
    plus the artifacts to the GitHub Release for the tag;
  - also publishes the ghcr.io server and web images for Docker mode.
  - The release flow is unchanged: `pnpm release` → push tags → CI attaches the desktop builds.
  - Windows code signing is optional; without it SmartScreen shows "unknown publisher" (documented).
- Docs:
  - `docs/guide/desktop.md` (install, wizard, control panel, Windows notes and limits, uninstall);
  - README quick start leads with the app download;
  - CLAUDE.md commands (`pnpm --filter @tagconn/desktop tauri dev`);
  - decisions #27 (Tauri + Node sidecar, native default, stdio RPC, node hook) and #28 (the Windows runner
    policy);
  - ROADMAP M11.

### Review gates
- A security review before merge covers the node hook (the no-stdout guarantee, token-file ACLs and
  attribution guards), the Windows runner policy and deny paths, the supervisor's process and argument
  handling, the Tauri capabilities allowlist (shell and opener scopes limited to the sidecar and the
  office URL), and the updater signature.
- QA and code review run after each wave, as usual.

## Critical files
- New: `packages/shared/src/desktop.ts`, `packages/shared/src/securityHeaders.ts`, `packages/setup/**`,
  `packages/hook/office-hook.mjs`, `apps/runner/src/platform.ts`, `apps/server/src/core/web/**`,
  `apps/supervisor/**`, `apps/desktop/**`, `.github/workflows/desktop.yml`, `docs/guide/desktop.md`.
- Changed:
  - apps/runner: `capabilities.ts`, `runProcess.ts`, `spawnPlan.ts`, `config.ts`, `trust.ts`, `toolPolicy.ts`;
  - apps/server: `core/config/merge.ts`, `modules/transcripts/transcripts.paths.ts`;
  - `packages/shared/src/settings.ts` (webDir, corsOrigins);
  - `scripts/{install,doctor,pair}.ts` (thin wrappers);
  - `apps/web/vite.config.ts` and `docker/nginx.conf` (shared headers).

## Verification
- Automated:
  - root `pnpm typecheck`, `pnpm test` and `pnpm test:perf` (hook latency budget), with the
    existing 148 script tests still green;
  - node-hook parity tests, and supervisor tests with fake children;
  - server static-serving and security tests (CSP present, a foreign Origin/Host still refused);
  - runner win32 policy tests, which mock the platform.
- Linux, locally:
  - `pnpm --filter @tagconn/desktop tauri dev`, then run the wizard against a SANDBOXED home
    (`HOME`/`TAGCONN_CONFIG_DIR`/`CLAUDE_CONFIG_DIR` pointing into the scratchpad, never the real
    `~/.claude`);
  - services start, the office opens paired, Stop/Start work, logs stream;
  - a sandboxed `claude -p` session shows up in the office through the node hook;
  - `tauri build` produces a working AppImage.
- Windows:
  - the CI job builds and runs the NSIS installer silently, starts the supervisor headless and checks
    `/api/health` and the served web app;
  - with the user, on a real Windows machine: a manual pass of the wizard, hooks with a real Claude
    session, a haiku quest (plan mode) and the Receptionist, plus the permission deny checks from spike 3;
  - the updater is checked across two tagged pre-releases.
- The live Docker stack keeps working unchanged (`pnpm office:up`).
