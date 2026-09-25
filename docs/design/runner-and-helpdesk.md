# M8 design: runner, quest board, Receptionist, admin auth, attribution (8j, 8k, 8l, 8m)

Status: **rev 2** (architect, 2026-09-25). This revision includes the SC1 security review ("approve with required changes",
items 1-10 plus the LOW items). Spots marked **TBD by SC3** wait for the empirical CLI checks (V1-V16) and will be finalized
when the PM sends the results. Heroes and the Multiverse floor are in `docs/design/living-office.md`; this doc refers to them
only through `heroId` and one bus event.

Contract files (new, not yet exported): `packages/shared/src/runner.ts`, `receptionist.ts`, `auth.ts`, `attribution.ts`.

## 0. Principles
- **No API key.** Everything spawns the logged-in `claude` CLI on the host. `ANTHROPIC_*` and similar variables are always
  stripped (`RUN_ENV_STRIP_PREFIXES`).
- **Server in Docker; runner and hooks on the host.** Host-side effects (spawning, writing `.tagconn/office.json`) happen
  only in the runner. The automatic README write happens only in the hook, and only when the user opted in.
- **The host is the authority.** `<configDir>/runner.json` (0600) bounds dirs, trust, modes, tools and env. Server settings
  can only narrow it.
- **Honest scope.** *An admin session means code execution as the host user*, within the allowed and trusted dirs, the local
  mode cap and the local tool policy. The UI, the docs and the installer say so in those words.
- **Fail closed.** Every REST route declares its access level, or the server refuses to boot. Every socket event that is not
  explicitly public (or a cosmetic write) needs an admin session.

