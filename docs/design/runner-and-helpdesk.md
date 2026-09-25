# M8 design: runner, quest board, Receptionist, admin auth, attribution (8j, 8k, 8l, 8m)

Status: proposed (architect, 2026-09-25). Next step: security-engineer design review, then the PM applies the
[Contract patch](#8-contract-patch). Heroes and the Multiverse floor are designed separately in
`docs/design/living-office.md`. This doc only refers to them through `heroId` and a server bus event.

Contract files (new, self-contained, not yet exported):
`packages/shared/src/runner.ts`, `receptionist.ts`, `auth.ts`, `attribution.ts`.

## 0. Constraints and principles
- **No API key.** Everything that runs Claude spawns the logged-in `claude` CLI on the host
  (`claude -p ... --output-format stream-json`). The runner strips `ANTHROPIC_*` env vars so a stray key can never
  switch billing (`RUN_ENV_STRIP_PREFIXES`).
- **Server in Docker, runner and hooks on the host.** The container cannot touch project dirs or the CLI login, so every
  host-side effect (spawning, writing `.tagconn/office.json`) happens in the runner. Automatic README writes happen in the hook.
- **The host is the authority.** `~/.config/tagconn/runner.json` (0600) says what the runner may do. Server settings can
  only narrow that, never widen it. So a compromised server or container cannot make the runner leave the dirs, modes or
  tool policy that the host allows.
- **Default deny for new privileged surface.** New REST writes and socket events need an admin session unless they are
  explicitly marked public, hook, or runner.

## 1. Components

```
HOST                                                           DOCKER (127.0.0.1)
claude (user) ──hooks──▶ office-hook.sh ──POST /api/hooks (+x-tagconn-run-id)──▶ server :4317
                               └─(SessionStart) write .tagconn/README.md if absent;       │ modules: auth, runs,
                                  POST .tagconn/office.json → /api/attribution/import     │ receptionist, attribution
apps/runner (pnpm office:runner) ──socket.io /runner (runner token, outbound)───────────▶ │
   └─ spawns claude -p (stream-json) in allowed project dirs; bwrap for the Receptionist  │
browser ◀── nginx :4318 ── /office namespace (admin token in handshake auth) ◀────────────┘
pnpm office:pair ──POST /api/auth/pairing-codes (runner token)──▶ prints http://localhost:4318/#pair=ABCD-EFGH
```

New server modules follow the usual layout (`index.ts`, `*.routes.ts`, `*.service.ts`, `*.repository.ts`, `*.schema.ts`,
`*.socket.ts`, `__tests__/`):

| Module | Owns |
|---|---|
| `auth` | admin sessions and pairing codes, `/api/auth/*`, `auth:*` socket events. It registers the `adminVerifier` in DI |
| `runs` | the `/runner` namespace, run queue and dispatch, `runs` and `run_events` tables, `/api/runs*`, `runs:*`. It registers the `runDispatcher` (`RunDispatcher` from shared) and `runLinker` |
| `receptionist` | conversations and messages, `/api/receptionist/*`, `receptionist:*`. It starts turns through `runDispatcher` |
| `attribution` | `/api/attribution/*`, pending imports, profile export. It applies imports via the layouts and heroes services / bus |

New core files: `core/http/admin.ts` (route-level `config.access` plus a global `onRequest` guard),
`core/realtime/admin-guard.ts` (handshake auth plus the per-packet `socket.use` guard), `core/redact/` (the ingest redactor,
moved or exposed here so runs can reuse it).

## 2. Runner (8k)

### 2.1 Process and configuration
`apps/runner`: Node 24, dependencies `socket.io-client` and `@tagconn/shared` (zod). It is built and run like `apps/server`
(tsx in dev, and the same build approach for dist). It starts with `pnpm office:runner`. An optional user systemd unit example
is `apps/runner/contrib/tagconn-runner.service` (`ExecStart=/usr/bin/env pnpm --dir <repo> office:runner`, `Restart=on-failure`,
`NoNewPrivileges=yes`). The runner never runs as root and refuses to start if `uid === 0`.

The config file is `<configDir>/runner.json` (`RunnerLocalConfigSchema`), mode 0600. The runner refuses the file if it is
group- or world-readable. The installer writes it: `url`, `token` (generated like the hook token), `allowedProjectDirs`
(from repeated `--runner-allow <dir>` flags, default empty), and `maxPermissionMode` (default `acceptEdits`). The same token
goes into the repo `.env` as `OFFICE_RUNNER__TOKEN`, and `OFFICE_RUNNER__ENABLED=true` is set when at least one dir is allowed.

At startup the runner runs a **capability probe**: `claude --version` and `claude --help`. It checks for the flags
`--output-format`, `--include-partial-messages`, `--setting-sources`, `--strict-mcp-config`, `--append-system-prompt`,
`--add-dir`, and `--max-turns`, and checks for `bwrap` on PATH. It also does a one-shot probe of stdin prompt support
(`printf ping | claude -p --max-turns 1 --output-format stream-json --verbose`, run only with `--probe`, and cached in
`stateDir`). The results go into `RunnerHello.capabilities`. Receptionist runs are **rejected** (`capability_missing`)
unless `settingSources` and `strictMcpConfig` are both true.

### 2.2 Connection protocol (`RUNNER_NAMESPACE = '/runner'`)
- The runner connects to `url` (default `http://127.0.0.1:4317`, the host-published port) with
  `auth: RunnerHandshakeAuth {token, runnerId, protocol}`. It sends no `Origin` header. The engine-level `allowRequest`
  already checks `Host`.
- Server namespace middleware: it rejects the connection if `settings.runner.token` is empty, if the token does not match
  (`timingSafeEqual`), if an `Origin` header is present (browsers can never be runners), or if the protocol version differs.
  A new valid connection replaces an older one (zombie sockets), with a warning in the log.
- The runner then sends `runner:hello(RunnerHello)` and gets the ack `{serverVersion, killRunIds}`. The server reconciles runs:
  if the server thinks a run is `dispatched`/`running` but it is not in `activeRunIds`, the run becomes `lost`. If the runner
  reports a run the server does not know, it goes into `killRunIds`. After a server restart, non-terminal runs wait
  `runner.lostGraceSec` (30 s) for a hello before they become `lost`.
- Server to runner: `run:start(RunStartCommand)` (the ack carries `{pid}` or an error), `run:stop`, `attribution:write`.
- Runner to server: `run:event(RunEventEnvelope)` with `seq` numbers (the server dedupes on `(runId, seq)`) and
  `run:end(RunEnd)`. While disconnected, the runner buffers up to `offlineBufferEvents` per run and replays them on reconnect.
  It keeps processes alive during short outages.

### 2.3 Validation on the runner (defense in depth; independent of the server)
For each `run:start`:
1. `RunStartCommandSchema.parse`. If it fails: `rejected / invalid_command`.
2. `projectDir`: `fs.realpath`, then it must equal an allowed root or start with `root + path.sep`. The roots are
   `allowedProjectDirs`, realpath'd at startup. For `readOnly` runs, `readOnlyProjectDirs` also count. It must be a directory
   and must not be `/` or `$HOME` itself. `null` is only allowed for `readOnly` (the neutral dir). If it fails: `dir_not_allowed`.
3. `permissionModeWithin(mode, maxPermissionMode)`. `bypassPermissions` also needs `allowBypassPermissions: true`.
   `readOnly` forces `plan`. If it fails: `mode_not_allowed`.
4. Local concurrency is below `maxConcurrent`. If not: `concurrency` (the server re-queues once).

The server does its own checks first. It resolves `projectId` to the `Project.cwd` host path (the browser never sends paths)
and does a lexical prefix check against `settings.runner.allowedProjectDirs`. The server cannot realpath host paths from
inside the container, which is why the runner's realpath check is the one that counts.

### 2.4 Spawn (exact argv)
`spawn(claudePath, args, { cwd, env, detached: true, stdio: ['pipe','pipe','pipe'] })`, with no shell.
**The prompt goes on stdin** (it is written, then stdin is closed). This keeps prompts out of `ps` (other local users) and
removes the variadic `--allowedTools` swallowing problem completely. It also means a prompt like `--dangerously-skip-permissions`
can never be parsed as a flag.

Quest run:
```
claude -p --output-format stream-json --verbose [--include-partial-messages]
       --permission-mode <mode> --model <model> [--max-turns <n>] [--resume <sessionId>]
       [--allowedTools <csv>] [--disallowedTools <csv>]
```
Each list is **one** comma-joined argv element. `TOOL_RULE_RE` forbids commas inside a rule. Fallback when the probe found
that stdin prompts do not work: `claude -p <prompt> --output-format ...`, with the prompt right after `-p` as CLAUDE.md
prescribes, and the runner rejects prompts that start with `-`.

Env: an allowlist (`HOME PATH USER LOGNAME LANG LC_* TERM TZ XDG_* SHELL TMPDIR`), minus `RUN_ENV_STRIP_PREFIXES`, plus
`TAGCONN_RUN_ID`, `TAGCONN_RUN_KIND`, and for the Receptionist `TAGCONN_ATTRIBUTION=off`. `TAGCONN_CURL_CONF` and
`OFFICE_DISABLED` are passed through if set.

### 2.5 Stream parsing, caps, lifecycle
- stdout is split into lines. A line longer than `maxLineBytes` is dropped with a `notice`. Each line is parsed as JSON and
  mapped like this: `system/init` becomes `init` (session_id, model, cwd, tools, permissionMode). `stream_event`
  `content_block_delta.text_delta` becomes `text{partial:true}`. `assistant` content blocks become `text{partial:false}` and
  `tool_use{inputPreview}`, where the preview is `file_path`, `pattern`, `command`, `url` or `description`, truncated.
  `user` tool_result becomes `tool_result{preview}`. `result` becomes `result` (subtype, is_error, result text,
  total_cost_usd, duration_ms, num_turns, usage). stderr lines become `notice{warn}`, rate-limited to 20 per run.
- Caps come from `RunStartCommand.limits` (from settings: `maxEventsPerRun`, `maxEventBytesPerRun`, `previewChars`). When a cap
  is hit: one `notice`, then a stop with `output_cap`.
- The runner applies the server's `ingest.redactPatterns`? **No.** Redaction happens once, on the server
  (`core/redact`), over every string of every event, the prompt preview and the result, before anything is stored or broadcast.
  The runner only truncates.
- Timeout (`timeoutSec`), Stop, or runner shutdown: `process.kill(-pid, 'SIGTERM')` (the whole process group, including
  MCP/Bash children), then `SIGKILL` after `killGraceMs`. `run:end` maps exit 0 plus a `result.isError=false` to `succeeded`,
  and everything else to `failed`, `stopped` or `timeout`.

### 2.6 Correlation: run to Claude session to characters
Hooks still fire for runner-spawned sessions, because `claude` loads the user's settings. So quest characters animate exactly
like manual sessions do.
1. **Authoritative:** the `init` event's `session_id`. `runs` sets `run.sessionId` and emits bus `run.linked {runId, sessionId}`.
   The sessions module (task S5) sets `Session.runId` and `origin: 'quest'`.
2. **Early hint:** `SessionStart` usually reaches `/api/hooks` before the runner has parsed `init`. The hook adds
   `x-tagconn-run-id: $TAGCONN_RUN_ID` (only if the value matches a UUID). Ingest calls `runLinker.hint(runId, sessionId)`,
   which links only if that run exists, is not terminal, and has no session yet. The header is a presentation hint, never
   authority. A forged header can at most mislabel a session badge. The `init` value wins if it differs.
3. Follow-ups use `--resume <run.sessionId>`. The new run's `init` gives the session id (it may be the same one). A thread is
   `threadId` (the root run), and each turn is its own `Run`.
4. **Receptionist sessions are not shown as floors.** When `TAGCONN_RUN_KIND=receptionist`, the hook exits without posting.
   The Receptionist NPC is animated from `run:event` (`tool_use` names are mapped through the existing activity rules
   client-side).
5. **Assigning to a hero:** `RunStartRequest.heroId` makes the server prefix the prompt with
   `Delegate this task to the "<role>" subagent.\n\n`. The UI shows the final prompt. The server also emits bus
   `run.heroRequested {runId, sessionId?, role, heroId}`, so the heroes module (8i) prefers that hero for the next
   `SubagentStart` of that role in the linked session.

### 2.7 Server queue
FIFO, capped at `runner.maxQueued`. Dispatch happens while `active < min(settings.runner.maxConcurrent, hello.maxConcurrent)`.
`runner.enabled=false` or no runner connected: `POST /api/runs` gives 409 `runner offline`. The run stays `queued` only if
the runner disconnected after it was accepted. Retention: `runner.runRetentionDays`.

## 3. Browser UX: Quest board (8k)
- A TopBar button, "Quest board" (scroll icon), with a badge showing active runs. It opens a right drawer, scoped to the
  current floor and switchable to "all floors".
- **Post a quest** form: the floor (the current one, fixed); the assignee: "Guild Master" (main session) or one of the
  floor's heroes; a prompt textarea with a character counter (`maxPromptChars`); a mode select limited to
  `allowedPermissionModes ∩ runner cap`, where each mode has a one-line explanation (plan = read-only proposal, acceptEdits =
  edits files without asking); and a model select. The Post button is disabled while the runner is offline, with a tooltip.
- **Quota note** (always visible under the Post button): "Quests run the Claude Code CLI on this machine with your
  subscription login. They count against the same usage limits as your terminal sessions, and parallel quests use them up
  faster. The cost shown is the CLI's estimate." When a result comes back with a rate-limit error, a banner shows it.
- **Quest card**: status chip, the elapsed time, and the live transcript, which streams text, shows tool chips
  (`Read src/a.ts`), and shows collapsed tool results. At the end there is a result card: turns, duration, tokens, the
  estimated cost, and the final answer as markdown (sanitized: no raw HTML). Buttons: **Stop** (confirm while running),
  **Follow up** (textarea, which resumes the session), and **Focus** (the camera follows the linked session's Guild Master).
  Clicking a tool chip focuses the character that emitted it.
- The character link comes through `Session.runId`. The Guild Master and subagents show a small scroll badge
  ("on a quest"). The hover card shows the quest title.
- When locked (no admin session), the drawer shows "Pair this browser" (see 5.4). The office itself stays viewable.

## 4. Receptionist help desk (8l)

### 4.1 UX
The Receptionist is a fixed NPC at the Guild Gate (the `entrance` zone of every floor and of the Multiverse Nexus). It is not
an `Agent` and belongs to no session. Clicking it (or the "Help desk" TopBar button) opens a chat panel. The panel has a
conversation list, "New conversation" with a scope toggle (**General**: tagconn itself and general questions, or
**This floor's project**: read-only questions about the repo), streaming answers, tool chips, Stop, and a "read-only"
shield label that shows the sandbox state (`bwrap` or `none`). History is kept on the server: `maxConversations` (50) and
`maxMessagesPerConversation` (200). The oldest conversation is evicted first. A conversation runs one turn at a time. Each turn
after the first uses `--resume <conversation.sessionId>`. While a turn runs, the NPC shows reading, searching or browsing.

### 4.2 Receptionist argv (built by the runner for `readOnly` runs; server tool lists are ignored except extra denies)
```
[bwrap ...] claude -p --output-format stream-json --verbose --include-partial-messages
  --permission-mode plan --model <receptionist.model> --max-turns <receptionist.maxTurns>
  --allowedTools Read,Grep,Glob[,WebSearch][,WebFetch]
  --disallowedTools Bash,BashOutput,KillShell,Edit,MultiEdit,Write,NotebookEdit,Agent,Task,Skill,SlashCommand,
                    Read(~/.ssh/**),...(RECEPTIONIST_DENY_READ_GLOBS + extraDenyReadGlobs),WebFetch(domain:localhost),...
  --strict-mcp-config --mcp-config {"mcpServers":{}}
  --setting-sources user
  --append-system-prompt <RECEPTIONIST_SYSTEM_PROMPT>
  [--add-dir <tagconn repo root>]    # general scope when receptionist.allowTagconnDocs
  [--resume <sessionId>]
```
cwd: in the general scope, `<stateDir>/receptionist` (an empty dir, 0700, created by the runner). In the project scope, the
project dir, which must pass the runner's realpath check against `allowedProjectDirs ∪ readOnlyProjectDirs`.
WebFetch is dropped when `webFetch = never`, or when it is `general-only` and the scope is project. WebSearch is dropped when
`webSearch = false`.

### 4.3 Layered read-only guarantees
| Layer | What it stops |
|---|---|
| L1 `--disallowedTools` write, exec, and delegation tools (deny beats allow, including allows from user settings) | Edit/Write/Bash/NotebookEdit, subagents with broader tools, skills |
| L2 `--allowedTools` minimal set, `--permission-mode plan` | Anything else would need a permission prompt, which `-p` cannot answer, so it is denied. Plan mode itself refuses non-read-only tools |
| L3 `--strict-mcp-config` with an empty config | The user's MCP servers (which may have write tools) are not loaded at all |
| L4 `--setting-sources user` | Project `.claude/settings.json` hooks and allow rules in the questioned repo do not load (a cloned repo cannot run code) |
| L5 Runner watchdog | If `init.tools` contains anything outside `RECEPTIONIST_ALLOWED_TOOLS`, or any `tool_use.name` is outside it, the process group is killed at once with `policy_violation` |
| L6 bwrap sandbox (Linux, `receptionistSandbox: auto`) | `--ro-bind / /`, rw only `~/.claude`, `~/.claude.json`, the neutral dir and a tmpfs `/tmp`, `--unshare-pid --die-with-parent`. The kernel refuses project writes even if L1 to L5 fail. The runner does a probe turn under bwrap at startup and falls back to `none` (and reports it in the UI) if the CLI cannot run under it |
| L7 Hook | Receptionist sessions post nothing and write no `.tagconn` (`TAGCONN_RUN_KIND`, `TAGCONN_ATTRIBUTION=off`) |

**Residual risks (stated honestly):**
- *Confidentiality, not integrity.* `Read`/`Grep` can read any file the user can read, except the deny globs, and those are
  applied best-effort to Grep/Glob. Prompt injection from a repo file or a web page could try to exfiltrate data through
  WebFetch URLs or WebSearch queries. Mitigations: WebFetch is off in the project scope by default, loopback and metadata
  hosts are denied, and secret globs are denied. The UI tells the user not to ask about secrets.
- *SSRF.* WebFetch runs on the host. The domain rules cannot block LAN IP ranges, so GET requests to LAN or router pages
  remain possible in the general scope. tagconn's own GET API is read-only.
- The CLI itself writes to `~/.claude` (transcripts, todos). This is inherent to `--resume` and is not a project write.
  Without bwrap (on macOS, or if the probe failed), L1 to L5 are policy, not kernel enforcement. A future CLI change to plan
  mode semantics is caught by L5 only after the fact, when the tool_use appears. That is why L6 exists.
- The user's own user-level hooks from other tools still run (`--setting-sources user`).

## 5. Admin auth (8m, revisits decision 12)

### 5.1 Threat model (the browser can now cause code execution on the host)
| # | Attacker | Before M8 | With 8m |
|---|---|---|---|
| T1 | Malicious website (CSRF / CSWSH) | Origin/Host checks, JSON-only | Same checks, plus a bearer token that browsers never attach automatically (not a cookie), so it is CSRF-immune by construction |
| T2 | DNS rebinding | Host allowlist | Same; even if bypassed, there is no token |
| T3 | Another OS user on a shared host (127.0.0.1 is reachable by all users) | **Could rewrite ~/.claude/agents via roles sync** | Pairing needs the 0600 runner token or `docker logs` access; `protect: all-writes` covers role and settings writes |
| T4 | Another container on the compose network (`Host: server` is allowed) | Full access | Same as T3 |
| T5 | Same-user malware | Out of scope (it can run `claude` itself) | Out of scope |
| T6 | Compromised server or container | n/a | The runner's local allowlist, mode cap, bypass refusal and Receptionist policy still hold |
| T7 | XSS in the web app | Settings writes | Token theft from localStorage. Mitigations: strict CSP in nginx, React escaping, markdown without raw HTML |
| T8 | Leaked token (logs, Referer) | n/a | Tokens are never logged; the pairing code goes in the URL *fragment*; `Referrer-Policy: no-referrer`; server sessions are revocable |

### 5.2 Decision: pairing by default, same-origin bootstrap as an opt-in
A same-origin bootstrap alone (the UI calls an endpoint and gets a token because Host and Origin match) adds **nothing**
against T3 and T4: a non-browser client can forge `Origin` and `Host`. It only helps if the Origin checks are misconfigured
(for example `corsOrigins: ['*']`). So the **default is `auth.mode: pairing`**, and a one-time code proves that the user
controls the host account:
- **Minting a code:** (a) at boot, when no admin session exists, if `auth.logPairingCodeOnBoot` is set, the log line is
  `Pair a browser: http://localhost:4318/#pair=ABCD-EFGH (expires in 10 min)`. Reading it needs `docker logs` (docker group)
  or the `pnpm dev` terminal. (b) `pnpm office:pair`, which calls `POST /api/auth/pairing-codes` with
  `x-tagconn-runner-token` read from `runner.json` (0600, owner only), prints the URL, and opens it if `--open` is given.
  `pnpm office:doctor` shows the pairing state and suggests `office:pair`.
- **A code** is 8 Crockford base32 characters (40 bits). It is single-use, lasts `pairingCodeTtlSec` (600 s), dies after 5
  wrong attempts, and pairing attempts are globally limited to 10 per minute. At most 3 unexpired codes exist at a time.
- `auth.mode: same-origin` (file or env only) turns on `POST /api/auth/bootstrap`. It needs an allowed `Origin` to be
  **present**, and `Sec-Fetch-Site: same-origin` when that header is sent. It keeps decision 12's "local processes are
  trusted" posture and is documented as such.
- **There is no signing secret.** Tokens are opaque (`tca_` plus 32 random bytes). The DB stores only `sha256(token)`
  (`admin_sessions`: id, token_hash, label, user_agent, created_at, last_used_at, expires_at), so a DB leak does not yield
  usable tokens and there is no key to rotate. Expiry is sliding, `sessionIdleHours` (72 h), capped at `sessionMaxAgeDays`
  (30). At most `maxSessions` (10) exist; the oldest is evicted. `auth:revoke "*"` logs out everywhere.

### 5.3 Enforcement
- **REST:** route option `config.access: 'public' | 'hook' | 'runner' | 'admin'`. A global `onRequest` hook in
  `core/http/admin.ts` treats every non-GET `/api/*` route without an explicit access value as `admin` when
  `protect=all-writes`, and every route marked `admin` (including the run, receptionist and runner GETs) as needing
  `Authorization: Bearer <token>`. Failures return 401 `{error, statusCode}` with `WWW-Authenticate: Bearer`. Public:
  `GET` reads, `POST /api/auth/pair`, `POST /api/auth/bootstrap` (same-origin mode only; otherwise 404). Hook token:
  `/api/hooks`, `/api/attribution/import`. Runner token: `/api/auth/pairing-codes`.
- **Socket `/office`:** `auth: {adminToken}` goes in the CONNECT packet (not the URL, so nginx does not log it). Middleware
  sets `socket.data.admin` and joins `ADMIN_ROOM`. `socket.use` checks each packet: an event in `ADMIN_SOCKET_EVENTS_EXECUTION`
  needs a live session, re-checked every time (expiry and revocation); when `protect=all-writes`, anything not on the server's
  public read list (`office:subscribe`, `settings:get`, `roles:list`, `layouts:list|get`, `auth:status`, and hero/Multiverse
  reads from living-office) also needs it. Denied packets get the ack `{ok:false, error:'admin session required'}`. On
  revocation or expiry the server emits `auth:changed` and removes the socket from `ADMIN_ROOM`. Runs, runner status,
  receptionist and pending-import broadcasts go **only** to `ADMIN_ROOM`.
- The web client keeps the token in localStorage (`ADMIN_TOKEN_STORAGE_KEY`), reconnects the socket after pairing, and
  sends the header on REST. A 401 or `auth:changed{admin:false}` clears it and shows the pair dialog.
- nginx: `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. Vite dev is left as is.

### 5.4 Regression test plan (extends `core/http/__tests__/security.test.ts`, plus new `modules/auth/__tests__`)
1. Missing, invalid, expired, or revoked token: 401 on every `/api/runs*`, `/api/receptionist*` and `/api/attribution/save`
   route, and on each REST write when `all-writes`. Every event in both `ADMIN_SOCKET_EVENTS_*` lists (the tests iterate the
   shared constants) gets an `{ok:false}` ack without a token, or after revoking.
2. Cross-origin: `POST /api/auth/pair` and `/api/runs` with `Origin: http://evil.example` give 403. A socket handshake with a
   foreign Origin plus a valid token is still refused.
3. CSRF simple requests: `text/plain`, `application/x-www-form-urlencoded` and `multipart` POSTs to `/api/runs` and
   `/api/auth/pair` give 415. A token in a query string or cookie is ignored (401).
4. DNS rebinding: `Host: evil.example` with a valid token gives 403 on REST and at the engine handshake.
5. Replay: a used pairing code gives 401. A code after its TTL gives 401. After 5 wrong attempts the right code also fails.
   Rate limit: the 11th attempt in a minute gives 429. A revoked session token used on REST and on an open socket fails.
6. Bootstrap: 404 in pairing mode. In same-origin mode it needs a present allowed Origin (no Origin gives 403) and gives 403
   on `Sec-Fetch-Site: cross-site`.
7. The runner namespace refuses: an empty `runner.token` setting, a wrong token, a correct token *with* an `Origin` header,
   and the admin token used as the runner token (and the reverse). `pairing-codes` refuses the hook token.
8. Secrets: `runner.token` is masked in `GET /api/settings` and `settings:changed`. The `auth.*` and `runner.*` patches are
   rejected by the API (GUI-immutable). The DB holds no plaintext token.

## 6. Attribution (8j)

### 6.1 Files in a project repo
- `.tagconn/README.md`: what tagconn is, the repo link, the tagconn version that wrote it, that it contains no secrets and
  is safe to commit, how to restore on another host (install tagconn, run `pnpm office:install`, start the office, open the
  project: the profile is offered for import), how to save (`/tagconn-save` or the "Save profile to project" button), and
  how to opt out (replace the `.tagconn` dir with an empty *file* named `.tagconn`, or run `office:install --no-attribution`).
- `.tagconn/office.json` (optional): `AttributionProfileSchema`. It holds the kind and version, the tagconn version,
  `savedAt`, the floor name and style, the layout (without an id), and heroes (role, name, title, look). It holds **no
  secrets, no absolute host paths** (the schema rejects `/home/...`, `~/...` and `C:\...`, and the server additionally
  rejects on any redaction-pattern hit), and nothing about sessions, prompts or usage.
- **Git: commit both.** Portability across hosts is the whole point, and both files are small and host-independent.
  tagconn never edits `.gitignore`.

### 6.2 README writes: the hook, on SessionStart
Settings delivery: hooks cannot read server settings cheaply, so the **installer controls it with files** next to
`curl.conf`, which the hook only tests for existence (no parsing in sh):
- `<configDir>/attribution-README.md`: the rendered template (with the version filled in). If it exists, README writes are on.
- `<configDir>/attribution.conf` (0600): a curl config with the token header and `url = ".../api/attribution/import"`.
  If it exists, import is on.
- `office:install --no-attribution` removes both. Default: on (as the ROADMAP says: opt-in at install time, on by default).

The hook logic, in a `( ... ) >/dev/null 2>&1` subshell, only for `SessionStart` (the payload matched by a `case` glob on
`"hook_event_name":"SessionStart"`, with or without spaces). It is skipped if `TAGCONN_ATTRIBUTION=off` or
`TAGCONN_RUN_KIND=receptionist`:
```
dir=$CLAUDE_PROJECT_DIR (set by Claude Code for hooks); skip if empty
skip unless: [ -d "$dir" ] && [ -O "$dir" ] && [ -e "$dir/.git" ] && [ "$dir" != "$HOME" ] && [ "$dir" != / ]
skip if [ -e "$dir/.tagconn" ] || [ -L "$dir/.tagconn" ]          # never overwrite, never follow symlinks
mkdir "$dir/.tagconn" (no -p) && (set -C; cat "$tpl" > "$dir/.tagconn/README.md")   # noclobber
```
Writes happen only in git repos owned by the user, so there are no stray files in `~/Downloads`, `/tmp` or `$HOME`.
The work is a few syscalls, well inside the 1 s budget.

### 6.3 Import: the hook posts, the server decides
After the normal POST (foreground, so the session exists on the server), and only if all of these hold:
`attribution.conf` exists, `$dir/.tagconn/office.json` is a regular non-symlink file, `.tagconn` is not a symlink, and
`wc -c` is at most 65536. Then the hook, **in the background** (`&`, all fds redirected, so it adds no latency), runs
`curl -K attribution.conf -H "x-tagconn-session-id: $sid" -H 'content-type: application/json' --data-binary @office.json`.
`$sid` is extracted with `sed` limited to `[A-Za-z0-9_-]`, so no header injection is possible.

The server (`POST /api/attribution/import`, hook-token auth, body limit `attribution.maxProfileBytes`) does this:
- If `attribution.enabled` is false: `ignored/disabled`. If the session is unknown or its SessionStart is older than
  `importWindowSec`: `ignored/unknown-session|stale-session`. The project is derived from the **session** (never from the
  body).
- It parses `AttributionProfileSchema` and runs the redaction check, then `validateLayout`. Any error gives `rejected/invalid`
  (logged at debug level, never echoed).
- If the project is already configured (it has `layoutId`, any hero, `profile`, or a dismissed import): `ignored/already-configured`.
- `autoImport: 'ask'` (**default**, because repo content is untrusted, for example a cloned stranger's repo): the profile is
  stored in `pending_profile_imports` and `attribution:pending` is sent to `ADMIN_ROOM`. The UI shows a toast: "This project
  has an office profile (floor 'X', layout, 4 heroes) from tagconn 0.3.0. Import?" Accept or dismiss uses
  `attribution:resolve`. `'auto'` applies at once, and `'off'` ignores the profile.
- Applying it: create a layout `imported-<slug>` (with a suffix on collision, respecting `maxStoredLayouts`) and assign it,
  set the project name and style, create heroes through the heroes service (8i; entries it cannot map are dropped), and set
  `Project.profile = {importedAt, tagconnVersion, source}`. The result is broadcast as `project:upsert`.

### 6.4 Save: explicit only
- GUI: the floor menu gets "Save office profile to project" (admin). The server builds the profile with
  `GET /api/attribution/export?projectId=` logic and sends `attribution:write` to the runner. The runner checks the dir by
  realpath (`allowed ∪ readOnly`, `.git` present, not `$HOME` or `/`), refuses a symlinked `.tagconn` or `office.json`,
  re-validates the content, creates `.tagconn` if missing (and the README too if the template exists), and writes
  tmp + rename, mode 0644. It overwrites only when the user confirmed `overwrite: true`. With no runner, the UI offers the
  skill instead.
- Skill `/tagconn-save` (a managed skill dir): it tells Claude to fetch `GET http://127.0.0.1:4317/api/attribution/export?cwd=<abs cwd>`
  (a public read: the profile contains nothing that is not already public in the snapshot), show the user a diff, and write
  `.tagconn/office.json` with the Write tool, so the normal CLI permission prompt applies.

## 7. Settings (all new keys have defaults; see the patch)
`runner.*`: `token`, `allowedPermissionModes`, `allowedTools`, `disallowedTools`, `maxQueued`, `maxPromptChars`,
`runTimeoutSec`, `maxTurns`, `maxEventsPerRun`, `maxEventBytesPerRun`, `previewChars`, `partialMessages`,
`runRetentionDays`, `lostGraceSec`. The **whole `runner` section is GUI-immutable.** New sections: `auth` (GUI-immutable),
`receptionist` (the web options and deny globs are GUI-immutable; model and limits are editable), and `attribution`.
Env examples: `OFFICE_RUNNER__TOKEN`, `OFFICE_AUTH__MODE=same-origin`, `OFFICE_RECEPTIONIST__WEB_FETCH=never`.

## 8. Contract patch
The PM applies this after the review. Everything is additive except the `GUI_IMMUTABLE_SETTINGS` broadening, which only
tightens.

**`index.ts`**: append
```ts
export * from './runner.js';
export * from './receptionist.js';
export * from './auth.js';
export * from './attribution.js';
```

**`settings.ts`**: add these imports: `AUTH_MODES, AUTH_PROTECT_LEVELS` from `./auth.js`,
`RUN_MODELS, RUN_PERMISSION_MODES, TOOL_RULE_RE` from `./runner.js`, and `ATTRIBUTION_MAX_PROFILE_BYTES` from
`./attribution.js`. In `runner`, after `allowedProjectDirs`:
```ts
      /** Secret the host runner presents on namespace /runner. Empty = runner connections refused. Masked in the API. */
      token: z.string().default(''),
      /** Modes a quest may request (each still capped by the runner's local maxPermissionMode). */
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
New sections, after `runner`:
```ts
  receptionist: z.object({
      enabled: z.boolean().default(true),
      model: z.enum(RUN_MODELS).default('sonnet'),
      webSearch: z.boolean().default(true),
      webFetch: z.enum(['never', 'general-only', 'always']).default('general-only'),
      /** Extra Read(...) deny globs on top of RECEPTIONIST_DENY_READ_GLOBS. */
      extraDenyReadGlobs: z.array(z.string().regex(/^[^\n\r(),]{1,180}$/)).default([]),
      /** General scope adds the tagconn repo (read-only) via --add-dir so it can answer tagconn questions. */
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
      /** Server accepts profile imports. README writing is a host-side installer choice (--no-attribution). */
      enabled: z.boolean().default(true),
      autoImport: z.enum(['ask', 'auto', 'off']).default('ask'),
      maxProfileBytes: z.number().int().min(1_024).max(ATTRIBUTION_MAX_PROFILE_BYTES).default(ATTRIBUTION_MAX_PROFILE_BYTES),
      importWindowSec: z.number().int().min(10).max(3_600).default(120),
    }).prefault({}),
```
`GUI_IMMUTABLE_SETTINGS`: replace `'runner.permissionMode', 'runner.allowedProjectDirs'` with `'runner'`, and add
`'auth', 'receptionist.webSearch', 'receptionist.webFetch', 'receptionist.extraDenyReadGlobs', 'receptionist.allowTagconnDocs'`.
No new `RESTART_REQUIRED_SETTINGS` (tokens are read live on every handshake).

**`domain.ts`**: `import type { ProjectProfileMeta } from './attribution.js';`, then:
```ts
export type SessionOrigin = 'cli' | 'quest';
// Project:  /** Set when an office profile was imported from .tagconn/office.json (8j). */  profile?: ProjectProfileMeta;
// Session:  /** Runner run that started this session (8k); absent for manual CLI sessions. */ runId?: string;
//           origin?: SessionOrigin;
```

**`socket.ts`**: add type imports from the four files, then:
```ts
export interface ServerToClientEvents
  extends RunsServerToClientEvents, ReceptionistServerToClientEvents, AuthServerToClientEvents, AttributionServerToClientEvents {
  /* existing members unchanged */
}
export interface ClientToServerEvents
  extends RunsClientToServerEvents, ReceptionistClientToServerEvents, AuthClientToServerEvents, AttributionClientToServerEvents {
  /* existing members unchanged */
}
export type { OfficeHandshakeAuth } from './auth.js';
// rooms: add  admin: ADMIN_ROOM,   (value import from ./auth.js)
```
The server event bus (apps/server, task S2) adds `run.upserted`, `run.event`, `run.linked {runId, sessionId}`,
`run.heroRequested {runId, sessionId?, role, heroId}`, and `runner.status`.

## 9. Work breakdown
The parallel tasks own disjoint files. The PM pre-assigns the DB migration numbers (S1=N, S2=N+1, S3=N+2, S4=N+3) and does
the one `app.ts` registration commit (all four plugins, initially stubbed), so no two tasks share a file.

| id | role | owns | deps | acceptance |
|---|---|---|---|---|
| C0 | PM | `packages/shared/src/{index,settings,domain,socket}.ts` | review | Patch applied; `pnpm typecheck` green; defaults parse; `runner.token` in the masking list (see S1) |
| S1 | developer (server) | `modules/auth/**`, `core/http/admin.ts`, `core/realtime/admin-guard.ts`, small registration edits in `core/http/index.ts` + `core/realtime/index.ts`, `modules/settings/settings.public.ts` (mask `runner.token`), migration N | C0 | 5.2/5.3 implemented; boot logs a pairing URL when there are no sessions; tests 5.4 #1-#6 and #8 pass; existing security tests pass using a `adminHeaders()` test helper in `test/helpers.ts` (S1 owns that edit) |
| S2 | developer (server) | `modules/runs/**`, `core/redact/**`, migration N+1 | C0, S1 (`admin.ts` API only; stub on day 1) | Namespace auth (test 5.4 #7); queue/concurrency; reconcile and `lost`; `(runId,seq)` dedupe; every event string redacted; caps; REST+socket per contract; the `RunDispatcher` and `runLinker` are in DI; tests use a fake runner socket |
| S3 | developer (server) | `modules/receptionist/**`, migration N+2 | C0, S2 (DI port only) | One turn per conversation; resume via stored sessionId; bounded history and eviction; `readOnly:true`, `plan`, tool lists from constants + settings; webFetch scope rule tested |
| S4 | developer (server) | `modules/attribution/**`, migration N+3 (`projects.profile`, `pending_profile_imports`) | C0, S1 | Import rules in 6.3 (unknown/stale session, already configured, ask/auto/off, oversized to 413, host path to rejected); export has no absolute paths; save goes through `attribution:write` |
| S5 | developer (server) | `modules/ingest/**` (read `RUN_ID_HEADER`), `modules/sessions/**` (`runId`, `origin` from `run.linked`) | S2, **8a merged** | Hint links only a matching non-terminal unlinked run; `init` overrides; a forged header on an unknown run is ignored |
| R1 | developer (runner) | `apps/runner/**` (incl. `contrib/tagconn-runner.service`) | C0 | 2.1-2.5 and 4.2; unit tests: argv builder (stdin prompt, csv lists, receptionist lists ignore server allowlist), realpath allowlist (symlink escape, `..`, prefix `/a/b` vs `/a/bc`), mode cap, env strip, stream parser against captured stream-json fixtures, caps, SIGTERM then SIGKILL of the process group, watchdog `policy_violation`, bwrap argv, offline buffer and replay |
| I1 | developer (infra) | `packages/hook/office-hook.sh`, `scripts/install.ts`, `scripts/doctor.ts`, `scripts/pair.ts` (new), `packages/agent-templates/attribution/README.md.tmpl`, `packages/agent-templates/skills/tagconn-save/SKILL.md`, root `package.json` (`office:runner`, `office:pair`), `.env.example` | C0 | The hook still always exits 0 with no stdout (existing tests plus new ones: README only in owned git repos, never in `$HOME` or `/`, never over an existing file or symlink, receptionist env skips everything, import runs in the background with a size cap, run-id header only for UUIDs); installer writes `runner.json`/`attribution*` (0600) and `--runner-allow`/`--no-attribution` in a sandboxed `--claude-dir`/`--config-dir`; uninstall removes them; doctor reports runner and pairing |
| W1 | developer (web) | `apps/web/src/lib/auth.ts` (new), `lib/socket.ts`, the REST client in `lib/`, `stores/authStore.ts`, `features/auth/**` | C0, S1 | Reads and clears `#pair=`, pair dialog, token in the handshake and header, 401 / `auth:changed` clears it, session list and revoke |
| W2 | developer (web) | `features/quests/**`, `stores/runsStore.ts` | W1 | Section 3 UX; transcript virtualized; markdown sanitized; quota note; offline and locked states; the demo mode (`?demo=1`) has a scripted fake quest |
| W3 | developer (web) | `features/receptionist/**`, `stores/receptionistStore.ts`, `game/npc/receptionist.ts` (new file only) | W1 | Section 4.1; sandbox label; NPC activity from `run:event`. **W3b** (scene wiring in `game/**`) comes after the living-office game work merges |
| W4 | developer (web) | `features/settings/**` (`SECTION_LABELS` for receptionist/auth/attribution, read-only rendering of GUI-immutable keys), `features/attribution/**` (pending toast, "Save profile" menu entry) | C0, S4 | New sections render; immutable keys are shown disabled with "set in office.yaml / env" |
| D1 | developer (infra) | `docker/nginx.conf`, `docker-compose.yml` (only if needed) | none | CSP and security headers from 5.3; the app works under CSP (Phaser, blob textures, websocket) |
| Q1 | qa-engineer | `apps/server/test/security/m8-*.test.ts`, `apps/runner/test/e2e/**` | S1-S4, R1 | All of 5.4 plus an end-to-end run with a **fake `claude` binary** (a shell script emitting the fixture stream-json) through runner, server and socket; a manual smoke test with the real CLI in a sandboxed project dir |
| DOC | PM | `docs/architecture.md`, `docs/decisions.md` (16: runner stdin + host-authority; 17: pairing admin auth, superseding 12; 18: receptionist layers; 19: attribution files), `ROADMAP.md`, `CLAUDE.md` security section | all | Docs match the code |

**Security review checkpoints:** SC1: this design, before C0. SC2: S1+S2 merged (auth, the runner namespace, redaction).
SC3: R1 (argv, env, realpath, bwrap probe, watchdog), which needs a **real-CLI** check that plan mode plus the deny lists
block Edit/Write/Bash, that `init.tools` reflects the deny list, and that `--setting-sources user` skips project hooks.
SC4: I1 (the hook writing into repos, the installer secrets). SC5: 8g full review before v0.3.0.

**Open questions for SC1:** (1) Should `protect` default to `all-writes`? It changes existing tests and the dev UX (a one-time
pairing), but it closes T3 and T4 for role sync. Recommended: yes. (2) Should project-scope Receptionist be allowed on
`readOnlyProjectDirs` that are wider than `allowedProjectDirs`? (3) Is `WebFetch` in the general scope acceptable given the
LAN SSRF residual risk, or should the default be `never`?
