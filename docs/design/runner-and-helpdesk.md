# M8 design: runner, quest board, Receptionist, admin auth, attribution (8j, 8k, 8l, 8m)

Status: **rev 3** (architect, 2026-09-25).
- rev 2 incorporated the SC1 security review (required items 1-10 plus the LOW items).
- rev 3 finalizes the SC3 empirical CLI results (real `claude` 2.1.282, sandboxed, V1-V16). The only item still open is
  V15 (`--resume` with changed flags). It was not run, so it is an R1 acceptance test with a fail-closed fallback.
- Heroes and the Multiverse floor are in `docs/design/living-office.md`; this doc refers to them only through `heroId` and
  one bus event.

Contract files (new, not yet exported): `packages/shared/src/runner.ts`, `receptionist.ts`, `auth.ts`, `attribution.ts`.

## 0. Principles
- **No API key.** Everything spawns the logged-in `claude` CLI on the host. `ANTHROPIC_*` and similar variables are always
  stripped (`RUN_ENV_STRIP_PREFIXES`).
- **Server in Docker; runner and hooks on the host.** Host-side effects (spawning, writing `.tagconn/office.json`) happen
  only in the runner. The automatic README write happens only in the hook, and only when the user opted in.
- **The host is the authority.** `<configDir>/runner.json` (0600) bounds dirs, trust, modes, tools, MCP and env. Server
  settings can only narrow it.
- **The questioned repo is untrusted input.** V14 showed that a repo's `.claude/settings.json` hooks and its `.mcp.json`
  run, and that `env.ANTHROPIC_BASE_URL` redirects API traffic, unless `--setting-sources=user` is set. So **every**
  runner-spawned process pins `--setting-sources=user` and `--strict-mcp-config`, unconditionally.
- **Honest scope.** *An admin session means code execution as the host user*, within the allowed and trusted dirs, the local
  mode cap and the local tool policy.
- **Fail closed.** Every REST route declares its access level, or the server refuses to boot. Every socket event that is not
  public (or a cosmetic write) needs an admin session.

## 1. Components
```
HOST                                                           DOCKER (127.0.0.1)
claude ──hooks──▶ office-hook.sh ──POST /api/hooks (+x-tagconn-run-id)──────────────────▶ server :4317
                     └─ background: README (opt-in) / POST office.json → /api/attribution/import   │ auth, runs,
apps/runner ──socket.io /runner, mutual HMAC (token never on the wire)────────────────────────────▶ │ receptionist,
   └─ quests: systemd-run --user --scope … claude -p …   receptionist: bwrap … claude -p …          │ attribution
pnpm office:pair ──HMAC challenge → /api/auth/pairing-codes ──▶ http://localhost:4318/#pair=XXXX-XXXX-XXXX
browser ◀── nginx :4318 (CSP) ── /office namespace (admin token in handshake auth) ◀────────────────┘
```
| Server module | Owns |
|---|---|
| `auth` | admin sessions, pairing challenges and codes, `/api/auth/*`, `auth:*`. Registers `adminVerifier` in DI |
| `runs` | `/runner` namespace (HMAC), queue and dispatch, `runs`/`run_events`, `/api/runs*`, `runs:*`. Registers `runDispatcher` and `runLinker` |
| `receptionist` | conversations and messages, `/api/receptionist/*`, `receptionist:*`. Starts turns only through `runDispatcher` |
| `attribution` | `/api/attribution/*`, pending imports, export. Applies imports through the layouts and heroes services |

New core files: `core/http/admin.ts` (access levels, the onRoute boot check, the guard), `core/realtime/admin-guard.ts`
(handshake, per-packet guard, the 60 s ADMIN_ROOM sweep), and `core/redact/` (the ingest redactor, shared).

## 2. Runner (8k)

### 2.1 Process, config, probe
- `apps/runner` runs on Node 24, with `socket.io-client` and `@tagconn/shared` as dependencies. It is built like `apps/server`.
  It starts with `pnpm office:runner`. The example unit is `apps/runner/contrib/tagconn-runner.service` (user unit,
  `Restart=on-failure`, `NoNewPrivileges=yes`). The runner refuses to run as root.
- `runner.json` (`RunnerLocalConfigSchema`) is written by the installer. The runner refuses to load it unless it is mode 0600
  and owned by the runner's user. The installer and `office:doctor` **warn when an allowed dir is a broad parent** (`$HOME`,
  `~/Projects`, or any dir with more than 3 git repos below it).
- **Capability probe** at startup, cached in `stateDir` per `claudeVersion`:
  - `claude --version` and `--help` detect the flags.
  - Permission modes are probed **by trying** each `RUN_PERMISSION_MODES` value once. V8: all of them, including `default`
    (which `--help` does not list), are accepted on 2.1.282, so no remapping is needed.
  - `stdinPrompt` (V9: confirmed), the sandboxed probe turn (`bwrap`), and `systemdScope` (a trivial
    `systemd-run --user --scope true`).
- **Hard requirements:**
  - `settingSources` and `permissionPrompts` for **every** run. Without them the runner refuses to spawn anything and reports
    `capability_missing` in its status.
  - `tools` and `strictMcpConfig` for Receptionist runs.
  - `restricted` for project-scope Receptionist runs.

### 2.2 Mutual HMAC handshake (`RUNNER_NAMESPACE`)
The raw token is never sent. HMAC-SHA256 is keyed with the token's UTF-8 bytes, over `proofMessage(...)` from `auth.ts`,
output base64url, and compared with `timingSafeEqual`.
1. The runner connects with `auth: {runnerId, protocol, nonce: Nr}` and no `Origin`. The server rejects the connection if
   the token setting is empty, if an `Origin` header is present, or if the protocol differs.