## 1. Components
```
HOST                                                           DOCKER (127.0.0.1)
claude ──hooks──▶ office-hook.sh ──POST /api/hooks (+x-tagconn-run-id)──────────────────▶ server :4317
                     └─ background: README (opt-in) / POST office.json → /api/attribution/import   │ auth, runs,
apps/runner ──socket.io /runner, mutual HMAC (token never on the wire)────────────────────────────▶ │ receptionist,
   └─ [systemd-run --user --scope] [bwrap] claude -p --output-format=stream-json ...                │ attribution
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
  and owned by the runner's user. Its fields:
  - `url`, `token`
  - `allowedProjectDirs` (from `--runner-allow <dir>`)
  - `trustOverrideDirs`, `questToolPolicy`
  - `maxConcurrent`, `maxPermissionMode` (default `acceptEdits`), `allowBypassPermissions` (false)
  - `passEnv`, `processIsolation`, `memoryMax`, `tasksMax`, `receptionistSandbox`
  - buffer caps
- The installer and `office:doctor` **warn when an allowed dir is a broad parent** (`$HOME`, `~/Projects`, or any dir with
  more than 3 git repos below it): "every repo below this can be modified by quests started from the browser".
- **Capability probe** at startup:
  - `claude --version` and `claude --help` (flag presence) fill `RunnerCapabilities`: `tools`, `permissionPrompts`,
    `disableSlashCommands`, `restricted`, `safeMode`, `settingSources`, `strictMcpConfig`, `includePartialMessages`.
  - The accepted `--permission-mode` values fill `permissionModes`. Whether `--help` lists them is **TBD by SC3**; otherwise
    they come from a probe run.
  - `stdinPrompt`, `bwrap` (a sandboxed one-turn probe) and `systemdScope` come from short probe runs.
  - The results are cached in `stateDir` per `claudeVersion`.
  - **No run starts without `permissionPrompts`. Receptionist runs also need `tools`.** Otherwise the run is rejected with
    `capability_missing`.

### 2.2 Mutual HMAC handshake (`RUNNER_NAMESPACE`), required change 1
The raw token is never sent. HMAC-SHA256 is keyed with the token's UTF-8 bytes, over `proofMessage(...)` from `auth.ts`,
output base64url, and compared with `timingSafeEqual`.
1. The runner connects with `auth: {runnerId, protocol, nonce: Nr}` and no `Origin`. The server rejects the connection if
   `settings.runner.token` is empty, if an `Origin` header is present, or if the protocol differs.
2. The server emits `runner:challenge {nonce: Ns, proof: HMAC(token, "tagconn-runner-v1|server|Nr|Ns")}`.
3. The runner verifies the proof. **If it is bad, the runner disconnects and logs "server proof invalid: wrong URL or
   impersonator"** (for example, a squatter on :4317 while Docker is down). It acts on nothing from an unverified socket;
   before verification it only handles `runner:challenge`.
4. The runner sends `runner:prove {proof: HMAC(token, "tagconn-runner-v1|runner|Ns|Nr")}`. The server disconnects if the
   proof is bad, if it arrives after `RUNNER_PROOF_TIMEOUT_MS`, or if any other event comes first. Ns is fresh for each
   connection, so replays fail.
5. Then comes `runner:hello`. The server reconciles runs: runs it has but the runner does not report become `lost`; runs the
   runner reports but the server does not know go into `killRunIds`. After a server restart it waits `lostGraceSec`.
   A newer verified connection replaces an older one.

### 2.3 Validation on the runner (independent of the server)
For each `run:start`, in this order:
1. **Schema.** `RunStartCommandSchema`. Failure: `invalid_command`.
2. **Dir.** `realpath(projectDir)` must equal an allowed root, or start with `root + sep`. It must not be `/` or `$HOME`.
   **The realpath result is what is used** as the cwd and for `--add-dir`. `null` is allowed only for `readOnly` (the neutral
   dir). Failure: `dir_not_allowed`.
3. **Trust (required change 4).** Quests need `~/.claude.json`
   `projects[<realpath>].hasTrustDialogAccepted === true`, or the dir must be under a `trustOverrideDirs` entry. Parent-dir
   and worktree semantics are **TBD by SC3**. Failure: `dir_not_trusted`. The UI says "open this project once in the CLI and
   accept the trust dialog".
4. **Mode.** `permissionModeWithin(mode, maxPermissionMode)`. Bypass also needs `allowBypassPermissions`. The mode is mapped
   to a CLI value through `CLI_PERMISSION_MODE_CANDIDATES` ∩ `capabilities.permissionModes` (CLI 2.1.282 has no `default`;
   it maps to `manual`). Failure: `mode_not_allowed`.
5. **Tools.** Every server `allowedTools` rule must be in `questToolPolicy.maxAllowedTools`. `Bash*` rules are allowed only if
   listed there **locally** (the default list has no Bash). `alwaysDeny` (the defaults deny Edit and Write on `.claude/**`,
   `.git/**` and `.mcp.json`) is always appended. Failure: `tool_not_allowed`.
6. **Resume.** `resumeSessionId` must be in the runner's session ledger (ids from `init` events of runs this runner
   spawned; bounded by `sessionLedgerSize`). Failure: `resume_not_allowed`.
7. **Concurrency** below the local `maxConcurrent`. Failure: `concurrency` (the server re-queues once).

Server-side checks run first: `projectId` resolves to a registered `Project.cwd` (the browser never sends paths), a lexical
prefix check against `settings.runner.allowedProjectDirs`, the mode against `allowedPermissionModes`, the prompt against
`maxPromptChars`, and resume only from a run in the same thread or conversation.

### 2.4 Spawn
- Value flags always use the **`--flag=value`** form, and the prompt goes on **stdin**. So no variadic flag can swallow
  anything, and a prompt can never become a flag. Prompts containing NUL are rejected. If the probe says stdin is
  unsupported, the fallback is `claude -p [flags] -- <prompt>`.
- With `processIsolation` set to `auto` (when `systemdScope` is available), the command is wrapped as
  `systemd-run --user --scope --quiet -p KillMode=control-group -p MemoryMax=<memoryMax> -p TasksMax=<tasksMax> -- ...`.
  Otherwise the process is spawned `detached` (its own process group), with no shell.
- Env is `RUN_ENV_BASE_ALLOWLIST`, plus `LC_*` and `XDG_*`, plus `runner.json passEnv`, minus the strip prefixes, plus
  `TAGCONN_RUN_ID` and `TAGCONN_RUN_KIND` (and `TAGCONN_ATTRIBUTION=off` for the Receptionist). The server never supplies env.

Quest argv:
```
claude -p --output-format=stream-json --verbose [--include-partial-messages]
  --permission-mode=<cli mode> --permission-prompts=none --model=<m> [--max-turns=<n>] [--resume=<ledger sid>]
  [--allowedTools=<csv ⊆ maxAllowedTools>] --disallowedTools=<csv: server denies + alwaysDeny>
```
Should quests default to `dontAsk`? It combines well with `--permission-prompts=none`: only pre-allowed tools run. The final
default is **TBD by SC3**. The current settings default stays `acceptEdits`.

### 2.5 Stream parsing, caps, lifecycle
- **Line handling.** stdout is read line by line. The partial-line buffer is bounded by `maxLineBytes`; a longer line is
  dropped with a `notice`.
- **Mapping to events.**
  - `system/init` becomes `init`.
  - `stream_event` text deltas become `text{partial}`.
  - `assistant` blocks become `text` and `tool_use{inputPreview}`.
  - `user` tool_result becomes `tool_result{preview}`.
  - `result` becomes `result`.
  - stderr becomes `notice{warn}`, at most `maxStderrLines` per run.
- **Caps.** `limits` cap events and bytes per run (a `notice`, then a stop with `output_cap`). The offline buffer is bounded
  by both `offlineBufferEvents` and `offlineBufferBytes`; when it overflows, the oldest events are dropped and one notice is
  sent.
- **Server side.** The server re-applies its own caps (it never trusts runner sizes), dedupes `(runId, seq)`, **ignores
  events and ends for runs not dispatched to the verified connected runner** (the `run.runnerId` ownership check), and
  redacts every string (`core/redact`, `ingest.redactPatterns`) before storing or broadcasting.
- **Stop, timeout or shutdown.** The process group gets SIGTERM (or the systemd scope is stopped), then SIGKILL after
  `killGraceMs`.

### 2.6 Correlation: run, session, characters
Hooks fire for quest sessions, so quest characters animate like manual ones.
1. **Authoritative:** the `init.session_id`. The `runs` module sets `run.sessionId`, emits `run.linked`, and sessions set
   `Session.runId` and `origin: 'quest'` (task S5).
2. **Hint:** the hook adds `x-tagconn-run-id` (only for a UUID-shaped `TAGCONN_RUN_ID`). `runLinker.hint` links only an
   existing, non-terminal, unlinked quest run. A forged header can at most mislabel a badge. `init` wins.
3. **Follow-ups** use `--resume=<run.sessionId>`, one `Run` per turn, grouped by `threadId`.
4. **Receptionist sessions post no hooks**: `TAGCONN_RUN_KIND=receptionist` exits the hook, and with `--restricted` or
   `--safe-mode` hooks are not loaded at all. The NPC is animated from `run:event`.
5. **Hero:** `heroId` prefixes the prompt with `Delegate this task to the "<role>" subagent.` (shown in the UI), and the
   server emits `run.heroRequested` for the heroes module (8i).

### 2.7 Queue and ownership
- The queue is FIFO, capped at `runner.maxQueued`. The effective concurrency is
  `min(settings.runner.maxConcurrent, hello.maxConcurrent)`.
- If no verified runner is connected, `POST /api/runs` returns 409.
- `runs:followUp` and `runs:stop` accept **quest** runs only. `receptionist:stop` is scoped to its own conversation's
  active run.
- Every run records `createdBy` (the admin session) for the audit log.
- Retention is `runner.runRetentionDays`.

## 3. Browser UX: Quest board (8k)
- **TopBar "Quest board"** (with an active-run badge) opens a right drawer, per floor or across all floors.
- **Post quest** form:
  - the floor
  - the assignee: the Guild Master or a hero on this floor
  - the prompt, with a counter
  - the mode: only `allowedPermissionModes ∩ runner cap`, with a one-line explanation each
  - the model
- **Standing warning:** "Quests run Claude Code on this machine as your user, in this project's directory. An admin session
  can make code run on your computer. They use your Claude subscription and count against the same limits as your terminal
  sessions. The cost shown is the CLI's estimate." Rate-limit results show a banner.
- **Quest card:**
  - status, elapsed time, and the live transcript: text, tool chips, collapsed results
  - a result card: turns, duration, tokens, the estimated cost
  - **Stop** (with confirm), **Follow up**, and **Focus**, which follows the linked Guild Master
  - clicking a tool chip focuses its character
  - rejections explain what to do (for example `dir_not_trusted`: "open the project once in the CLI and accept the trust
    dialog")
- **Markdown** (quests and the Receptionist): no raw HTML, **remote images dropped**, and links only for `http(s):`, with
  `rel="noopener noreferrer"` and `target=_blank`. All other schemes are rendered as text.
- **Locked:** without an admin session the drawer shows "Pair this browser". The office stays viewable.

## 4. Receptionist help desk (8l)

### 4.1 UX
- A fixed NPC stands at the Guild Gate (the `entrance` of every floor and the Nexus). It is not an Agent.
- The chat panel has a conversation list and a scope choice:
  - **General:** tagconn and general questions. The cwd is the neutral empty dir, plus the docs copy.
  - **This project:** allowed only for a **registered project whose cwd is inside `allowedProjectDirs`**. There is no
    separate read-only dir list in M8.
- The panel streams answers, shows tool chips and has a Stop button.
- A shield label shows the sandbox (`bwrap`/`none`) and the flags (`restricted`, `safe-mode`).
- History is on the server, bounded by `maxConversations` and `maxMessagesPerConversation`. There is one turn at a time per
  conversation. Turns after the first use `--resume=<conversation.sessionId>`, which must be in the runner's session ledger.

### 4.2 Argv (built by the runner from constants; the server's allowlist, mode and system prompt are ignored)
```
[systemd-run ...] [bwrap ... --] claude -p --output-format=stream-json --verbose --include-partial-messages
  --permission-mode=plan --permission-prompts=none                 # plan vs dontAsk: TBD by SC3
  --tools=Read,Grep,Glob[,WebSearch][,WebFetch]                    # exact set = receptionistToolSet(...)
  [--allowedTools=WebFetch(domain:a.org),WebFetch(domain:b.dev)]   # only in webFetch=allowlist mode
  --disallowedTools=<RECEPTIONIST_DISALLOWED_TOOLS, Read(<deny globs>), WebFetch loopback denies, server extra denies>
  --disable-slash-commands --strict-mcp-config --mcp-config={"mcpServers":{}}
  [--restricted]                    # when probed; else --setting-sources=user
  [--safe-mode]                     # project scope, if SC3 confirms it composes with --resume/--tools (TBD by SC3)
  --append-system-prompt=<RECEPTIONIST_SYSTEM_PROMPT> --model=<m> --max-turns=<n>
  [--add-dir=<realpath of stateDir/receptionist-docs>] [--resume=<ledger sid>]
```
- `--restricted` confines file tools to the cwd plus `--add-dir`, removes exec tools, ignores user, project and local
  settings, and protects settings and git files. Exactly what it covers is **TBD by SC3**.
- **Docs copy (required change 6).** At startup, and when the tagconn version changes, the runner copies
  `RECEPTIONIST_DOCS_COPY` (README.md, CLAUDE.md, ROADMAP.md, docs/**, with no symlinks followed) from its own checkout into
  `<stateDir>/receptionist-docs` (0700). It never adds the repo root, so `.env`, `data/` and `config/` stay out of reach.
- **WebFetch (required change 8).** With `webFetch: never` (the default), WebFetch is not in `--tools`. With `allowlist`,
  WebFetch is in `--tools` and only `WebFetch(domain:x)` allow rules for `webFetchAllowDomains` (GUI-immutable) are passed.
  With `--permission-prompts=none`, other domains are denied (**TBD by SC3**). The loopback and metadata denies stay as a
  backstop.
- **WebSearch** is allowed (a PM decision) unless `receptionist.webSearch=false`.

### 4.3 bwrap sandbox (required change 3; `receptionistSandbox: auto|bwrap`)
```
bwrap --die-with-parent --new-session --unshare-pid --unshare-ipc --unshare-uts --cap-drop ALL
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 --ro-bind /etc /etc
  --ro-bind <realpath of claude install dir> <same>          # plus the node runtime if the CLI needs it
  --proc /proc --dev /dev --tmpfs /tmp
  --tmpfs $HOME                                               # home is empty by default
  --ro-bind <project realpath> <same>        (project scope)  |  --bind <neutral dir> <same>  (general scope)
  --ro-bind <stateDir>/receptionist-docs <same>
  --bind  ~/.claude/projects/<cwd key>  <same>                # session transcript (needed for --resume)
  --bind  ~/.claude/<todos|state dirs>  <same>                # exact set TBD by SC3
  --bind  ~/.claude/.credentials.json   <same>                # OAuth refresh; TBD by SC3 whether rw is required
  --ro-bind-try ~/.claude/{settings.json,settings.local.json,agents,skills,commands,plugins,hooks,CLAUDE.md} <same>
  --bind <disposable copy of ~/.claude.json> ~/.claude.json   # unless SC3 proves the CLI tolerates EROFS on it
  --chdir <cwd> -- <claude argv>
```
- **Network stays shared.** The CLI needs the API, and WebSearch needs it too.
- **Probe.** At startup the runner does one probe turn under exactly this sandbox. If it fails, it falls back to `none`,
  reports it in the UI, and keeps L1-L5.
- The rw set above is the **minimum to be confirmed empirically** (TBD by SC3). Nothing else under `$HOME` exists inside the
  sandbox, so `~/.ssh` and friends are unreadable there. That is a confidentiality gain on top of the deny globs.

### 4.4 Layers and residual risk
| Layer | What it stops |
|---|---|
| L1 exact `--tools` set | Only Read/Grep/Glob (plus the web tools when enabled) exist for the model |
| L2 `--permission-prompts=none`, `plan` mode, `--disable-slash-commands` | Anything needing approval is denied; no slash commands or skills |
| L3 `--strict-mcp-config`, empty config | No MCP servers, so no MCP write tools |
| L4 `--restricted` (else `--setting-sources=user`), `--safe-mode` in project scope when confirmed | Repo hooks, repo allow rules, CLAUDE.md, plugins, file access outside cwd and `--add-dir` |
| L5 watchdog | The set of `init.tools` must **exactly equal** the `--tools` set. Any `mcp__*` tool, or any `tool_use` outside the set, kills the process group at once (`policy_violation`) |
| L6 bwrap (Linux) | The kernel refuses writes to projects and home; secrets outside the binds are unreadable |
| L7 backstop `--disallowedTools` | Write, exec, delegation and worktree tools, ExitPlanMode, secret read globs, loopback WebFetch |
| L8 hook | No hook posts and no `.tagconn` writes for the Receptionist |

Residual risks:
- Without bwrap (macOS, or a failed probe), L1-L5 are CLI policy, not kernel enforcement.
- Read can still reach files inside the cwd and the docs copy, which is by design, and anything the deny globs miss when
  neither `--restricted` nor bwrap is active.
- WebSearch queries are a low-bandwidth exfiltration channel for injected content.
- WebFetch in allowlist mode can reach whatever the allowed domains serve.
- The CLI writes its own session state under `~/.claude`.

## 5. Admin auth (8m, revisits decision 12)

### 5.1 Threat model
| # | Attacker | With 8m |
|---|---|---|
| T1 | Malicious website (CSRF/CSWSH) | Origin/Host checks, JSON-only, and a bearer token that is never ambient (not a cookie) |
| T2 | DNS rebinding | Host allowlist; even if bypassed, there is no token |
| T3 | Another OS user (127.0.0.1 is shared) | Pairing needs the 0600 runner token (via HMAC) or `docker logs`. `all-writes` and the always-gated roles close the old role-sync hole |
| T4 | Another container on the compose network (`Host: server`) | Same as T3 |
| T5 | Same-user malware | Out of scope (it can run `claude` itself) |
| T6 | **Compromised server or container** | **It can make the runner do anything a quest may do**: in the allowed and trusted dirs, up to `maxPermissionMode`, with the local tool policy. With acceptEdits that includes edits which later run as code (for example package scripts). The runner still enforces the dirs, trust, mode cap, bypass refusal, the Bash-only-if-local rule, `alwaysDeny`, the resume ledger and the Receptionist policy |
| T7 | XSS | Token theft from localStorage. Mitigations: CSP, React escaping, the sanitized markdown rules in section 3 |
| T8 | Token leak | Tokens are never logged; the code is in the URL fragment; `Referrer-Policy: no-referrer`; `Cache-Control: no-store` on `/api/auth/*`; sessions are revocable |
| T9 | Squatter on :4318 or :4317 | The runner detects a fake :4317 through the server proof. A squatter on :4318 can read the `#pair=` fragment when the user opens the URL (the residual risk below) |

### 5.2 Pairing (default `auth.mode: pairing`)
- **Why pairing and not a plain same-origin bootstrap:** a same-origin bootstrap adds nothing against T3 and T4, because
  non-browser clients can forge Origin and Host.
- **Codes** are 12 Crockford base32 characters (60 bits), single use, valid for `pairingCodeTtlSec`. There are **no per-code
  lockouts**; that would let anyone burn the user's code, a cheap DoS. Attempts are globally limited to 10 per minute, and at
  most 3 codes are live at once.
- **Minting a code:**
  - (a) At boot, when no admin session exists and `logPairingCodeOnBoot` is on, the code goes into the log.
  - (b) `pnpm office:pair` (`scripts/pair.ts`, which reads `runner.json`) calls `POST /api/auth/pairing-challenge {nonce: Nc}`
    and gets back `{challengeId, nonce: Ns, instanceId, proof: HMAC(token, "tagconn-pair-v1|server|Nc|Ns|instanceId")}`.
    It verifies the proof (aborting on a mismatch: "not talking to your tagconn server"), then sends
    `POST /api/auth/pairing-codes {challengeId, proof: HMAC(token, "tagconn-pair-v1|client|Ns|Nc")}`.
  - Both endpoints **refuse any request that carries an `Origin` header** (browsers never use them). Challenges are single
    use and expire after 30 s.
- **Squatter check (T9).** Before printing the URL, `office:pair` fetches `GET <web origin>/api/health` through the nginx
  proxy and requires its `instanceId` (and version) to equal the HMAC-bound `instanceId`. `office:doctor` runs the same
  check.
- **Residual risk:** a process that owns :4318 and *proxies* `/api/health` to the real server passes this check, and could
  read the fragment from the page it serves. It needs another local user to grab the port before compose does. That is
  documented, and doctor also reports which process owns :4318 when it can tell.
- **`auth.mode: same-origin`** (file or env only) enables `POST /api/auth/bootstrap`. It needs a *present* allowed Origin and
  `Sec-Fetch-Site: same-origin` if that header is sent. It is **refused when `corsOrigins` contains `'*'`**. This keeps
  decision 12's "local processes are trusted" posture.
- **Tokens** are opaque (`tca_...`). Only their sha256 is stored, in `admin_sessions`, so there is no signing secret. Expiry
  slides with `sessionIdleHours` (72 h), capped by `sessionMaxAgeDays` (30). At most `maxSessions` exist. Revoke-all is
  available.

### 5.3 Enforcement (fail closed, required change 5)
- **REST.**
  - Every `/api/*` route sets `config.access` to one of `REST_ACCESS_LEVELS`. An `onRoute` hook **throws at boot** if one is
    missing.
  - `admin-write` routes are gated when `protect=all-writes` (the confirmed default): settings and layouts writes.
  - `admin` routes are always gated:
    - `/api/runs*`, `/api/receptionist*`, `/api/runner/*`
    - `/api/attribution/save|pending*`
    - `/api/auth/sessions*` and `/api/auth/logout`
    - **`PUT`/`DELETE /api/roles*` and `POST /api/roles/sync`** (these write into `~/.claude/agents`)
  - `hook` routes: `/api/hooks`, `/api/attribution/import`.
  - `runner` routes (Origin refused): `/api/auth/pairing-challenge|pairing-codes`.
  - `public` routes: GET reads, `/api/auth/status|pair|bootstrap`.
  - A failure returns 401 `{error, statusCode}` with `WWW-Authenticate: Bearer`.
- **Socket `/office`.**
  - The `adminToken` travels in the CONNECT `auth` payload.
  - `socket.use` checks every packet: `PUBLIC_SOCKET_EVENTS` pass; `ADMIN_SOCKET_EVENTS_WRITES` need an admin session when
    `all-writes`; **every other event needs an admin session**.
  - For every gated packet, the session is **re-checked against the store** (expiry and revocation).
  - Denied packets get the ack `{ok:false, error:'admin session required'}`.
  - A **sweep every `ADMIN_ROOM_SWEEP_MS` (60 s)** evicts expired or revoked sockets from `ADMIN_ROOM` and emits
    `auth:changed`. Revocation also evicts immediately.
  - Admin-only broadcasts (runs, runner status, receptionist, pending imports) go only to `ADMIN_ROOM`.
- **Web.** The token is kept in localStorage. A 401 or `auth:changed{admin:false}` clears it and opens the pair dialog.
- **Headers (required change 7).**
  - nginx and **Vite dev (`server.headers`)** both send
    `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`.
    There is no `ws:`/`wss:` wildcard; same-origin websockets are covered by `'self'`, which must be verified in Chrome and
    Firefox. Vite HMR in dev may need its own origin added only in dev.
  - Also sent: `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
  - `/api/auth/*` responses get `Cache-Control: no-store`.

### 5.4 Regression tests
1. No token, a bad, expired or revoked token: 401 on every `admin` route, and on every `admin-write` route under `all-writes`.
   A boot-time test asserts that every registered `/api/*` route has an access level. On the socket, every event in
   `ADMIN_SOCKET_EVENTS_EXECUTION`, `ADMIN_SOCKET_EVENTS_WRITES` and one **unlisted made-up event** is denied. Roles events
   stay denied even under `protect=execution`.
2. Cross-origin: 403 on `/api/auth/pair` and `/api/runs`. A foreign-Origin socket handshake with a valid token is refused.
   `pairing-challenge` and `pairing-codes` with *any* Origin give 403.
3. CSRF: `text/plain`, form and multipart bodies give 415. A token in a query string or cookie is ignored.
4. Rebinding: a foreign Host gives 403 on REST and at the engine level.
5. Replay: a used code, an expired code, a reused `challengeId`, and a proof computed for another challenge all fail. The
   rate limit gives 429. A revoked token fails on an open socket within one packet, and the sweep evicts it from
   `ADMIN_ROOM`.
6. Bootstrap: 404 in pairing mode. In same-origin mode: 403 without an Origin, 403 on `cross-site`, and 403 when
   `corsOrigins` includes `'*'`.
7. Runner namespace: an empty token setting, an Origin header, a wrong proof, a late proof, or an event before the proof all
   disconnect. A reflected server proof used as the runner proof fails. A runner-side test confirms a fake server with a bad
   proof gets disconnected and never receives `run:start`. The admin token does not work as runner proof.
8. Secrets: `runner.token` is masked. `auth.*`, `runner.*`, the receptionist web keys and `extraDenyReadGlobs` are rejected
   by the API. No plaintext tokens are in the DB. `/api/auth/*` sends `no-store`.

## 6. Attribution (8j)

### 6.1 Files
- `.tagconn/README.md` explains:
  - what tagconn is, the repo link, and the version
  - that it holds no secrets and is safe to commit
  - how to restore on another host: install, then open the project; the profile is offered for import
  - how to save (`/tagconn-save` or the GUI button)
  - how to opt out: replace the dir with an empty *file* named `.tagconn`
- `.tagconn/office.json` follows `AttributionProfileSchema`: the floor name and style, the layout (without an id), and heroes
  as **references to roles**. It holds no secrets and no absolute host paths (the schema rejects them, and redaction-pattern
  hits are rejected). **Commit both files.** tagconn never touches `.gitignore`.

### 6.2 Opt-in and hook behavior
- **Installer.** The installer **asks** "Write a small .tagconn/README.md into git repos you open with Claude Code? [y/N]".
  Only `y` or `--attribution` installs `<configDir>/attribution-README.md` (the rendered template), whose presence turns
  README writes on. Non-interactive runs default to **off**.
- **Import config.** `<configDir>/attribution.conf` (0600, a curl config with the token header and the import URL) is
  installed by default, because import writes nothing to repos and the server asks before applying anything.
  `--no-attribution` removes both files.
- **Hook: when it acts.** It runs only on `SessionStart`, and not when `TAGCONN_ATTRIBUTION=off` or
  `TAGCONN_RUN_KIND=receptionist`. **All attribution work runs in a background subshell** (`( ... ) </dev/null >/dev/null 2>&1 &`)
  after the foreground hook POST, so it adds no latency.
- **Hook: README write.**
```
dir=$CLAUDE_PROJECT_DIR; require: -d, -O (owned by user), -e "$dir/.git", != $HOME, != /
skip if -e or -L "$dir/.tagconn"                               # never overwrite, never follow symlinks
[tpl exists] mkdir "$dir/.tagconn" && (set -C; cat "$tpl" > "$dir/.tagconn/README.md")
```
- **Hook: import.** It requires `attribution.conf` to exist, `.tagconn` and `office.json` to be non-symlinks, and
  `office.json` to be a regular file. It then checks the size with `n=$(head -c 65537 "$f" | wc -c)` and skips the import
  if `n` > 65536. Otherwise it runs
  `head -c 65536 "$f" | curl -K attribution.conf -H "x-tagconn-session-id: $sid" -H 'content-type: application/json' --data-binary @-`.
  `$sid` comes from `sed`, restricted to `[A-Za-z0-9_-]`.

### 6.3 Server import rules
The request must pass hook-token auth, with a body limit of `maxProfileBytes`. The server then checks, in order:
1. **Refusals.** It refuses when `server.hookToken` is **empty** (`ignored/no-hook-token`), when attribution is disabled, for
   an unknown session, or for a SessionStart older than `importWindowSec`. The project is derived **from the session** only.
2. **Validation.** Schema, redaction check and `validateLayout`. Any failure gives `rejected/invalid`.
3. **Already configured.** The project has a layout, a hero or a profile, or the user dismissed an import before:
   `ignored/already-configured` or `ignored/dismissed-before`.
4. **Consent.** Under `autoImport: 'ask'` (the default), the import becomes pending and `attribution:pending` goes to
   `ADMIN_ROOM`. **The toast shows the repo path** (`projectCwd`), the floor name, what will be imported, and which hero roles
   are unknown and would be dropped.
5. **Applying it:** create and assign the layout `imported-<slug>`, set the name and style, create heroes **only for roles
   that already exist**, and set `Project.profile`. **It never creates or changes roles, `~/.claude/agents`, skills or
   settings (required change 10).**

### 6.4 Save (explicit only)
- **GUI.** "Save office profile to project" (admin) sends `attribution:write` to the runner. The runner accepts it **only
  inside `allowedProjectDirs`**, checked by realpath, with `.git` present and not `$HOME` or `/`. It refuses a symlinked
  `.tagconn` or `office.json`, re-validates the content, and writes tmp + rename (0644). It overwrites only on a confirmed
  `overwrite: true`.
- **Skill `/tagconn-save`.** It fetches the public `GET /api/attribution/export?cwd=` (which contains nothing beyond
  snapshot data), shows the diff, and writes the file with the Write tool, so the normal CLI permission prompt applies.

## 7. Settings summary
- **`runner.*`**: new keys `token`, `allowedPermissionModes`, `allowedTools`, `disallowedTools`, `maxQueued`,
  `maxPromptChars`, `runTimeoutSec`, `maxTurns`, `maxEventsPerRun`, `maxEventBytesPerRun`, `previewChars`,
  `partialMessages`, `runRetentionDays`, `lostGraceSec`, and a widened `permissionMode` enum. The **whole section is
  GUI-immutable**.
- **`receptionist.*`**: `webFetch` is `never | allowlist`, with `webFetchAllowDomains`. The web keys, the deny globs and
  `allowTagconnDocs` are GUI-immutable.
- **`auth.*`**: GUI-immutable, with the default `protect: all-writes`.
- **`attribution.*`**: the server-side import settings.

## 8. Contract patch (PM applies after review; additive except the tightening of `GUI_IMMUTABLE_SETTINGS`)
**`index.ts`** append: `export * from './runner.js'; export * from './receptionist.js'; export * from './auth.js'; export * from './attribution.js';`

**`settings.ts`** imports: `AUTH_MODES, AUTH_PROTECT_LEVELS` (auth), `DOMAIN_RE, RUN_MODELS, RUN_PERMISSION_MODES, TOOL_RULE_RE`
(runner), `ATTRIBUTION_MAX_PROFILE_BYTES` (attribution). Changes to `runner`: `permissionMode` becomes
`z.enum(RUN_PERMISSION_MODES).default('acceptEdits')`, a widening that keeps existing values valid. Add after
`allowedProjectDirs`:
```ts
      /** Runner shared secret, used only as an HMAC key (never sent). Empty = runner connections refused. Masked. */
      token: z.string().default(''),
      allowedPermissionModes: z.array(z.enum(RUN_PERMISSION_MODES)).default(['plan', 'default', 'acceptEdits']),
      allowedTools: z.array(z.string().regex(TOOL_RULE_RE)).default([]),
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
      webFetch: z.enum(['never', 'allowlist']).default('never'),
      webFetchAllowDomains: z.array(z.string().regex(DOMAIN_RE)).max(50).default([]),
      extraDenyReadGlobs: z.array(z.string().regex(/^[^\n\r\0(),]{1,180}$/)).default([]),
      allowTagconnDocs: z.boolean().default(true),
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
`'auth', 'receptionist.webSearch', 'receptionist.webFetch', 'receptionist.webFetchAllowDomains', 'receptionist.extraDenyReadGlobs', 'receptionist.allowTagconnDocs'`.
No new restart-required keys.

