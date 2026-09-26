# tagconn roadmap

Live progress tracker. Legend: `[x]` done · `[~]` in progress · `[ ]` todo · owner in brackets.
Plan: `~/.claude/plans/let-we-brainstorming-i-elegant-abelson.md`

## M0: Discovery & contracts  [PM / Architect]
- [x] Capture real Claude Code hook payloads → `apps/server/test/fixtures/subagent-session.json`
- [x] Monorepo scaffold (pnpm workspaces, turbo, tsconfig presets)
- [x] Shared contracts `packages/shared` (hook schema, domain, roles, settings, socket.io events)
- [x] Default role templates `packages/agent-templates/roles/*.md`
- [x] App package manifests + one-time `pnpm install`
- [x] Project-local subagents `.claude/agents/*.md` (so future sessions can use the roles)
- [x] `CLAUDE.md` (session bootstrap) + `docs/architecture.md` + `docs/decisions.md`

## M1: Server core + ingest  [Developer: server] (done, stretch left)
- [x] Fastify app, core plugins: config (layered), db (Drizzle/SQLite), logger, DI (awilix), event bus, socket.io
- [x] `ingest` module: POST /api/hooks, token auth, redaction, normalize
- [x] `projects`, `sessions`, `agents` (state machine), `activity` (rule mapping), `tasks` modules
- [x] `settings` module (REST + socket, hot reload), `roles` module (CRUD + sync to ~/.claude/agents)
- [x] `transcripts` module (token usage), done in M6
- [x] Vitest: reducer / agent FSM against fixtures

## M2: Web office  [Developer: web] (done)
- [x] Vite + React shell, typed socket.io client, zustand store
- [x] Panels: projects/floors, roster, kanban, event log
- [x] Phaser office: generated tilemap, zones, characters, pathfinding, bubbles, despawn
- [x] Settings page (all settings, restart-required flags) + Roles editor

## M3: Infra & install  [Developer: infra / DevOps] (done)
- [x] `packages/hook/office-hook.sh` (sh + curl, always exit 0)
- [x] `scripts/install.ts` / `doctor.ts` (hooks into ~/.claude/settings.json, token, agents, skills)
- [x] Custom skills: office-kickoff, handoff-report, definition-of-done, task-sizing
- [x] Dockerfiles, nginx, docker-compose.yml, `.env.example`
- [x] README

## M4: Verification  [QA · Code Reviewer · Security]
- [x] Monorepo typecheck + test (72) + build green (PM)
- [x] QA end-to-end: 5/6 scenarios passed (real `claude -p` with 2 parallel subagents → REST/socket/browser; security regressions; roles sync)
- [x] Fix QA bug (HIGH): installer/doctor ignore `--claude-dir` for `~/.config/tagconn` → `--config-dir` / derived sandbox dir
- [x] Fix QA bug (MED): subagent description lost when PostToolUse(Agent) arrives before SubagentStart (early-link map; 51 server tests)
- [x] Re-QA (PM): 74 tests green; sandbox install leaves real files untouched; real `claude -p` with 2 parallel subagents → correct descriptions + task assignees
- [x] Code review of server: 1 High (parallel same-type subagents swapped), 2 Med (tasks/sessions never close), 1 Low (retention)
- [x] Security review of server + infra: 2 Critical, 3 High, 5 Med, 8 Low found
- [x] Shared contract hardening: host 127.0.0.1, `allowedHosts`, `GUI_IMMUTABLE_SETTINGS`, masked secrets, drizzle-orm 0.45.2
- [x] Security fixes: infra (hook token via curl.conf 0600, installer validation/modes/atomic writes, docker non-writable /app)
- [x] Server fixes: security (Origin/Host allowlist, immutable settings, mask token, JSON-only, redaction, sync hardening) + code-review findings: 49 server tests
- [x] Docker images build (server + web); server container smoke test (fixture replay, roles seeded) (PM)
- [x] Real install (user approved: hooks + 6 roles + 4 skills) + `pnpm office:up` (named volume fix) + live `claude` sessions visible as floors: **v1 live** 🎉

## Releases
- [x] v0.1.0: first public release on GitHub (MIT), lockstep SemVer, `pnpm release`, CHANGELOG
- [x] v0.2.0: Magic Guild Hall (M6 + M7)