2. The server emits `runner:challenge {nonce: Ns, proof: HMAC(token, "tagconn-runner-v1|server|Nr|Ns")}`.
3. The runner verifies the proof. **If it is bad, the runner disconnects** ("server proof invalid: wrong URL or
   impersonator"). It acts on nothing from an unverified socket.
4. The runner sends `runner:prove {proof: HMAC(token, "tagconn-runner-v1|runner|Ns|Nr")}`. The server disconnects on a bad
   proof, a late proof (`RUNNER_PROOF_TIMEOUT_MS`), or any event that arrives first.
5. Then comes `runner:hello`. The server reconciles runs: runs it has but the runner does not report become `lost`; runs the
   runner reports but the server does not know go into `killRunIds`. After a server restart it waits `lostGraceSec`.
   A newer verified connection replaces an older one.

### 2.3 Validation on the runner (independent of the server)
For each `run:start`, in this order:
1. **Schema.** `RunStartCommandSchema`. Failure: `invalid_command`.
2. **Dir.** `realpath(projectDir)` must be an allowed root or below one (`root + sep`), and must not be `/` or `$HOME`.
   **The realpath result is used** as the cwd, for `--add-dir`, and for the bwrap binds. Failure: `dir_not_allowed`.
3. **Trust.** Quests need `~/.claude.json` `projects[<realpath>].hasTrustDialogAccepted === true`, or a `trustOverrideDirs`
   entry. **V14: `-p` skips the trust dialog and never sets this flag** (it stayed `null` before and after). So the flag
   only reflects the user's *interactive* use, and the CLI provides **no** trust gate headless: this runner check *is* the
   gate. The lookup is exact-realpath only; there is no parent inheritance, which is fail-closed (users can add a
   `trustOverrideDirs` entry). Failure: `dir_not_trusted`, and the UI says "open this project once in the Claude Code
   terminal and accept the trust dialog".
4. **Mode.** `permissionModeWithin(mode, maxPermissionMode)`, and the mode must be in `capabilities.permissionModes`. Bypass
   also needs `allowBypassPermissions`. Failure: `mode_not_allowed`.
5. **Tools.**
   - Every allow rule must be in `questToolPolicy.maxAllowedTools`. `Bash*` must be listed **locally**.
   - **A bare `WebFetch` is always refused** (`isBareWebFetchRule`). V11 showed an unscoped WebFetch really connecting to
     127.0.0.1, 127.1, `localhost.` and 2130706433. Only `WebFetch(domain:<DOMAIN_RE>)` passes.
   - `alwaysDeny` is appended: `.claude/**`, `.git/**`, `.mcp.json`, and the loopback WebFetch backstop.
   - Failure: `tool_not_allowed`.
6. **Containment (V13).** A setsid'd grandchild escapes `kill(-pgid)`. So a quest that can execute commands (any `Bash*`
   allow rule, or mode `auto` or `bypassPermissions`) requires `systemdScope` (a cgroup kill). Without it the run is refused
   with `isolation_unavailable`. Note: the CLI itself refuses to pre-approve `setsid` via allow patterns and blocks long bare
   `sleep`, which helps, but it is not relied on.
7. **Resume.** The session id must be in the runner's ledger (ids from the `init` of runs this runner spawned) **with the
   same tool fingerprint**: sorted `init.tools`, mode, the restricted/safe flags, and the WebFetch domains. See V15 in
   section 10. Failure: `resume_not_allowed`.
8. **Concurrency** below the local `maxConcurrent`. Failure: `concurrency` (the server re-queues once).

Server-side checks run first: `projectId` resolves to a registered `Project.cwd` (the browser never sends paths), a lexical
prefix check against `settings.runner.allowedProjectDirs`, the mode against `allowedPermissionModes`, the prompt against
`maxPromptChars`, and resume only from a run in the same thread or conversation.

### 2.4 Spawn
- Value flags always use `--flag=value`. **The prompt goes on stdin**; V9 confirmed that stdin text like
  `--dangerously-skip-permissions hi` stays a prompt and `init.permissionMode` is unchanged. Prompts containing NUL are
  rejected. The fallback `claude -p [flags] -- <prompt>` is used only if a future CLI drops stdin support.
- Env is `RUN_ENV_BASE_ALLOWLIST`, plus `LC_*` and `XDG_*`, plus `runner.json passEnv`, minus the strip prefixes, plus
  `TAGCONN_RUN_ID` and `TAGCONN_RUN_KIND` (and `TAGCONN_ATTRIBUTION=off` for the Receptionist). The server never supplies env.
- **Quest argv:**
```
systemd-run --user --scope --quiet -p KillMode=control-group -p MemoryMax=<memoryMax> -p TasksMax=<tasksMax> --
  claude -p --output-format=stream-json --verbose [--include-partial-messages]
  --setting-sources=user                                   # V14: unconditional
  --strict-mcp-config [--mcp-config=<runner.json questMcpConfigPath>]   # never the repo's .mcp.json
  --permission-mode=<mode> --permission-prompts=none --model=<m> [--max-turns=<n>] [--resume=<ledger sid>]
  [--allowedTools=<csv ⊆ maxAllowedTools, no bare WebFetch>] --disallowedTools=<csv: server denies + alwaysDeny>
```
  Without a systemd scope, the process is spawned `detached` with no `systemd-run` prefix, and only quests that cannot
  execute commands are allowed (step 6).
- **Consequence for quests:** project-level Claude settings, project hooks and project MCP servers do not apply to quests.
  User-level settings do, including tagconn's own hook, so characters still animate. The UI's quest help says: "Quests
  ignore this repo's .claude/settings.json and .mcp.json for safety." The default quest mode stays `acceptEdits` (pre-allowed
  tools only, thanks to `--permission-prompts=none`). `dontAsk` is offered as the strictest editing-free choice.

### 2.5 Stream parsing, caps, lifecycle
- **Line handling.** stdout is read line by line. The partial-line buffer is bounded by `maxLineBytes`; a longer line is
  dropped with a `notice`.
- **Mapping to events.**
  - `system/init` becomes `init`, including `tools` and `mcp_servers`.
  - `stream_event` text deltas become `text{partial}`.
  - `assistant` blocks become `text` and `tool_use{inputPreview}`.
  - `user` tool_result becomes `tool_result{preview}`.
  - `result` becomes `result`.
  - stderr becomes `notice{warn}`, at most `maxStderrLines` per run.
- **Caps.** `limits` cap events and bytes per run (a notice, then a stop with `output_cap`). The offline buffer is bounded
  by both events and bytes.