**`domain.ts`**: `import type { ProjectProfileMeta } from './attribution.js';` and `export type SessionOrigin = 'cli' | 'quest';`.
Add `Project.profile?: ProjectProfileMeta` and `Session.runId?: string; Session.origin?: SessionOrigin`.

**`socket.ts`**: `ServerToClientEvents extends RunsServerToClientEvents, ReceptionistServerToClientEvents, AuthServerToClientEvents, AttributionServerToClientEvents`.
`ClientToServerEvents extends` the four `*ClientToServerEvents` interfaces. Existing members stay unchanged. Add
`rooms.admin = ADMIN_ROOM` and re-export `OfficeHandshakeAuth`.

**Server-internal (task owners):**
- The event bus adds `run.upserted`, `run.event`, `run.linked`, `run.heroRequested` and `runner.status` (S2).
- `GET /api/health` adds `instanceId` (S1).

## 9. Work breakdown
The PM pre-assigns migration numbers (S1=N ... S4=N+3) and makes the single `app.ts` registration commit.

| id | role | owns | deps | acceptance |
|---|---|---|---|---|
| C0 | PM | `packages/shared/src/{index,settings,domain,socket}.ts` | SC1 done | Patch applied, `pnpm typecheck` green |
| S1 | dev server | `modules/auth/**`, `core/http/admin.ts`, `core/realtime/admin-guard.ts`, registration lines in `core/http/index.ts` and `core/realtime/index.ts`, `modules/settings/settings.public.ts` (mask `runner.token`), `modules/health/**` (`instanceId`), `test/helpers.ts` (`adminHeaders()`), migration N; **plus adding `config.access` to every existing route** (settings, roles, layouts, hooks, health...) | C0 | Section 5 complete; boot fails on a route without an access level; tests 5.4 #1-6 and #8; existing tests green |
| S2 | dev server | `modules/runs/**`, `core/redact/**`, migration N+1 | C0, S1 (`admin.ts` API, stub on day 1) | HMAC namespace (test #7); queue; reconcile; runnerId ownership; dedupe; server caps; redaction; resume only within a thread; `RunDispatcher`/`runLinker` in DI |
| S3 | dev server | `modules/receptionist/**`, migration N+2 | S2 port | One turn per conversation; resume from the stored runner session; project scope only for registered projects inside allowed dirs; webFetch domains from settings; eviction bounds |
| S4 | dev server | `modules/attribution/**`, migration N+3 | C0, S1 | Section 6.3, including `no-hook-token`, roles only referenced (never created), `projectCwd` and `unknownRoles` in pending; save only through the runner |
| S5 | dev server | `modules/ingest/**`, `modules/sessions/**` | S2, **8a merged** | Hint and `init` linking rules in 2.6 |
| R1 | dev runner | `apps/runner/**` | C0, **SC3 results** for the TBD items | Sections 2.1-2.5, 4.2, 4.3. Unit tests: HMAC both directions (bad server proof leads to a disconnect and no `run:start` handled); argv builder (`--flag=value`, stdin, `--` fallback, NUL rejected, receptionist ignores server allow/mode/prompt); realpath and trust checks (symlink escape, `/a/b` vs `/a/bc`); tool policy (Bash refused unless local; `alwaysDeny` appended); session ledger; env allowlist and `passEnv`; stream parser on fixtures; all buffer bounds; kill of the process group or scope; exact-set watchdog; bwrap argv snapshot; docs copy without symlinks |
| I1 | dev infra | `packages/hook/office-hook.sh`, `scripts/{install,doctor,pair}.ts`, `packages/agent-templates/attribution/README.md.tmpl`, `packages/agent-templates/skills/tagconn-save/SKILL.md`, root `package.json` (`office:runner`, `office:pair`), `.env.example` | C0 | The hook still always exits 0 with no stdout; attribution work runs in the background with the `head -c` cap; README only in owned git repos, never in `$HOME` or `/`, never over an existing file or symlink; receptionist env skips everything. The installer asks before README writes (default N), writes `runner.json`, generates the token, handles `--runner-allow`, and warns about broad parents; tested with a sandboxed `--claude-dir`/`--config-dir`. `pair.ts` does the HMAC flow plus the instanceId check through :4318. Doctor reports runner, pairing, the squatter check and broad dirs |
| W1 | dev web | `lib/auth.ts`, `lib/socket.ts`, the REST client in `lib/`, `stores/authStore.ts`, `features/auth/**` | C0, S1 | Handles `#pair=` (then clears it), the handshake token and header, clears the token on 401 or `auth:changed`, session list and revoke, the "admin = code execution" copy |
| W2 | dev web | `features/quests/**`, `stores/runsStore.ts`, `lib/markdown.ts` (the sanitized renderer, shared with W3) | W1 | Section 3 incl. the markdown rules, rejection guidance and the demo quest |
| W3 | dev web | `features/receptionist/**`, `stores/receptionistStore.ts`, `game/npc/receptionist.ts` (new file) | W1, W2 (`markdown.ts`) | Section 4.1, the sandbox and flags label. **W3b** (scene wiring) comes after the living-office game work |
| W4 | dev web | `features/settings/**`, `features/attribution/**`, `apps/web/vite.config.ts` (CSP via `server.headers`) | C0, S4 | New sections render; immutable keys are shown read-only; the pending toast shows the repo path and unknown roles; the app works under CSP in dev |
| D1 | dev infra | `docker/nginx.conf` | none | CSP and headers from 5.3, `no-store` on `/api/auth/`; the app works (Phaser, blob textures, websocket) |
| Q1 | qa | `apps/server/test/security/m8-*.test.ts`, `apps/runner/test/e2e/**` | S1-S4, R1 | All of 5.4; end to end with a fake `claude` script (runner, server, socket); real-CLI smoke test in a sandboxed dir |
| DOC | PM | `docs/architecture.md`, `docs/decisions.md` (16 runner: host authority, HMAC, stdin; 17 pairing admin auth, superseding 12; 18 receptionist layers; 19 attribution opt-in), `ROADMAP.md`, `CLAUDE.md` security section | all | Docs match the code |

Security checkpoints:
- **SC1:** done (this rev).
- **SC2:** S1+S2 merged.
- **SC3:** in progress (QA, empirical CLI V1-V16). **R1 must not finalize its argv and bwrap binds before SC3.**
- **SC4:** I1 (hook writes, installer secrets, pairing).
- **SC5:** 8g before v0.3.0.

## 10. TBD by SC3 (to finalize when the results arrive)
1. Headless behavior of `--permission-mode=plan` vs `dontAsk` for the Receptionist (ExitPlanMode loops?), and whether
   `dontAsk` should be the quest default.
2. Whether `init.tools` reflects `--tools` exactly (the L5 exact-equality check depends on it), and how names look.
3. `--restricted`: its exact scope (cwd plus `--add-dir` confinement, exec removal, ignored settings, protected files) and
   whether it composes with `--resume` and `--tools`.
4. `--safe-mode`: whether it composes with `--resume` and `--tools`, and whether it is usable for project scope.
5. `--permission-prompts=none` with `WebFetch(domain:x)` allow rules: are other domains denied?
6. Trust: whether the `hasTrustDialogAccepted` key and parent-dir or worktree inheritance hold for the realpath.
7. The bwrap rw set: the transcript dir key format, todos and state dirs, whether `.credentials.json` must be rw for OAuth
   refresh, and whether `~/.claude.json` tolerates EROFS or needs the disposable copy.
8. Whether stdin prompts work with `-p` plus stream-json, and whether `--flag=value` parses for every flag used.
9. Whether `--help` exposes the list of accepted permission modes (otherwise a probe run is needed).
10. Whether `--resume` keeps the same session id or forks, which affects the ledger and `Session.runId` updates.