## M6: Wave 2 (session 2)  [PM]
- [x] Contract: `TokenUsage` on Agent/Session, `sessions.{idleAfterSec,endAfterSec}`, `transcripts.{enabled,debounceMs}`, `WHOLESALE_REPLACE_SETTINGS` in shared
- [x] Server: transcripts module (token usage per agent/session, deduped, path-contained to projectsDir) + session settings; 71 server tests  [Developer: server]
- [x] Web: token usage in roster/drawer/top bar, "Manage floors" (rename/archive), demo usage; 41 web tests  [Developer: web]
- [x] Tests: 57 tests for `scripts/install.ts` + `doctor.ts` (unit + sandboxed integration + real-paths guard), `pnpm test:scripts`  [Developer: infra]
- [x] Security review of wave 2: 3 Med (symlink/TOCTOU escape, unbounded line buffer, unbounded tracked files), 5 Low; release.ts + install.ts clean
- [x] Code review of wave 2: 1 High (usage update could resurrect a removed agent), 3 Low
- [x] Fix pass: transcripts hardening (fd-based open, O_NOFOLLOW, per-read containment, caps, LRU, id validation, TextDecoder) + web floor-usage fix; 99 server tests

## Bugs / UX
- [x] Live server crash loop (Node 24.21 + better-sqlite3 native assertion); Docker pinned to node:24.16, live server rebuilt from the deployed code; 0 restarts since
- [x] Canvas safe region: the agent panel no longer blocks the map; insets-aware camera, drag-pan always works, center selected agent in the visible area, Follow, Esc/click-away to close; 142 web tests  [Developer: web]