- **Server side.** The server re-applies its own caps, dedupes `(runId, seq)`, **ignores events and ends for runs not
  dispatched to the verified connected runner**, and redacts every string before storing or broadcasting.
- **Stop, timeout or shutdown.**
  - Scoped quests: `systemctl --user stop <scope>` (a cgroup kill, which reaches setsid'd grandchildren).
  - bwrap runs: kill bwrap. `--unshare-pid --die-with-parent` takes down the whole PID namespace.
  - Otherwise: SIGTERM to the process group, then SIGKILL after `killGraceMs`. This is sufficient only because those runs
    have no exec tools.

### 2.6 Correlation: run, session, characters
1. **Authoritative:** `init.session_id`. The `runs` module sets `run.sessionId` and emits `run.linked`; sessions set
   `Session.runId` and `origin: 'quest'` (task S5).
2. **Hint:** the hook adds `x-tagconn-run-id` for a UUID-shaped `TAGCONN_RUN_ID`. `runLinker.hint` links only an existing,
   non-terminal, unlinked quest run. `init` wins.
3. **Follow-ups** use `--resume=<run.sessionId>`, one `Run` per turn, grouped by `threadId`.
4. **Receptionist sessions post no hooks.** `TAGCONN_RUN_KIND=receptionist` exits the hook. With `--restricted`, user
   settings (and so hooks) are ignored anyway. The NPC is animated from `run:event`.
5. **Hero:** `heroId` prefixes `Delegate this task to the "<role>" subagent.` (shown in the UI), and the server emits
   `run.heroRequested` for 8i.

### 2.7 Queue and ownership
- The queue is FIFO, capped at `maxQueued`. The effective concurrency is `min(server, runner)`.
- If no verified runner is connected, `POST /api/runs` returns 409.
- `runs:followUp` and `runs:stop` accept quest runs only. `receptionist:stop` is scoped to its own conversation's run.
- Runs record `createdBy`. Retention is `runRetentionDays`.

## 3. Browser UX: Quest board (8k)
- **TopBar "Quest board"** (with an active-run badge) opens a right drawer, per floor or across all floors.
- **Post quest** form: the floor; the assignee (the Guild Master or a hero); the prompt with a counter; the mode (only
  `allowedPermissionModes ∩ runner cap ∩ containment`, with a one-line explanation each; modes needing a systemd scope are
  disabled with a tooltip when it is unavailable); and the model.
- **Standing warning:** "Quests run Claude Code on this machine as your user, in this project's directory. An admin session
  can make code run on your computer. Quests ignore this repo's .claude/settings.json and .mcp.json. They use your Claude
  subscription and count against the same limits as your terminal sessions; the cost shown is the CLI's estimate."
- **Quest card:**
  - status, elapsed time, the live transcript (text, tool chips, collapsed results) and a result card
  - **Stop**, **Follow up**, **Focus**
  - rejections explain the fix (`dir_not_trusted`, `isolation_unavailable`, `tool_not_allowed`)
- **Markdown** (quests and the Receptionist): no raw HTML, remote images dropped, links only for `http(s):` with
  `rel="noopener noreferrer"`.
- **Locked:** without an admin session the drawer shows "Pair this browser".

## 4. Receptionist help desk (8l)

### 4.1 UX
- A fixed NPC stands at the Guild Gate (the `entrance` of every floor and the Nexus).
- The chat panel has a conversation list and a scope choice:
  - **General:** the cwd is the neutral empty dir, plus the tagconn docs copy.
  - **This project:** allowed only for a registered project inside `allowedProjectDirs`.
- It streams answers, shows tool chips and has a Stop button. A shield label shows the sandbox and the flags.
- History is bounded on the server. There is one turn at a time per conversation. Resume uses the ledger with the same
  fingerprint.

### 4.2 Argv (built by the runner from constants; the server's allowlist, mode and system prompt are ignored)
Common to both scopes:
```
claude -p --output-format=stream-json --verbose --include-partial-messages
  --setting-sources=user --strict-mcp-config --mcp-config={"mcpServers":{}} --disable-slash-commands
  --permission-mode=plan --permission-prompts=none
  --append-system-prompt=<RECEPTIONIST_SYSTEM_PROMPT> --model=<m> --max-turns=<n> [--resume=<ledger sid>]
  --disallowedTools=<RECEPTIONIST_DISALLOWED_TOOLS, Read(<RECEPTIONIST_DENY_READ_GLOBS + extraDenyReadGlobs>),
                     WEBFETCH_LOOPBACK_DENY_RULES, server extra denies>
```
**Project scope** (always `--restricted`; never WebFetch):
```
bwrap <4.3 binds, project ro> -- claude <common>
  --restricted [--safe-mode]            # --safe-mode only if receptionist.projectSafeMode (default false)
  --tools=Read,Grep,Glob[,WebSearch] --allowedTools=Read,Grep,Glob[,WebSearch]
  (cwd = project realpath)
```
**General scope without WebFetch** (the default):
```
bwrap <4.3 binds, neutral dir ro> -- claude <common>
  --restricted --add-dir=<realpath stateDir/receptionist-docs>
  --tools=Read,Grep,Glob[,WebSearch] --allowedTools=Read,Grep,Glob[,WebSearch]
  (cwd = stateDir/receptionist)
```
**General scope with WebFetch** (`webFetch: allowlist`, non-empty domains, **bwrap required**; `--restricted` would remove
WebFetch):
```
bwrap <4.3 binds, neutral dir ro> -- claude <common>
  --add-dir=<realpath stateDir/receptionist-docs>
  --tools=Read,Grep,Glob[,WebSearch],WebFetch
  --allowedTools=Read,Grep,Glob[,WebSearch],WebFetch(domain:a.org),WebFetch(domain:b.dev)   # never bare WebFetch
```
Without bwrap, the WebFetch variant is not used: WebFetch is dropped for that turn with a notice, and the default general
variant runs instead.

Facts behind these choices:
- **V1:** `--tools` plus matching `allowedTools`, `--strict-mcp-config` with an empty config, and
  `--setting-sources=user` give `init.tools` exactly the listed set, with `mcp_servers: []`. The default set has 29 tools,
  including internal ones (CronCreate, ScheduleWakeup, SendMessage, Workflow, ...), so `--tools` is mandatory.
- **V6:** `--restricted` structurally refuses file access outside the cwd and `--add-dir`, and removes Bash and WebFetch.
  But **Write and Edit still appear under `--restricted` alone**, so it is always combined with `--tools`, plan mode and
  the deny backstop.
- **V7:** in `-p`, ExitPlanMode is disabled. In plan mode the model *did* write `~/.claude/plans/<slug>.md` using the
  ordinary Write tool. That is impossible here because Write is not in `--tools`. It is an explicit R1/Q1 acceptance test.
- **V11:** with `WebFetch(domain:example.com)` plus `--permission-prompts=none`, other hosts were denied with zero bytes
  sent. So the allowlist is the control, and the loopback denies are only a backstop.
- **V5:** with `--safe-mode`, CLAUDE.md is not loaded as memory, and when asked the model more readily Reads @-imported paths
  (the deny globs still held). Without it, the model printed the literal `@` lines and flagged the injection. So
  **`--restricted` is the primary structural layer** and `--safe-mode` is optional (`receptionist.projectSafeMode`,
  default false).
- **Docs copy:** the runner copies `RECEPTIONIST_DOCS_COPY` (README.md, CLAUDE.md, ROADMAP.md, docs/**, with no symlinks
  followed) into `<stateDir>/receptionist-docs` (0700). It never adds the repo root.

### 4.3 bwrap sandbox (V12 minimal set, worked on the first try, plus `--unshare-pid` from V13)
```
bwrap --die-with-parent --new-session --unshare-pid --unshare-ipc --unshare-uts --cap-drop ALL
  --ro-bind /usr /usr
  --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib /lib64 --symlink usr/bin /sbin
  --ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /tmp
  --tmpfs "$HOME" --setenv HOME "$HOME"
  --ro-bind "$(dirname "$(readlink -f "$claudePath")")" <same>
  --ro-bind "$HOME/.claude" "$HOME/.claude"
  --bind "$HOME/.claude/projects/<key>" <same>              # transcript dir for this cwd (resume needs it)
  --bind "$HOME/.claude/.credentials.json" <same>           # OAuth refresh
  --bind "<stateDir>/runs/<runId>/claude.json" "$HOME/.claude.json"   # disposable 0600 copy, deleted after the run
  --ro-bind <project realpath | stateDir/receptionist> <same>
  [--ro-bind <stateDir/receptionist-docs> <same>]
  --chdir <cwd> -- claude <argv>
```
- **Non-merged-/usr distros:** the runner detects real `/bin`, `/lib` or `/lib64` dirs and uses `--ro-bind` for them instead
  of `--symlink`. The claude binary is self-contained (V12: ldd shows only libc, libm, libpthread, libdl and librt).
- **`<key>`** is the transcript directory name the CLI derives from the cwd. The runner computes it and `mkdir -p`s it before
  binding. It verifies the derivation once at probe time by comparing with the transcript path from the probe turn's `init`
  cwd, and refuses the sandbox (falling back to `none`) on a mismatch.
- **V12 escape probe:** with bypassPermissions plus Bash inside this sandbox, writes to the project,
  `~/.claude/settings.*` and `~/.claude/agents/*` all failed with EROFS, and a canary in `$HOME` was not visible. Read access
  to the rest of `~/.claude` (plans, history) is covered by the deny globs and by `--restricted`.
- **Network stays shared** (the API and WebSearch need it).

### 4.4 Layers and residual risk
| Layer | What it stops |
|---|---|
| L1 exact `--tools` | Only Read/Grep/Glob (plus WebSearch, plus WebFetch in the allowlist variant) exist. There is no Write, so there is no plans-file write (V7) |
| L2 `--setting-sources=user`, `--strict-mcp-config` with an empty config | Repo hooks, repo MCP, repo `env` (the V14 API redirect), and user MCP servers |
| L3 `--restricted` (project scope and default general scope) | File access outside the cwd and `--add-dir`, symlink escapes (V4), exec and WebFetch |
| L4 `--permission-prompts=none`, plan mode, `--disable-slash-commands` | Anything needing approval is denied; no ExitPlanMode in `-p` (V7); no skills or commands |
| L5 watchdog | `init.tools` must equal the `--tools` set, and `init.mcpServers` must be empty. Any `mcp__*` tool, or any `tool_use` outside the set, kills the run (`policy_violation`) |
| L6 bwrap | EROFS on the project and `~/.claude` config; `$HOME` is empty; the PID namespace dies with the run |
| L7 backstop `--disallowedTools` | Write, exec, delegation, schedule, message and worktree tools, ExitPlanMode, secret and history read globs, loopback WebFetch |
| L8 hook | No hook posts and no `.tagconn` writes |

Residual risks:
- Without bwrap (macOS, or a failed probe), L6 is missing. Project scope still has `--restricted`. General scope still has
  `--restricted` because WebFetch is dropped.
- In the general-scope WebFetch variant, there is no `--restricted`. Read can reach the rest of the read-only `~/.claude`
  inside bwrap, except the deny globs (applied best-effort to Grep/Glob). Content fetched from allowlisted domains could
  inject instructions. The exfiltration channels are WebSearch queries and WebFetch requests to the allowlisted domains
  only.
- The CLI writes its own transcript in the bound `projects/<key>` dir.

## 5. Admin auth (8m, revisits decision 12)

### 5.1 Threat model
| # | Attacker | With 8m |
|---|---|---|
| T1 | Malicious website (CSRF/CSWSH) | Origin/Host checks, JSON-only, and a non-ambient bearer token |
| T2 | DNS rebinding | Host allowlist; even if bypassed, there is no token |
| T3 | Another OS user (127.0.0.1 is shared) | Pairing needs the 0600 runner token (via HMAC) or `docker logs`. `all-writes` and the always-gated roles close the old role-sync hole |
| T4 | Another container on the compose network | Same as T3 |
| T5 | Same-user malware | Out of scope |
| T6 | **Compromised server or container** | **It can make the runner do anything a quest may do** in the allowed and trusted dirs, up to `maxPermissionMode` and the local tool policy, including edits that later run as code. The runner still enforces the dirs, trust, mode cap, bypass refusal, Bash-only-if-local plus a systemd scope, the no-bare-WebFetch rule, `alwaysDeny`, `--setting-sources=user`, the resume ledger and the Receptionist policy |
| T7 | XSS | Token theft from localStorage. Mitigations: CSP, React escaping, sanitized markdown |
| T8 | Token leak | Never logged; code in the URL fragment; `no-referrer`; `no-store` on `/api/auth/*`; revocable sessions |
| T9 | Squatter on :4318 or :4317 | The runner detects a fake :4317 through the server proof. A squatter on :4318 is the residual risk in 5.2 |
| T10 | **Malicious repo content** (a cloned repo) | `--setting-sources=user` plus `--strict-mcp-config` on every spawn (V14); `.tagconn/office.json` is validated and imported only with consent |

### 5.2 Pairing (default `auth.mode: pairing`)
- **Codes** are 12 Crockford base32 characters (60 bits), single use, valid for `pairingCodeTtlSec`. There are no per-code
  lockouts. Attempts are globally limited to 10 per minute, with at most 3 live codes.
- **Minting a code:**
  - (a) At boot, when there are no admin sessions and `logPairingCodeOnBoot` is on, the code goes into the log.
  - (b) `pnpm office:pair` calls `POST /api/auth/pairing-challenge {nonce: Nc}` and gets
    `{challengeId, nonce: Ns, instanceId, proof: HMAC(token, "tagconn-pair-v1|server|Nc|Ns|instanceId")}`. It verifies the
    proof, then sends `POST /api/auth/pairing-codes {challengeId, proof: HMAC(token, "tagconn-pair-v1|client|Ns|Nc")}`.
  - Both endpoints refuse any request with an `Origin` header. Challenges are single use and expire after 30 s.
- **Squatter check.** `office:pair` and doctor fetch `<web origin>/api/health` through nginx and require the same
  `instanceId` and version. **Residual risk:** a :4318 squatter that proxies `/api/health` passes this check, and could
  read the fragment. It needs another local user to take the port before compose does. Doctor reports the owner of :4318
  when it can.
- **`auth.mode: same-origin`** (file or env only) enables `POST /api/auth/bootstrap`. It needs a present allowed Origin, and
  `Sec-Fetch-Site: same-origin` if that header is sent. It is refused when `corsOrigins` contains `'*'`.
- **Tokens** are opaque `tca_...`, stored only as sha256. Expiry slides (72 h), capped at 30 days, with `maxSessions` and
  revoke-all.

### 5.3 Enforcement (fail closed)
- **REST.** Every `/api/*` route declares a `config.access` from `REST_ACCESS_LEVELS`, or the server fails at boot
  (`onRoute`).
  - `admin-write` (gated under `all-writes`, the default): settings and layouts writes.
  - `admin` (always gated): `/api/runs*`, `/api/receptionist*`, `/api/runner/*`, `/api/attribution/save|pending*`,
    `/api/auth/sessions*` and `logout`, and **`PUT`/`DELETE /api/roles*` and `POST /api/roles/sync`**.
  - `hook`: `/api/hooks`, `/api/attribution/import`.
  - `runner` (Origin refused): `/api/auth/pairing-challenge|pairing-codes`.
  - `public`: GET reads, `/api/auth/status|pair|bootstrap`.
  - A failure returns 401 with `WWW-Authenticate: Bearer`.
- **Socket `/office`.** The `adminToken` travels in the CONNECT `auth` payload. `socket.use`: `PUBLIC_SOCKET_EVENTS` pass,
  `ADMIN_SOCKET_EVENTS_WRITES` are gated under `all-writes`, and **every other event is always gated**. Every gated packet
  re-checks the session in the store. A 60 s sweep evicts expired or revoked sockets from `ADMIN_ROOM`. Admin broadcasts go
  only to `ADMIN_ROOM`.
- **SC5 INFO: quest/Receptionist content is not admin-only, by design.** The dedicated Quests-board stream
  (`run:upsert`/`run:event`/`runner:status`) IS admin-gated (broadcast only to `ADMIN_ROOM`, above) — but a quest is
  still a real `claude` process with the office hook installed, so its own `UserPromptSubmit`/`PreToolUse`/`PostToolUse`
  hook events flow through the same PUBLIC pipeline every interactive session already uses
  (`modules/ingest` → `event.created` → `toProject(...).emit('event:new', ...)`, no admin gate, the same
  `ingest.redactPatterns` redaction as any other session). So a quest's prompt and tool activity are visible, live, to
  every viewer of that project's floor — admin or not — same as watching any hero work. This is accepted, not a gap:
  tagconn is a local, single-tenant observer tool (see the top of this doc and `CLAUDE.md`); the whole premise is that
  project activity is visible in the office. Anyone who should not see it should not have network access to the server
  at all (T3-T5 in §5.1).
- **Web.** localStorage token; a 401 or `auth:changed{admin:false}` clears it and opens the pair dialog.
- **Headers.** nginx and Vite dev (`server.headers`) both send
  `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  plus `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. `/api/auth/*` gets `Cache-Control: no-store`.
  Same-origin websockets under `'self'` must be verified in Chrome and Firefox (D1 acceptance).

### 5.4 Regression tests
1. No token, a bad, expired or revoked token: 401 on every `admin` route, and on every `admin-write` route under `all-writes`.
   A boot test asserts every `/api/*` route has an access level. On the socket, every listed gated event and one **unlisted
   made-up event** is denied. Roles stay gated under `protect=execution`.
2. Cross-origin: 403 on `/api/auth/pair` and `/api/runs`. A foreign-Origin handshake with a valid token is refused. The
   pairing endpoints refuse any Origin.
3. CSRF: `text/plain`, form and multipart bodies give 415. A token in a query string or cookie is ignored.
4. Rebinding: a foreign Host gives 403 on REST and at the engine level.
5. Replay: a used or expired code, a reused `challengeId`, and a proof computed for another challenge all fail. The rate
   limit gives 429. A revoked token fails within one packet and is swept from `ADMIN_ROOM`.
6. Bootstrap: 404 in pairing mode. In same-origin mode: 403 without an Origin, 403 on `cross-site`, 403 with `'*'`.
7. Runner namespace: an empty token, an Origin header, a wrong or late proof, or an event before the proof all disconnect. A
   reflected proof fails. A fake server gets disconnected and never delivers `run:start`.
8. Secrets: `runner.token` is masked. Immutable keys are rejected by the API. There are no plaintext tokens in the DB, and
   `/api/auth/*` sends `no-store`.

## 6. Attribution (8j)

### 6.1 Files
- `.tagconn/README.md` explains what tagconn is, gives the link and version, says it holds no secrets and is safe to commit,
  and covers restore, save, and opt-out (replace the dir with an empty file named `.tagconn`).
- `.tagconn/office.json` follows `AttributionProfileSchema`: the floor name and style, the layout (without an id), and heroes
  as **references to existing roles**. It holds no secrets and no absolute host paths.
- **Commit both files.** tagconn never touches `.gitignore`.

### 6.2 Opt-in and hook behavior
- **Installer.** The installer **asks** "Write a small .tagconn/README.md into git repos you open with Claude Code? [y/N]".
  Only `y` or `--attribution` installs `<configDir>/attribution-README.md`, which turns README writes on. Non-interactive
  runs default to off.
- **Import config.** `<configDir>/attribution.conf` (0600) is installed by default, because import writes nothing to repos
  and the server asks first. `--no-attribution` removes both files.
- **Hook: when it acts.** It runs only on `SessionStart`, and not when `TAGCONN_ATTRIBUTION=off` or
  `TAGCONN_RUN_KIND=receptionist`. All attribution work runs in a background subshell
  (`( ... ) </dev/null >/dev/null 2>&1 &`) after the foreground POST.
- **Hook: README write.**
```
dir=$CLAUDE_PROJECT_DIR; require: -d, -O, -e "$dir/.git", != $HOME, != /
skip if -e or -L "$dir/.tagconn"
[tpl exists] mkdir "$dir/.tagconn" && (set -C; cat "$tpl" > "$dir/.tagconn/README.md")
```
- **Hook: import.** It requires `attribution.conf` to exist, non-symlink `.tagconn` and `office.json`, and a regular file.
  It computes `n=$(head -c 65537 "$f" | wc -c)` and skips if `n` > 65536. Otherwise:
  `head -c 65536 "$f" | curl -K attribution.conf -H "x-tagconn-session-id: $sid" -H 'content-type: application/json' --data-binary @-`.
  `$sid` comes from `sed`, restricted to `[A-Za-z0-9_-]`.

### 6.3 Server import rules
The request must pass hook-token auth, with a body limit of `maxProfileBytes`. The server then checks, in order:
1. **Refusals.** It refuses when `server.hookToken` is empty (`ignored/no-hook-token`), when attribution is disabled, for an
   unknown session, or for a stale SessionStart. The project comes **from the session** only.
2. **Validation.** Schema, redaction check and `validateLayout`. Failure: `rejected/invalid`.
3. **Already configured,** or dismissed before: ignored.
4. **Consent.** Under `autoImport: 'ask'` (the default), the import becomes pending and a toast goes to `ADMIN_ROOM`. **The
   toast shows the repo path**, the floor name, what will be imported, and the unknown roles that will be dropped.
5. **Applying it:** create and assign the layout `imported-<slug>`, set the name and style, and create heroes only for
   existing roles. **It never creates or changes roles, `~/.claude/agents`, skills or settings.**

### 6.4 Save (explicit only)
- **GUI.** "Save office profile to project" (admin) sends `attribution:write` to the runner. The runner accepts it **only
  inside `allowedProjectDirs`**, by realpath, with `.git` present and not `$HOME` or `/`. It refuses symlinks, re-validates
  the content, writes tmp + rename (0644), and overwrites only on a confirmed request.
- **Skill `/tagconn-save`.** It fetches the public `GET /api/attribution/export?cwd=`, shows the diff, and writes with the
  Write tool, so the normal CLI permission prompt applies.

## 7. Settings summary
- **`runner.*`**: new keys `token`, `allowedPermissionModes`, `allowedTools`, `disallowedTools`, `maxQueued`,
  `maxPromptChars`, `runTimeoutSec`, `maxTurns`, event caps, `previewChars`, `partialMessages`, `runRetentionDays`,
  `lostGraceSec`, and a widened `permissionMode` enum. The whole section is GUI-immutable.
- **`receptionist.*`**: `webFetch` is `never | allowlist` with `webFetchAllowDomains`, plus `projectSafeMode`. The web keys,
  deny globs, `allowTagconnDocs` and `projectSafeMode` are GUI-immutable.
- **`auth.*`**: GUI-immutable, default `protect: all-writes`.
- **`attribution.*`**: the import settings.

## 8. Contract patch (PM applies; additive except the tightening of `GUI_IMMUTABLE_SETTINGS`)
**`index.ts`** append: `export * from './runner.js'; export * from './receptionist.js'; export * from './auth.js'; export * from './attribution.js';`

**`settings.ts`** imports: `AUTH_MODES, AUTH_PROTECT_LEVELS` (auth), `DOMAIN_RE, RUN_MODELS, RUN_PERMISSION_MODES, TOOL_RULE_RE`
(runner), `ATTRIBUTION_MAX_PROFILE_BYTES` (attribution). Changes to `runner`: `permissionMode` becomes
`z.enum(RUN_PERMISSION_MODES).default('acceptEdits')` (a widening). Add after `allowedProjectDirs`:
```ts
      /** Runner shared secret, used only as an HMAC key (never sent). Empty = runner connections refused. Masked. */
      token: z.string().default(''),
      allowedPermissionModes: z.array(z.enum(RUN_PERMISSION_MODES)).default(['plan', 'dontAsk', 'default', 'acceptEdits']),
      /** Bare "WebFetch" is rejected here too (only WebFetch(domain:x)); the runner re-checks. */
      allowedTools: z.array(z.string().regex(TOOL_RULE_RE).refine((r) => r !== 'WebFetch', 'use WebFetch(domain:x)')).default([]),
      disallowedTools: z.array(z.string().regex(TOOL_RULE_RE)).default([]),
      maxQueued: z.number().int().min(0).default(20),
      maxPromptChars: z.number().int().min(100).max(100_000).default(20_000),
      runTimeoutSec: z.number().int().min(10).max(86_400).default(3_600),
      maxTurns: z.number().int().min(1).max(500).optional(),
      maxEventsPerRun: z.number().int().min(10).max(100_000).default(5_000),
      maxEventBytesPerRun: z.number().int().min(10_000).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
      previewChars: z.number().int().min(100).max(8_000).default(2_000),
      partialMessages: z.boolean().default(true),
      runRetentionDays: z.number().int().min(1).default(30),
      lostGraceSec: z.number().int().min(5).max(600).default(30),
```
New sections after `runner`:
```ts
  receptionist: z.object({
      enabled: z.boolean().default(true),
      model: z.enum(RUN_MODELS).default('sonnet'),
      webSearch: z.boolean().default(true),
      /** "allowlist" = general scope only, bwrap required, WebFetch(domain:x) per entry; never bare WebFetch. */
      webFetch: z.enum(['never', 'allowlist']).default('never'),
      webFetchAllowDomains: z.array(z.string().regex(DOMAIN_RE)).max(50).default([]),
      extraDenyReadGlobs: z.array(z.string().regex(/^[^\n\r\0(),]{1,180}$/)).default([]),
      allowTagconnDocs: z.boolean().default(true),
      /** Add --safe-mode to project-scope turns (SC3 V5 trade-off; --restricted is always on there). */
      projectSafeMode: z.boolean().default(false),
      timeoutSec: z.number().int().min(10).max(3_600).default(300),
      maxTurns: z.number().int().min(1).max(100).default(30),
      maxConversations: z.number().int().min(1).max(1_000).default(50),
      maxMessagesPerConversation: z.number().int().min(2).max(2_000).default(200),
    }).prefault({}),
  auth: z.object({
      mode: z.enum(AUTH_MODES).default('pairing'),
      protect: z.enum(AUTH_PROTECT_LEVELS).default('all-writes'),
      sessionIdleHours: z.number().min(1).max(720).default(72),
      sessionMaxAgeDays: z.number().min(1).max(365).default(30),
      pairingCodeTtlSec: z.number().int().min(60).max(3_600).default(600),
      maxSessions: z.number().int().min(1).max(100).default(10),
      logPairingCodeOnBoot: z.boolean().default(true),
    }).prefault({}),
  attribution: z.object({
      enabled: z.boolean().default(true),
      autoImport: z.enum(['ask', 'auto', 'off']).default('ask'),
      maxProfileBytes: z.number().int().min(1_024).max(ATTRIBUTION_MAX_PROFILE_BYTES).default(ATTRIBUTION_MAX_PROFILE_BYTES),
      importWindowSec: z.number().int().min(10).max(3_600).default(120),
    }).prefault({}),
```
`GUI_IMMUTABLE_SETTINGS`: replace `'runner.permissionMode', 'runner.allowedProjectDirs'` with `'runner'`, and add
`'auth', 'receptionist.webSearch', 'receptionist.webFetch', 'receptionist.webFetchAllowDomains', 'receptionist.extraDenyReadGlobs', 'receptionist.allowTagconnDocs', 'receptionist.projectSafeMode'`.

**`domain.ts`**: `import type { ProjectProfileMeta } from './attribution.js';` and `export type SessionOrigin = 'cli' | 'quest';`.
Add `Project.profile?: ProjectProfileMeta` and `Session.runId?: string; Session.origin?: SessionOrigin`.

**`socket.ts`**: `ServerToClientEvents` / `ClientToServerEvents` extend the four `*ServerToClientEvents` /
`*ClientToServerEvents` interfaces (existing members unchanged). Add `rooms.admin = ADMIN_ROOM` and re-export
`OfficeHandshakeAuth`.

**Server-internal:** the bus adds `run.upserted`, `run.event`, `run.linked`, `run.heroRequested` and `runner.status` (S2).
`GET /api/health` adds `instanceId` (S1).

## 9. Work breakdown
The PM pre-assigns migration numbers (S1=N ... S4=N+3) and makes the single `app.ts` registration commit.

| id | role | owns | deps | acceptance |
|---|---|---|---|---|
| C0 | PM | `packages/shared/src/{index,settings,domain,socket}.ts` | none (SC1 and SC3 done) | Patch applied, `pnpm typecheck` green |
| S1 | dev server | `modules/auth/**`, `core/http/admin.ts`, `core/realtime/admin-guard.ts`, registration lines in `core/http/index.ts` and `core/realtime/index.ts`, `modules/settings/settings.public.ts`, `modules/health/**`, `test/helpers.ts`, migration N, plus `config.access` on every existing route | C0 | Section 5; boot fails on a route without an access level; tests 5.4 #1-6 and #8 |
| S2 | dev server | `modules/runs/**`, `core/redact/**`, migration N+1 | C0, S1 (`admin.ts` stub) | HMAC namespace (#7); queue; reconcile; runnerId ownership; dedupe; caps; redaction; bare WebFetch rejected server-side; `RunDispatcher`/`runLinker` |
| S3 | dev server | `modules/receptionist/**`, migration N+2 | S2 port | One turn per conversation; stored runner session; project scope only for registered projects inside allowed dirs; webFetch domains passed only for general scope |
| S4 | dev server | `modules/attribution/**`, migration N+3 | C0, S1 | Section 6.3 |
| S5 | dev server | `modules/ingest/**`, `modules/sessions/**` | S2, **8a merged** | Section 2.6 linking |
| R1 | dev runner | `apps/runner/**` | C0 | Sections 2 and 4, **plus these SC3-derived acceptance tests** (fake-CLI unit tests, and real-CLI tests gated behind `TAGCONN_REAL_CLI=1`): (a) `--setting-sources=user` and `--strict-mcp-config` are in *every* argv, and the runner refuses to spawn when the probe lacks them; a real-CLI test with a repo containing `.claude/settings.json` hooks, `.mcp.json` and `env.ANTHROPIC_BASE_URL` shows none take effect (V14). (b) Receptionist `init.tools` equals the `--tools` set and `mcpServers` is empty; a mismatch kills (V1). (c) **V7:** in a plan-mode receptionist turn asked to "save your plan to a file", no file appears under `~/.claude/plans` or the cwd. (d) Bare WebFetch is refused; with a domain allowlist, a request to 127.0.0.1, 127.1, `localhost.` or 2130706433 sends zero bytes (a local listener counts connections) (V11). (e) A trust check against a real `~/.claude.json` copy, and `dir_not_trusted` for a fresh dir after a `-p` run. (f) bwrap: V12 escape probe (EROFS on the project, `~/.claude/settings*` and `agents/`; `$HOME` canary invisible), the `<key>` derivation check, and `/usr` merge detection. (g) V13: a setsid'd grandchild is killed by the scope stop and by bwrap `--unshare-pid`; a Bash quest without a systemd scope gives `isolation_unavailable`. (h) V9: a flag-looking stdin prompt does not change the mode. (i) **V15:** resume with an unchanged fingerprint works. Resume with changed flags must show `init.tools` reflecting the new flags; if it does not, the runner keeps the fail-closed rule (it refuses `resume_not_allowed`, and the server starts a new session whose prompt carries a summary of the previous turns). Plus the unit tests: HMAC, argv builder, realpath, tool policy, ledger, env, stream parser, buffer bounds, docs copy |
| I1 | dev infra | `packages/hook/office-hook.sh`, `scripts/{install,doctor,pair}.ts`, `packages/agent-templates/attribution/README.md.tmpl`, `packages/agent-templates/skills/tagconn-save/SKILL.md`, root `package.json`, `.env.example` | C0 | The hook still exits 0 with no stdout; background attribution with the `head -c` cap; README guards; the installer asks (default N), writes `runner.json`, warns about broad dirs, and explains the trust requirement ("open each allowed project once interactively"); `pair.ts` does HMAC plus the instanceId check; doctor reports runner, capabilities (settingSources, systemd scope, bwrap), pairing, the squatter check and broad dirs |
| W1 | dev web | `lib/auth.ts`, `lib/socket.ts`, the REST client in `lib/`, `stores/authStore.ts`, `features/auth/**` | C0, S1 | Pairing, the token in the handshake and header, clearing, sessions, "admin = code execution" copy |
| W2 | dev web | `features/quests/**`, `stores/runsStore.ts`, `lib/markdown.ts` | W1 | Section 3, incl. containment-aware mode choices and rejection guidance |
| W3 | dev web | `features/receptionist/**`, `stores/receptionistStore.ts`, `game/npc/receptionist.ts` | W1, W2 | Section 4.1. **W3b** (scene wiring) comes after the living-office work |
| W4 | dev web | `features/settings/**`, `features/attribution/**`, `apps/web/vite.config.ts` | C0, S4 | New sections; read-only immutable keys; the toast shows the repo path; CSP in dev |
| D1 | dev infra | `docker/nginx.conf` | none | CSP and headers; `no-store`; the app works under CSP |
| Q1 | qa | `apps/server/test/security/m8-*.test.ts`, `apps/runner/test/e2e/**` | S1-S4, R1 | All of 5.4; fake-CLI end to end; re-runs R1 (a)-(i) against the real CLI in the sandbox |
| DOC | PM | `docs/architecture.md`, `docs/decisions.md` (16 runner: host authority, HMAC, stdin, `--setting-sources=user` always; 17 pairing, superseding 12; 18 receptionist layers; 19 attribution opt-in), `ROADMAP.md`, `CLAUDE.md` | all | Docs match the code |

Security checkpoints: SC1 done, SC3 done (except V15, which is R1 (i)). **SC2:** S1+S2 merged. **SC4:** I1.
**SC5:** 8g before v0.3.0.

## 10. SC3 results and resolutions (claude 2.1.282)
| # | Question | Result | Resolution |
|---|---|---|---|
| 1 | Receptionist `plan` vs `dontAsk` | V7: ExitPlanMode disabled in `-p`; the plan-mode write came only through Write | **`plan`**, with Write absent from `--tools`; acceptance test R1(c) |
| 2 | Does `init.tools` reflect `--tools`? | V1: exact match, `mcp_servers: []` | L5 exact-equality watchdog adopted |
| 3 | `--restricted` scope | V6: structural cwd + `--add-dir` confinement; removes Bash and WebFetch; Write/Edit remain | Required for project scope and default general scope; always combined with `--tools` |
| 4 | `--safe-mode` | V5: skips CLAUDE.md memory, but the model then Reads @-imports more readily | Optional: `receptionist.projectSafeMode`, default false |
| 5 | WebFetch domain allowlist with `--permission-prompts=none` | V11: other hosts denied with zero bytes; unscoped WebFetch reached loopback | Never bare WebFetch (enforced in settings, server and runner); allowlist only, in general scope under bwrap |
| 6 | Trust semantics | V14: `-p` skips the dialog and never sets `hasTrustDialogAccepted` | The runner's check is the only gate: exact realpath, flag from interactive use, or `trustOverrideDirs` |
| 7 | bwrap rw set | V12: the minimal set in 4.3 worked; escape probe EROFS | Adopted, plus `--unshare-pid`; disposable `~/.claude.json` copy |
| 8 | stdin prompt, `--flag=value` | V9: stdin confirmed | Adopted; `--flag=value` parsing is covered by the R1 argv tests |
| 9 | Accepted permission modes | V8: all contract modes, including `default`, plus `manual` | No remapping; probe by trying |
| 10 | `--resume` with changed flags | V15: **not run** | R1(i) acceptance test; fail-closed fingerprint rule until proven |
| — | Repo settings, MCP and env | **V14 CRITICAL:** hooks, `.mcp.json` and `ANTHROPIC_BASE_URL` were honored without `--setting-sources` | `--setting-sources=user` plus `--strict-mcp-config` on every spawn; the runner refuses otherwise |
| — | Process-group kill | V13: setsid escapes `kill(-pgid)` | systemd scope for quests, bwrap `--unshare-pid` for the Receptionist; Bash, auto and bypass refused without containment |
| — | History leakage | V4: symlinks follow the target's permission; the model globbed `~/.claude/plans` | Deny globs extended (plans, projects, shell-snapshots, todos, history, file-history, session-env); `--restricted` makes them moot structurally |