## M7: Magic Guild Hall: themes, office editor, procedural generation, stairs  [PM plan]
Decisions: a style ("skin") is separate from lighting (`office.style`: `modern` | `guild`). A floor is still a project;
the stairs on every floor lead to the next or previous floor. Layouts are saved data (rooms = drawn rectangles + room type)
and the map (walls, doors, corridors, furniture, seats) is generated from them deterministically with a seed.
- [x] 7a. Design spec `docs/design/guild-hall.md` + contract (`layout.ts` with `validateLayout`/`DEFAULT_LAYOUT`, `office.style`=guild, floor settings, layout socket events)  [Architect]
- [x] 7b. Server `layouts` module: CRUD REST+socket, read-only seeded default, `project.layoutId` assign/clear + delete cascade, snapshot.layouts, migration 3; 84 server tests  [Developer: server]
- [x] 7c. Procgen engine (done: seeded, property-tested over 300 seeds × 4 sizes × 2 backgrounds, perf < 50 ms) `apps/web/src/game/procgen/`: rooms → walls, doors, corridors, furniture, seats; BSP "surprise me" generator; tests  [Developer: web A]  (after wave 2 web)
- [x] 7d. Theme system (done: modern port + guild skin, costumes, fx gated by ambientEffects/reduced motion; 44 theme tests) `apps/web/src/game/themes/`: modern + **guild** skins, drawn in code (stone, torches, banners, runes, particles), role costumes and titles, magical activity verbs  [Developer: web B]  (parallel with 7c)
- [x] 7e-A. Office editor "Hall Planner": draw regions → pick room type, move/resize, stairs, validation, Surprise me, preview, save/assign, undo/redo (190 web tests incl. 34 new; typecheck/build green; manual playwright-cli pass)  [Developer: web A]
- [x] 7e-B. Scene integration: generated maps + guild skin live (costumes, titles, verbs, fx), interactive stairs + floor transitions, PageUp/PageDown/Home/End, TopBar floor indicator, 3-floor demo; 190 web tests  [Developer: web B]
- [x] 7f. Review + security + QA of M7 → fixes → docker rebuild → release v0.2.0
  - [x] Security: 0 Critical/High; 2 Med (layout ids that break the id rule are stored but can't be listed or deleted; no cap on stored layouts and a snapshot carries them all), 4 Low (defaultLayoutId "constructor" breaks the view, A* node limit, lost updates, socket arg validation)
  - [x] Code review: 1 High (floor hotkeys fire under the open editor), 1 Med (camera zoom compounds on each floor change), 1 Low (transition re-entrancy)
  - [x] QA: 7/9 pass, 0 console errors; bugs: ambientEffects toggle not live (Med), camera fit/focus centering wrong esp. zoomed in (Med/High), roster titles not themed (Low)
  - [x] Server security fixes (layout id validation + purge, maxStoredLayouts 200, defaultLayoutId existence, baseUpdatedAt 409, socket arg validation, name sanitizing); 109 server tests
  - [x] Web fixes A (camera fit/focus math, zoom drift, transition lock, hotkeys under editor, live ambient toggle, animated TopBar floor jump)
  - [x] Web fixes B (client layout hardening, editor baseUpdatedAt/409 dialogs, Edit floor entry, themed roster titles, procgen A* limits) [Developer: web B]
- [x] 7g. Follow-ups: animated TopBar floor jump (fixes A), "Edit floor" entry in Manage floors (fixes B, done)

## M8: Living Office UX + Multiverse + Heroes + Attribution + Runner + Receptionist → v0.3.0  [in progress]
- [x] Design A `docs/design/living-office.md` (8b, 8c, 8h, 8i) + `heroes.ts`, `multiverse.ts`  [Architect A]
- [x] Design B `docs/design/runner-and-helpdesk.md` (8j, 8k, 8l, 8m) + `runner.ts`, `receptionist.ts`, `auth.ts`, `attribution.ts`  [Architect B]
- [x] SC1 security design review: approve with 10 required changes (mutual HMAC runner auth, exact --tools/--restricted Receptionist, bwrap redesign, CLI-trust gate + host quest policy, fail-closed gating, docs-only add-dir, CSP, WebFetch allowlist, mode mapping, import never touches roles)  [Security]
- [x] Design B revision per SC1 (rev 2; 10 items TBD by SC3)  [Architect B]
- [x] SC3 empirical CLI verification: 2 critical confirmed (repo settings redirect API traffic without --setting-sources; unscoped WebFetch reaches loopback), --restricted + bwrap verified, setsid escapes group kill; V15 pending  [QA]
- [x] Design B finalization with SC3 facts (rev 3)  [Architect B]
- [x] Contract patch A (heroes, pm mode, multiverse) applied  [PM]
- [x] Contract patch B (runner/auth/receptionist/attribution; whole runner + auth sections GUI-immutable)  [PM]
- [x] Wave B1: S1 admin auth/pairing/gating [x] · S2 runs module + /runner HMAC [x] · R1 host runner [x] (protocol verified against a real socket.io server) · I1 hook/installer/doctor/pair [x] · D1 nginx CSP [x]
- [~] Wave B2: S3 receptionist module [x] · S4 attribution module [x] · S5 run↔session linking [x] · W1 web auth [x] · W2 quest board [x] · W3 receptionist UI [x] · W4 settings/attribution UI + Vite CSP [x] (restarted 2026-09-26 after a usage-limit interruption)
- [x] SC2 security review of S1 + S2: NOT READY: 1 High (unauthenticated /runner crash, confirmed), 5 Med (idle expiry never runs out, pairing lockout DoS, runner.enabled ignored, missing server dir check, caps don't stop storage), 8 Low; flakes are test-side fixed sleeps
- [x] SC2 fixes (auth + runs): H1 crash fixed (safe-ack + try/catch in runs.gateway.ts), M1-M5 and L1-L8 all addressed (idle-expiry touch split, pairing bucket separation, runner.enabled enforced at handshake+enqueue, server-side dir check + pre-dispatch schema parse, output-cap drop-and-single-stop with a persisted byte counter, redaction, resume provenance, unverified-socket cap, boot token validation); flaky fixed-sleep tests replaced with vi.waitFor; awaits Q1 sign-off  [Developer: server]
- [ ] Q1 M8 security tests + real-CLI R1 acceptance (a)–(i) in sandbox; SC2 (after S1+S2)
- [x] SC4 security review of I1: approve with required changes (3 Med: hook sed slows big events, skill pointed at .env, pair prints link on squatter mismatch; 6 Low)
- [x] I1 fixes for SC4 (132 script tests)  [Developer: infra]
- [x] S4 requirement from SC4: a rejected profile import never echoes, logs or stores the raw body (logger-spy test)
- [x] Wire `attribution:save` (server + web button) to the runner's `attribution:write`; export endpoint stays public per design
- [x] Wave A1: H1 server heroes [x] · W2 web hero data [x] · W3 cast resolver [x] · W4 hero look/preview [x] · W6 multiverse plan + rift theme [x]
- [x] Wave A2: W5 hero editor UI [x] · W7a scene integration [x] · W7b React bridge + floors [x] (uncommitted)
User request: no stale characters, one clear PM per floor, reuse idle characters, glow on the selected character, bubbles that never overlap, and UX best practice for showing characters and the office.
Diagnosis (live data, 2026-09-25): subagents whose SubagentStop never arrived (killed or lost background agents) stay "active/idle" in the lounge forever
(the sweeper only moves them to the lounge); each Claude session has its own PM, and idle or abandoned sessions only end after `sessions.endAfterSec` (30 min),
so parallel or old sessions leave extra PMs on a floor.
- [x] 8a. Server lifecycle (done: staleAfterSec 900, pmIdleLeaveSec 600, swept sessions finish their agents, boot recovery; 114 server tests): `agents.staleAfterSec` (default 900). A subagent with no events past it is marked `done` (reason `stale`) and leaves the floor; it comes back if a later event arrives. The main agent of an idle session leaves the floor after `sessions.pmIdleLeaveSec`. Recovery at restart; tests with a replay of lost SubagentStop.  [Developer: server]
- [x] 8b. One PM per floor: the floor's "Guild Master" is the main agent of the most recently active session; other live sessions show as smaller "Deputy" characters with a session badge (or collapse into a count chip). Configurable `office.pmMode: single | per-session`.  [Architect → Developer: web]
- [x] 8c. Character pool / reuse: when a subagent spawns and an idle character of the same role is on the floor, that character takes the new quest (walks from the tavern to the new zone) instead of a new sprite spawning; idle characters leave (walk out) after `office.idleLeaveSec`. Presentation-only mapping of agent → actor in the web.  [Developer: web]
- [x] 8d. Selection glow (done: WebGL preFX glow + canvas ring, hover, focus dim): WebGL preFX glow (Phaser 3.60+ `preFX.addGlow`) in the role color with a pulse, plus a canvas fallback ring; the other characters dim slightly in focus mode.  [Developer: web]
- [x] 8e. Bubble and label declutter (done: collision-free layout, priority, cap+collapse, zoom LOD, counter-scale; 278 web tests): collision-free bubble layout (greedy placement with stacking and leader lines), priority for the selected/newest/waiting characters, max visible bubbles, fade after `bubbleSeconds`; zoom-based level of detail (names and bubbles hidden when zoomed out, shown on hover); hover card; "waiting for you" gets a persistent badge.  [Developer: web]
- [ ] 8f. UX review pass: a best-practice checklist (focus + context, level of detail, affordances, motion guidelines, accessibility: reduced motion, contrast, keyboard navigation of characters), optional minimap.  [Analyst/Architect → Developer]
- [x] 8h. **Multiverse floor** (replaces "All floors"): a special floor showing every project's characters together. Its layout is generated each time from the live projects (a central Nexus with one realm per project, joined by rift corridors), and the special "rift" style blends each project's own style per realm with a starfield/void between them. Reachable by the stairs (top floor) and from the floor picker.  [Architect → Developer: web + server contract]
- [x] 8i. **Named, customizable heroes**: persistent characters per project and role (name, look: skin, hair, outfit color, hat/costume variant, pronoun-free title). Subagents are assigned to heroes (this ties in with 8c's reuse). Name pools per role you can edit, and a hero editor in the GUI; stored on the server (`heroes` module).  [Architect → Developer: server + web]
- [ ] 8j. **tagconn attribution in projects**: projects that used tagconn get a small `.tagconn/` marker (a README with the setup link and version, plus an optional `office.json` profile holding the floor name, layout and heroes), so the setup can be restored on another host. A SessionStart hook import of an existing profile, a GUI or skill "save profile to project", opt-in and on by default, never overwrites, no secrets. Security review required (writes into user repos).  [Architect → Developer: infra + server]
- [ ] 8k. **Orchestrator runner (M5, pulled into v0.3.0)**: `apps/runner`, a host daemon (not in Docker; it needs your CLI login and project dirs). It connects out to the server over socket.io with its own runner token and spawns `claude -p "<task>" --output-format stream-json --verbose` (plus `--resume` for follow-ups) using your subscription login, with no API key. Browser: assign a task to a floor or character, watch the streamed progress live on the characters, send follow-ups, stop a run. Guardrails: `runner.allowedProjectDirs` allowlist, `runner.permissionMode` and `runner.maxConcurrent` (settable from file or env only, never the GUI), and a visible quota/usage note.  [Architect → Developer: runner + server + web]
- [ ] 8l. **Receptionist (help desk)**: an independent read-only assistant you chat with in the browser. It's a character at the Guild Gate. It runs through the runner with `--permission-mode plan`, a read-only tool allowlist (Read, Grep, Glob, WebSearch, WebFetch) and an explicit disallow list for Edit, Write, Bash and NotebookEdit, and it can never change a project. It can answer questions about any floor/project (read-only) or about tagconn itself. It streams answers into a chat panel, keeps conversation history and resumes the session.  [Architect → Developer: web + runner]
- [ ] 8m. **GUI admin auth for code execution** (decision 12 revisited): because the browser can now start Claude runs, run and receptionist actions need an admin session. It is a same-origin bootstrap token issued to the local UI, sent in the socket handshake and on REST writes, separate from the hook and runner tokens. There are regression tests for cross-origin, CSRF and rebinding attempts against the run endpoints.  [Architect + Security → Developer: server + web]
- [x] 8n. **Richer rooms + door editing + reachability** (user request): furnishing fills rooms properly for their size and type (no more mostly empty server rooms); per-room controls (density, seat/desk count, decoration amount, aisle width, reroll seed) and layout-wide defaults; editable doors (add, move, resize, delete; explicit list or auto); a reachability check that shows exactly which rooms or seats are blocked and why, with one-click fixes. Contract done (`RoomFurnish`, `DoorSpec`, door validation).
  - [x] P1 procgen furnishing engine + doors + reachability report (16 new furniture kinds; 3 reachability bugs fixed)  [Developer: web]
  - [x] T1 new furniture/decor kinds painted in modern, guild and rift + style pass (cream office walls, framed doors, grout floors, guild windows/banners); whole map baked into one texture (8-22 ms)  [Developer: web]
  - [x] E1 Hall Planner: furnishing inspector, door tool, reachability overlay with one-click fixes  [Developer: web]
- [x] 8p. **3/4 back wall + appliances** (from the style references): a tall north-wall face per room, north-wall decor slots (windows, clocks, pictures, shelves) and standing appliances (printer, fridge, water cooler, filing cabinet, fireplace, barred cells for the guild vault). Design: `docs/design/back-wall.md` (tall face over the wall tile + walkable overdraw band, 10 appliance kinds on the top row, wall-decor slots, seat/walkability parity, no scene change)
  - [x] T0+T1 procgen contracts + back-wall/appliance placement (parity over 300 seeds; +25-30% generation time, within the hard budget)  [Developer: web]
  - [x] T2+T3 paint back wall, wall decor, appliances in modern/guild/rift  [Developer: web]
  - [x] T4 fireplace/window bloom in postfx
- [x] W3b place the Receptionist NPC at each floor's entrance / the Nexus gate (after 8o touches OfficeScene)
- [x] 8o. **Shaders** (user request): WebGL post-processing: per-style color grading, vignette, bloom on light sources (torches, braziers, monitors, windows) via a light layer so pixel art stays crisp, flame flicker (reduced-motion aware), optional CRT scanlines for modern; `office.shaders.*` settings (contract done), auto quality, canvas fallback  [Developer: web]
- [~] 8g. Final code review [x] (no blockers; listener-cap warning fixed) · security review SC5 = NOT READY (2 High: runner acts on unverified reconnects [PoC]; quests inherit user allow rules and all tools; 3 Med: home config writable, no timeout, save temp file follows symlinks) → fixes: server/installer [x], runner [x] · QA non-CLI scenarios pass · SC5 re-review [~] · real-CLI quest/receptionist/acceptance [~] · QA small fixes (pair --label, CORS log, sandbox stateDir) [~] · QA end-to-end incl. real-CLI quest/receptionist and runner acceptance (a)–(i) → fixes → v0.3.0

## Backlog
- [ ] Upgrade better-sqlite3 to 13.x and unpin Node once 24.2x is verified (decision #24)
- [ ] nginx `/assets/`: duplicate Cache-Control (expires + add_header); Firefox check of the CSP
- [ ] Move timing/perf tests into a separate `pnpm test:perf` run (they flake when the machine is loaded)
- [ ] Sprite pack / Tiled map support (optional; the procedural guild skin comes first)

## M5 (v2): Orchestrator runner → moved into M8 (8k, 8l, 8m) for v0.3.0
