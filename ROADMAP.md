# tagconn roadmap

Live progress tracker. Legend: `[x]` done · `[~]` in progress · `[ ]` todo · owner in brackets.
Plan: `~/.claude/plans/let-we-brainstorming-i-elegant-abelson.md`

## M0: Discovery & contracts [PM / Architect]

- [x] Capture real Claude Code hook payloads → `apps/server/test/fixtures/subagent-session.json`
- [x] Monorepo scaffold (pnpm workspaces, turbo, tsconfig presets)
- [x] Shared contracts `packages/shared` (hook schema, domain, roles, settings, socket.io events)
- [x] Default role templates `packages/agent-templates/roles/*.md`
- [x] App package manifests + one-time `pnpm install`
- [x] Project-local subagents `.claude/agents/*.md` (so future sessions can use the roles)
- [x] `CLAUDE.md` (session bootstrap) + `docs/architecture.md` + `docs/decisions.md`

## M1: Server core + ingest [Developer: server] (done, stretch left)

- [x] Fastify app, core plugins: config (layered), db (Drizzle/SQLite), logger, DI (awilix), event bus, socket.io
- [x] `ingest` module: POST /api/hooks, token auth, redaction, normalize
- [x] `projects`, `sessions`, `agents` (state machine), `activity` (rule mapping), `tasks` modules
- [x] `settings` module (REST + socket, hot reload), `roles` module (CRUD + sync to ~/.claude/agents)
- [x] `transcripts` module (token usage), done in M6
- [x] Vitest: reducer / agent FSM against fixtures

## M2: Web office [Developer: web] (done)

- [x] Vite + React shell, typed socket.io client, zustand store
- [x] Panels: projects/floors, roster, kanban, event log
- [x] Phaser office: generated tilemap, zones, characters, pathfinding, bubbles, despawn
- [x] Settings page (all settings, restart-required flags) + Roles editor

## M3: Infra & install [Developer: infra / DevOps] (done)

- [x] `packages/hook/office-hook.sh` (sh + curl, always exit 0)
- [x] `scripts/install.ts` / `doctor.ts` (hooks into ~/.claude/settings.json, token, agents, skills)
- [x] Custom skills: office-kickoff, handoff-report, definition-of-done, task-sizing
- [x] Dockerfiles, nginx, docker-compose.yml, `.env.example`
- [x] README

## M4: Verification [QA · Code Reviewer · Security]

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

## M5 (v2): Orchestrator runner → moved into M8 (8k, 8l, 8m) for v0.3.0

## M6: Wave 2 (session 2) [PM]

- [x] Contract: `TokenUsage` on Agent/Session, `sessions.{idleAfterSec,endAfterSec}`, `transcripts.{enabled,debounceMs}`, `WHOLESALE_REPLACE_SETTINGS` in shared
- [x] Server: transcripts module (token usage per agent/session, deduped, path-contained to projectsDir) + session settings; 71 server tests [Developer: server]
- [x] Web: token usage in roster/drawer/top bar, "Manage floors" (rename/archive), demo usage; 41 web tests [Developer: web]
- [x] Tests: 57 tests for `scripts/install.ts` + `doctor.ts` (unit + sandboxed integration + real-paths guard), `pnpm test:scripts` [Developer: infra]
- [x] Security review of wave 2: 3 Med (symlink/TOCTOU escape, unbounded line buffer, unbounded tracked files), 5 Low; release.ts + install.ts clean
- [x] Code review of wave 2: 1 High (usage update could resurrect a removed agent), 3 Low
- [x] Fix pass: transcripts hardening (fd-based open, O_NOFOLLOW, per-read containment, caps, LRU, id validation, TextDecoder) + web floor-usage fix; 99 server tests

## Bugs / UX

- [x] Live server crash loop (Node 24.21 + better-sqlite3 native assertion); Docker pinned to node:24.16, live server rebuilt from the deployed code; 0 restarts since
- [x] Canvas safe region: the agent panel no longer blocks the map; insets-aware camera, drag-pan always works, center selected agent in the visible area, Follow, Esc/click-away to close; 142 web tests [Developer: web]

## M7: Magic Guild Hall: themes, office editor, procedural generation, stairs [PM plan]

Decisions: a style ("skin") is separate from lighting (`office.style`: `modern` | `guild`). A floor is still a project;
the stairs on every floor lead to the next or previous floor. Layouts are saved data (rooms = drawn rectangles + room type)
and the map (walls, doors, corridors, furniture, seats) is generated from them deterministically with a seed.

- [x] 7a. Design spec `docs/design/guild-hall.md` + contract (`layout.ts` with `validateLayout`/`DEFAULT_LAYOUT`, `office.style`=guild, floor settings, layout socket events) [Architect]
- [x] 7b. Server `layouts` module: CRUD REST+socket, read-only seeded default, `project.layoutId` assign/clear + delete cascade, snapshot.layouts, migration 3; 84 server tests [Developer: server]
- [x] 7c. Procgen engine (done: seeded, property-tested over 300 seeds × 4 sizes × 2 backgrounds, perf < 50 ms) `apps/web/src/game/procgen/`: rooms → walls, doors, corridors, furniture, seats; BSP "surprise me" generator; tests [Developer: web A] (after wave 2 web)
- [x] 7d. Theme system (done: modern port + guild skin, costumes, fx gated by ambientEffects/reduced motion; 44 theme tests) `apps/web/src/game/themes/`: modern + **guild** skins, drawn in code (stone, torches, banners, runes, particles), role costumes and titles, magical activity verbs [Developer: web B] (parallel with 7c)
- [x] 7e-A. Office editor "Hall Planner": draw regions → pick room type, move/resize, stairs, validation, Surprise me, preview, save/assign, undo/redo (190 web tests incl. 34 new; typecheck/build green; manual playwright-cli pass) [Developer: web A]
- [x] 7e-B. Scene integration: generated maps + guild skin live (costumes, titles, verbs, fx), interactive stairs + floor transitions, PageUp/PageDown/Home/End, TopBar floor indicator, 3-floor demo; 190 web tests [Developer: web B]
- [x] 7f. Review + security + QA of M7 → fixes → docker rebuild → release v0.2.0
  - [x] Security: 0 Critical/High; 2 Med (layout ids that break the id rule are stored but can't be listed or deleted; no cap on stored layouts and a snapshot carries them all), 4 Low (defaultLayoutId "constructor" breaks the view, A* node limit, lost updates, socket arg validation)
  - [x] Code review: 1 High (floor hotkeys fire under the open editor), 1 Med (camera zoom compounds on each floor change), 1 Low (transition re-entrancy)
  - [x] QA: 7/9 pass, 0 console errors; bugs: ambientEffects toggle not live (Med), camera fit/focus centering wrong esp. zoomed in (Med/High), roster titles not themed (Low)
  - [x] Server security fixes (layout id validation + purge, maxStoredLayouts 200, defaultLayoutId existence, baseUpdatedAt 409, socket arg validation, name sanitizing); 109 server tests
  - [x] Web fixes A (camera fit/focus math, zoom drift, transition lock, hotkeys under editor, live ambient toggle, animated TopBar floor jump)
  - [x] Web fixes B (client layout hardening, editor baseUpdatedAt/409 dialogs, Edit floor entry, themed roster titles, procgen A* limits) [Developer: web B]
- [x] 7g. Follow-ups: animated TopBar floor jump (fixes A), "Edit floor" entry in Manage floors (fixes B, done)

## M8: Living Office UX + Multiverse + Heroes + Attribution + Runner + Receptionist → v0.3.0 [released 2026-09-26]

- [x] Design A `docs/design/living-office.md` (8b, 8c, 8h, 8i) + `heroes.ts`, `multiverse.ts` [Architect A]
- [x] Design B `docs/design/runner-and-helpdesk.md` (8j, 8k, 8l, 8m) + `runner.ts`, `receptionist.ts`, `auth.ts`, `attribution.ts` [Architect B]
- [x] SC1 security design review: approve with 10 required changes (mutual HMAC runner auth, exact --tools/--restricted Receptionist, bwrap redesign, CLI-trust gate + host quest policy, fail-closed gating, docs-only add-dir, CSP, WebFetch allowlist, mode mapping, import never touches roles) [Security]
- [x] Design B revision per SC1 (rev 2; 10 items TBD by SC3) [Architect B]
- [x] SC3 empirical CLI verification: 2 critical confirmed (repo settings redirect API traffic without --setting-sources; unscoped WebFetch reaches loopback), --restricted + bwrap verified, setsid escapes group kill; V15 pending [QA]
- [x] Design B finalization with SC3 facts (rev 3) [Architect B]
- [x] Contract patch A (heroes, pm mode, multiverse) applied [PM]
- [x] Contract patch B (runner/auth/receptionist/attribution; whole runner + auth sections GUI-immutable) [PM]
- [x] Wave B1: S1 admin auth/pairing/gating [x] · S2 runs module + /runner HMAC [x] · R1 host runner [x] (protocol verified against a real socket.io server) · I1 hook/installer/doctor/pair [x] · D1 nginx CSP [x]
- [x] Wave B2: S3 receptionist module [x] · S4 attribution module [x] · S5 run↔session linking [x] · W1 web auth [x] · W2 quest board [x] · W3 receptionist UI [x] · W4 settings/attribution UI + Vite CSP [x] (restarted 2026-09-26 after a usage-limit interruption)
- [x] SC2 security review of S1 + S2: NOT READY: 1 High (unauthenticated /runner crash, confirmed), 5 Med (idle expiry never runs out, pairing lockout DoS, runner.enabled ignored, missing server dir check, caps don't stop storage), 8 Low; flakes are test-side fixed sleeps
- [x] SC2 fixes (auth + runs): H1 crash fixed (safe-ack + try/catch in runs.gateway.ts), M1-M5 and L1-L8 all addressed (idle-expiry touch split, pairing bucket separation, runner.enabled enforced at handshake+enqueue, server-side dir check + pre-dispatch schema parse, output-cap drop-and-single-stop with a persisted byte counter, redaction, resume provenance, unverified-socket cap, boot token validation); flaky fixed-sleep tests replaced with vi.waitFor; awaits Q1 sign-off [Developer: server]
- [x] Q1 M8 security tests + real-CLI R1 acceptance (a)–(i) in sandbox; SC2 (after S1+S2) (covered by SC2/SC5 and the QA8–QA10 real-CLI runs)
- [x] SC4 security review of I1: approve with required changes (3 Med: hook sed slows big events, skill pointed at .env, pair prints link on squatter mismatch; 6 Low)
- [x] I1 fixes for SC4 (132 script tests) [Developer: infra]
- [x] S4 requirement from SC4: a rejected profile import never echoes, logs or stores the raw body (logger-spy test)
- [x] Wire `attribution:save` (server + web button) to the runner's `attribution:write`; export endpoint stays public per design
- [x] Wave A1: H1 server heroes [x] · W2 web hero data [x] · W3 cast resolver [x] · W4 hero look/preview [x] · W6 multiverse plan + rift theme [x]
- [x] Wave A2: W5 hero editor UI [x] · W7a scene integration [x] · W7b React bridge + floors [x] (uncommitted)
      User request: no stale characters, one clear PM per floor, reuse idle characters, glow on the selected character, bubbles that never overlap, and UX best practice for showing characters and the office.
      Diagnosis (live data, 2026-09-25): subagents whose SubagentStop never arrived (killed or lost background agents) stay "active/idle" in the lounge forever
      (the sweeper only moves them to the lounge); each Claude session has its own PM, and idle or abandoned sessions only end after `sessions.endAfterSec` (30 min),
      so parallel or old sessions leave extra PMs on a floor.
- [x] 8a. Server lifecycle (done: staleAfterSec 900, pmIdleLeaveSec 600, swept sessions finish their agents, boot recovery; 114 server tests): `agents.staleAfterSec` (default 900). A subagent with no events past it is marked `done` (reason `stale`) and leaves the floor; it comes back if a later event arrives. The main agent of an idle session leaves the floor after `sessions.pmIdleLeaveSec`. Recovery at restart; tests with a replay of lost SubagentStop. [Developer: server]
- [x] 8b. One PM per floor: the floor's "Guild Master" is the main agent of the most recently active session; other live sessions show as smaller "Deputy" characters with a session badge (or collapse into a count chip). Configurable `office.pmMode: single | per-session`. [Architect → Developer: web]
- [x] 8c. Character pool / reuse: when a subagent spawns and an idle character of the same role is on the floor, that character takes the new quest (walks from the tavern to the new zone) instead of a new sprite spawning; idle characters leave (walk out) after `office.idleLeaveSec`. Presentation-only mapping of agent → actor in the web. [Developer: web]
- [x] 8d. Selection glow (done: WebGL preFX glow + canvas ring, hover, focus dim): WebGL preFX glow (Phaser 3.60+ `preFX.addGlow`) in the role color with a pulse, plus a canvas fallback ring; the other characters dim slightly in focus mode. [Developer: web]
- [x] 8e. Bubble and label declutter (done: collision-free layout, priority, cap+collapse, zoom LOD, counter-scale; 278 web tests): collision-free bubble layout (greedy placement with stacking and leader lines), priority for the selected/newest/waiting characters, max visible bubbles, fade after `bubbleSeconds`; zoom-based level of detail (names and bubbles hidden when zoomed out, shown on hover); hover card; "waiting for you" gets a persistent badge. [Developer: web]
- [→] 8f. UX review pass: moved to M9.
- [x] 8h. **Multiverse floor** (replaces "All floors"): a special floor showing every project's characters together. Its layout is generated each time from the live projects (a central Nexus with one realm per project, joined by rift corridors), and the special "rift" style blends each project's own style per realm with a starfield/void between them. Reachable by the stairs (top floor) and from the floor picker. [Architect → Developer: web + server contract]
- [x] 8i. **Named, customizable heroes**: persistent characters per project and role (name, look: skin, hair, outfit color, hat/costume variant, pronoun-free title). Subagents are assigned to heroes (this ties in with 8c's reuse). Name pools per role you can edit, and a hero editor in the GUI; stored on the server (`heroes` module). [Architect → Developer: server + web]
- [x] 8j. (shipped in v0.3.0) **tagconn attribution in projects**: projects that used tagconn get a small `.tagconn/` marker (a README with the setup link and version, plus an optional `office.json` profile holding the floor name, layout and heroes), so the setup can be restored on another host. A SessionStart hook import of an existing profile, a GUI or skill "save profile to project", opt-in and on by default, never overwrites, no secrets. Security review required (writes into user repos). [Architect → Developer: infra + server]
- [x] 8k. (shipped in v0.3.0) **Orchestrator runner (M5, pulled into v0.3.0)**: `apps/runner`, a host daemon (not in Docker; it needs your CLI login and project dirs). It connects out to the server over socket.io with its own runner token and spawns `claude -p "<task>" --output-format stream-json --verbose` (plus `--resume` for follow-ups) using your subscription login, with no API key. Browser: assign a task to a floor or character, watch the streamed progress live on the characters, send follow-ups, stop a run. Guardrails: `runner.allowedProjectDirs` allowlist, `runner.permissionMode` and `runner.maxConcurrent` (settable from file or env only, never the GUI), and a visible quota/usage note. [Architect → Developer: runner + server + web]
- [x] 8l. (shipped in v0.3.0) **Receptionist (help desk)**: an independent read-only assistant you chat with in the browser. It's a character at the Guild Gate. It runs through the runner with `--permission-mode plan`, a read-only tool allowlist (Read, Grep, Glob, WebSearch, WebFetch) and an explicit disallow list for Edit, Write, Bash and NotebookEdit, and it can never change a project. It can answer questions about any floor/project (read-only) or about tagconn itself. It streams answers into a chat panel, keeps conversation history and resumes the session. [Architect → Developer: web + runner]
- [x] 8m. (shipped in v0.3.0) **GUI admin auth for code execution** (decision 12 revisited): because the browser can now start Claude runs, run and receptionist actions need an admin session. It is a same-origin bootstrap token issued to the local UI, sent in the socket handshake and on REST writes, separate from the hook and runner tokens. There are regression tests for cross-origin, CSRF and rebinding attempts against the run endpoints. [Architect + Security → Developer: server + web]
- [x] 8n. **Richer rooms + door editing + reachability** (user request): furnishing fills rooms properly for their size and type (no more mostly empty server rooms); per-room controls (density, seat/desk count, decoration amount, aisle width, reroll seed) and layout-wide defaults; editable doors (add, move, resize, delete; explicit list or auto); a reachability check that shows exactly which rooms or seats are blocked and why, with one-click fixes. Contract done (`RoomFurnish`, `DoorSpec`, door validation).
  - [x] P1 procgen furnishing engine + doors + reachability report (16 new furniture kinds; 3 reachability bugs fixed) [Developer: web]
  - [x] T1 new furniture/decor kinds painted in modern, guild and rift + style pass (cream office walls, framed doors, grout floors, guild windows/banners); whole map baked into one texture (8-22 ms) [Developer: web]
  - [x] E1 Hall Planner: furnishing inspector, door tool, reachability overlay with one-click fixes [Developer: web]
- [x] 8p. **3/4 back wall + appliances** (from the style references): a tall north-wall face per room, north-wall decor slots (windows, clocks, pictures, shelves) and standing appliances (printer, fridge, water cooler, filing cabinet, fireplace, barred cells for the guild vault). Design: `docs/design/back-wall.md` (tall face over the wall tile + walkable overdraw band, 10 appliance kinds on the top row, wall-decor slots, seat/walkability parity, no scene change)
  - [x] T0+T1 procgen contracts + back-wall/appliance placement (parity over 300 seeds; +25-30% generation time, within the hard budget) [Developer: web]
  - [x] T2+T3 paint back wall, wall decor, appliances in modern/guild/rift [Developer: web]
  - [x] T4 fireplace/window bloom in postfx
- [x] W3b place the Receptionist NPC at each floor's entrance / the Nexus gate (after 8o touches OfficeScene)
- [x] 8o. **Shaders** (user request): WebGL post-processing: per-style color grading, vignette, bloom on light sources (torches, braziers, monitors, windows) via a light layer so pixel art stays crisp, flame flicker (reduced-motion aware), optional CRT scanlines for modern; `office.shaders.*` settings (contract done), auto quality, canvas fallback [Developer: web]
- [x] 8g. Final code review [x] (no blockers; listener-cap warning fixed) · security review SC5 = NOT READY (2 High: runner acts on unverified reconnects [PoC]; quests inherit user allow rules and all tools; 3 Med: home config writable, no timeout, save temp file follows symlinks) → fixes: server/installer [x], runner [x] · QA non-CLI scenarios pass · SC5 re-review: approve with required changes (R1 runner can stay offline after a dropped handshake, R2 stateDir deny needs `//`, R3 real-CLI permission checks) → runner fixes [x] (reconnect recovery, // deny paths, wider home/secret denies, bwrap real binary, probe cwd) · real-CLI QA: quest PASS (exact --tools confirmed), receptionist PASS with sandbox off, V15 PASS; 2 High bugs → quest session linking via run.linked [x], receptionist bwrap exec [x]; final real-CLI checks QA10 [x]: quest link, receptionist, permission semantics C1-C5 all pass (single-slash absolute deny confirmed NOT to block, so `//` is required); fixed bwrap auto-detect false negative (probe ordering) with a unique key-probe cwd and cache v2 · QA small fixes (pair --label, CORS log, sandbox stateDir) [x] · QA end-to-end incl. real-CLI quest/receptionist and runner acceptance (a)–(i) → fixes → **v0.3.0 released**, images rebuilt (Node 24.16) and live on :4317/:4318

## M9: UX polish → v0.4.0 [released 2026-09-26]

- [x] 8f → M9. UX review pass (audit done; minimap deferred): T1 `[`/`]` keyboard character cycling + live announcement [x] · T2 `?` hotkey help overlay + TopBar contrast/motion [x] · Esc closes Manage floors / sessions popover (not while renaming) and never also the drawer underneath [x] · QA (all 7 areas pass in a real browser) + review (stairs no longer swallow character clicks; focus stays in Manage floors after a rename) [x] · T3 reduced-motion leave fade, attention chip contrast, `setHitScale` [x] · T4 dialog focus trap/return [x] · T5 Roster contrast, reduced-motion pulses [x] · T6 ≥24px hit targets at low zoom [x]. Original checklist: a best-practice checklist (focus + context, level of detail, affordances, motion guidelines, accessibility: reduced motion, contrast, keyboard navigation of characters), optional minimap. [Analyst/Architect → Developer]
- [x] 9a. Hover tooltip follows the cursor at every zoom (scrollFactor-0 text is still scaled by camera zoom) and hides when you travel (the hovered zone is destroyed before `pointerout`). [Developer A]
- [x] 9b. Monitor screen effects: `office.shaders.screen` (off/CRT/LCD/VHS) + `screenStrength`, a per-browser top-bar toggle (V) that overrides the server default. [Developer B]
- [x] 9c. Pixel-style edge vignette (user feedback: only a frame at the edges, `vignetteSize` 0.12; the middle stays clean): hard stepped bands (default 4 = 25/50/75/100%) on a blocky grid aligned to art pixels; `vignetteStyle: pixel | smooth`, `vignetteSteps`, `vignettePixel`. [Developer B]
- [x] 9e. User guide `docs/guide/` (pairing, Receptionist, runner, office, attribution, display, config, troubleshooting) + README links
- [x] 9f. Unpaired saves ask to pair at once (shared `socketEventNeedsAdmin`, used by the server gate and the web socket gate) instead of a 10s "Timed out waiting for settings:update"; `office:pair` hint when the server has no runner token; Phaser `new Function` stripped from the build (CSP console warning)
- [x] 9d. QA (browser: tooltip, vignette bands, screen toggle, unpaired save prompt all pass) + code review (timeout no longer logs a paired user out), then rebuild the web image

## M10: Hardening → v0.4.1 [released 2026-09-26]

- [x] 10a. `TodoWrite` dropped from QUEST_TOOLS_BASELINE (the CLI silently dropped it from `--tools`)
- [x] 10b. nginx `/assets/`: one `Cache-Control: public, max-age=31536000, immutable` (no duplicate from `expires`); the CSP eval warning was fixed in v0.4.0
- [x] 10c. better-sqlite3 13.0.3 + Docker on node:24.21.0 (3-min hook soak, ~73k events, 0 restarts on 24.21 and 24.16; decision #26)
- [x] 10d. Timing/perf tests moved to `pnpm test:perf` (procgen speed, hook large-body gate; `*.perf.test.ts`)
- [x] 10e. Deferred 8f UX: no follow-glide under reduced motion, "Raise the limit" on the character-cap banner, a "Connecting…" canvas state (+ a stable `#settings-<section>` anchor)
- [x] 10f. Quests + Receptionist empty/loading/error/offline states with the exact next step (pair, `pnpm office:runner` + copy, env var, capability, Retry on failed loads)
- [x] 10g. QA + review (fixed: web image build after better-sqlite3 13 via a filtered install, demo quests, pair-flash while auth loads, stale run error), release v0.4.1

## M11: tagconn Desktop (Windows + Linux) → v0.5.0 [in progress]

One app (Tauri 2 + a bundled Node sidecar) with a setup wizard and an XAMPP-style control panel; native services by
default, Docker optional; installer + auto-update. Design: `docs/design/desktop.md`. Decisions #27, #28.

- [x] 11.0 Plan persisted (design doc, roadmap, decisions) [PM]
- Wave 0: contract + spikes
  - [x] W0a `packages/shared/src/desktop.ts` RPC contract; `server.webDir`; `corsOrigins` + :4317 [PM]
  - [~] W0b Hook execution on Windows: docs say shell form = Git Bash or PowerShell, exec form (`command`+`args`) = no shell → desktop registers the node hook in exec form; confirm on a real Windows machine [user]
  - [x] W0c claude on Windows: `where.exe claude` then `%USERPROFILE%\\.local\\bin\\claude.exe` (npm = `.cmd` shim); login = `claude auth status` exit code (docs)
  - [ ] W0d Windows deny-rule path form: undocumented → policy writes both `//C:/…` and `C:/…` until a canary test on a real Windows machine confirms [user]
  - [ ] W0e Spike: better-sqlite3 13 prebuild for node 24 win-x64 [QA, Windows CI]
- Wave 1: portable core (parallel)
  - [x] A Server serves the web app (`@fastify/static`, shared security headers, SPA fallback, cache rules) + path portability (`~\`, backslash transcript paths) [Developer]
  - [x] B Cross-platform node hook `office-hook.mjs` (parity with the sh hook, exit 0, no stdout, 1 s, ACL'd `hook.json`) + parity + perf tests [Developer]
  - [x] C Runner platform layer (`where`, `taskkill /T`, no systemd/bwrap, `%LOCALAPPDATA%`, win32 policy: no Bash, max acceptEdits, Receptionist unsandboxed read-only) [Developer]
  - [x] D `packages/setup` (install/doctor/pair core, OS paths, ACL/chmod, atomic settings.json merge + rollback); scripts become thin CLIs [Developer]
  - [~] 11.1 One small `.tagconn/` per project (user decision 2026-09-29): `.office/` agent memory → `.tagconn/work/` (git-ignored via `.tagconn/.gitignore`), skills updated [x]; README template cut to 5 lines [x]; both hooks add the README next to agent-made `work/`/`.gitignore` and still honour the `.tagconn`-file opt-out [x]
  - [x] 11.2 Windows-specific quest denies (done in 11.3 S1); web rejection guidance Windows text [x] (RunnerStatus.platform added) (AppData credential stores, PowerShell profiles, npm) + Windows text in web rejection guidance  [security review → Developer]
- Wave 2: the app (parallel)
  - [x] E `apps/supervisor`: stdio JSON-RPC, service manager (backoff, health, logs, tree-kill), setup, Docker mode, auto-pair [Developer]
  - [x] F `apps/desktop` (Tauri 2; wizard + service start + paired office verified on Linux; supervisor orphan-spin found and fixed): sidecar + tray + autostart/updater/single-instance; React wizard + control panel [Developer]
- Wave 3: packaging + docs
  - [x] G CI `desktop.yml` (Linux AppImage + .deb built and smoke-tested locally; the Windows job runs on the first tag/dispatch) (windows + ubuntu matrix, node sidecar, NSIS/AppImage/deb, signed updater, ghcr images) [Developer]
  - [x] H Docs: `docs/guide/desktop.md`, README download-first quick start, CLAUDE.md commands [Tech writer]
- Gates
  - [x] Wave 1 sandboxed e2e QA pass (node hook with 3 real haiku sessions, webDir, uninstall); fixed: settings.json line/column, install preflight
  - [~] 11.3 Wave 1 security review (1 High, 4 Med, 12 Low) → fixes S1 runner/shared [x], S2 setup [x], S3 hook [x], S4 server [x]; re-review [x]: no Critical/High; 5 Medium + Lows (N1–N16) → round-3 fixes 11.4
  - [x] Wave 1 security review + sandboxed e2e QA (node hook exec form with a real haiku session, webDir serving, install/uninstall/rollback)
  - [x] 11.4 Round-3 security fixes: runner N3/N10/N11 [x], setup N9/N16 [x], supervisor+server N1/N2/N6/N7/N8/N13/N15 [x], desktop N5/N14 [x], runner dataDir deny + parent watchdog [x]; N4 (Windows path aliases) needs the real-Windows canary
  - [x] 11.6 Desktop QA fixes: A, B, C, E, F, G, H, L, M in apps/desktop; B (start resolves on running), D, I, J, K + crash hint in the supervisor/server  [Developers T1, T4]
  - [x] 11.5 Locale-independent Windows ACL checks: runner winAcl.ts and setup secrets.ts/nodeRuntime.ts match SYSTEM/Administrators by English name, so a non-English Windows fails closed (install refused). Read ACEs as SIDs (PowerShell `Get-Acl` + `IdentityReference.Translate([SecurityIdentifier])`, path via env) and share one parser  [Developer]
  - [x] 11.7 Final desktop QA (GUI smoke on Linux): A B C D E F I J K M + pairing/log/planted-config/wizard pass; L fails, G partial, 5 Lows → 11.8 + final security pass [x]: no Critical/High; 4 Medium (M1 dispatch can clobber a published signed release, M2 signing key in the build env + tag-pinned actions, M3 `pnpm deploy --legacy` ignores the lockfile, M4 .deb installs /usr/bin/node) + L1–L8
  - [x] 11.8 Final-pass fixes: CI/packaging M1–M4, L7, L8 [x]; runner/setup L1, L3, L4, N16 [x]; Tauri L2, L5, L6, M4 rename + QA L, G, Lows + early runner watchdog [x] (cargo check clean)
  - [ ] Security review (node hook, token ACLs, Windows runner policy + deny paths, supervisor args, Tauri capabilities, updater signature)
  - [x] QA: Linux control panel/settings/logs/tray/quit/a11y pass: 3 bugs (A wizard hijacks the panel on a port re-check, B open-office-on-start race, M wizard focus loss) + D–L → 11.6; Linux sandboxed wizard run [x] + AppImage; Windows CI install smoke; manual Windows pass with the user; updater across two pre-releases
  - [x] Release: v0.5.0 tagged (its CI packaging failed: merged-config, dpkg path check, Windows unzip), v0.5.1 published with the preview installers (unsigned, updates off) + SHA256SUMS; ghcr.io/ilomon10/tagconn-server:0.5.1 public; Windows CI build + silent install + headless smoke green
  - [ ] Signed releases: user creates the `release` environment (reviewers, v* tag rule), a v* tag ruleset and the signing key; PM sets the updater pubkey → updates on
  - [ ] Real-Windows checklist (docs/design/desktop.md, 17 items; N4 path aliases first) → drop the "preview" label

## M12: Office fixes + "the office is the game" → v0.5.2 (fixes) / v0.6.0 (features) [released 2026-10-01]

Plan: `~/.claude-sessions/profiles/ilomon/plans/fix-the-role-serene-creek.md`. User decisions (2026-10-01): floors = git root
(session pinned to its first floor, subfolder floors merged), compact top bar + ☰ game menu with overlay panels, a hero's
role can't change while bound, fixes ship first.

- [x] W0 contract: hook `x-tagconn-project-root` + `parseProjectRootHeader`; hero `role` patch + per-style `styles`;
      `PinnedFurniture` + `pinned-*` issues; `office.drama/furnitureTriggers/selectionBeacon`; `Agent.toolStartedAt`; web `titleFor` [PM]
- Wave 1 (fixes + shell → v0.5.2)
  - [x] F1 Floors: session pinned to its first project, hook sends the git root, boot merge of subfolder floors (+ heroes server: role move, styles) [Developer: server]
  - [x] F2+F3+F5 Scene: themed titles everywhere in the scene, selection beacon + off-screen arrow, Receptionist as a real Character, pinch zoom [Developer: game]
  - [x] F4 Heroes UI: name pools accept space/Enter, role select (disabled while bound), per-style tabs, Rift preview [Developer: heroes]
  - [x] F6 Shell: compact top bar + ☰ menu, overlay panels, responsive phone/tablet, floor-style titles in React [Developer: shell]
  - [x] Gate 1: QA (7/7 pass; Esc on Heroes/Receptionist/after Save, Receptionist + planner on phones) + review (High: automatic destructive merge) + security (High: Windows bare `git` lookup; Med: `~`/`C:\` ancestors, `core.worktree` spoof) → fixes [x]: merge/fold only into confirmed git roots (`root_source`, ≥3 segments, backup, live `project:merged`), hook absolute git + cleared env + toplevel must contain the project dir + cache, cwd validation, overlay Esc stack, phone layouts, scene lows, rift tint; supervisor backoff test de-flaked → re-review [x] (code: 3 Med, security: 1 Med: token holder could force a merge into `~/Projects`) → final fixes [x]: home dirs + direct children never absorb, git header needs cwd inside it, fresh 0600 backup per merge off the request path with a 60 s failure cooldown, safe root cache + all `GIT_*` cleared, merged-floor handling in Heroes/Receptionist/stores → v0.5.2
- Wave 2 (features → v0.6.0)
  - [x] W2 design `docs/design/game-office.md` [Architect] + W2-0 contract (drama settings/types, `notice-board`/`roster-board`, `furnitureClick`) [Developer]
  - [x] G1 Drama: T1 content + rules (14 antics per style, strain lines, seeded pickers) · T2 engine (DramaDirector, Character strain/emote API, 12 icons, `streak` fx, drama label tier) [Developers]
  - [x] G2 HUD (T3): party bar of portraits, RPG status card (mana/XP/strain), Details dialog, phone pill + tray; the docked roster and side drawer are gone [Developer]
  - [x] G3 Furniture triggers (T4 layer + art, T5 one trigger item per action per floor, reception desk placed when missing) [Developers]
  - [x] G4 Furniture locking: T5 pins in procgen (placed first, never removed, `seatsFor`) · T6 Hall Planner Furniture tool (F): drag to lock, Release, Lock all, undo/redo [Developers]
  - [x] W2-W PM wiring: DramaDirector + FurnitureTriggerLayer in OfficeScene, `useFurnitureTriggers` in OfficeView; pin checks are warnings so a stale pin never drops a floor to the default layout
  - [x] Gate 2: QA (6/6 pass; drama settings not editable, stale "left" card) + review (5 Med: stuck drama after rebuild, streak off-by-one, HUD without on-a-roll, door edits skip pin prune, orphan recipe seat) + security (3 Low) + docs → fixes [x]: drama reset/reseat, shared streak API, nested Settings groups, card auto-clear, pin prune on door edits, auto-door aprons, issue dedupe/cap, trigger split-check cap, pin x/y max, prune/cap hints, preview textures, bubbles avoid name tags, 1-tile reception desk art → v0.6.0
- [x] v0.5.3 (from `release/0.5.x`): `office:runner` through `tsx` (ERR_MODULE_NOT_FOUND) + `tsx` as a root devDependency, connect/probe logs

## M13: The office comes alive → v0.7.0 [released 2026-10-01]

Plan: `~/.claude-sessions/profiles/edgar/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md`. User decisions (2026-10-01):
four milestones (M13 life sim, M14 battles, M15 light + furniture, M16 2.5D), sound synthesized in code (ADR #22), NPC
encounters may cause brief cosmetic chaos (never cover a waiting bubble, never touch real seats). Design: `docs/design/office-life.md`.

- [x] W0 design `docs/design/office-life.md` + contract (`office.labels/life/npcs/alerts/audio` settings, new furniture kinds, event fields) [Architect]
- Wave 1
  - [x] 13.1 RPG name plates: above the head, multi-line (name / title / wrapped task), code-generated pixel font [Developer: game]
  - [x] 13.4 Game-style alerts: JRPG text box, token-bucket rate limit + coalescing [Developer: web]
  - [x] 13.5 Sound: WebAudio synth SFX + ambient bed, per-browser mute/volume [Developer: audio]
  - [x] Life furniture: arcade, ping-pong, foosball, board-game table, water cooler, sofa (procgen + 3 styles) [Developer: procgen/art]
- Wave 2
  - [x] 13.2 Life director: kickoff meetings with invites and a straggler, stand-ups, idle activities (games, coffee, naps) [Developer: game]
  - [x] 13.3 NPC director: janitor, courier, plant waterer + random encounters (guest, police, CIA, sales dog, monster, cat) with cosmetic chaos [Developer: game]
  - [x] PM wiring into OfficeScene / OfficeView (W1-W plates/alerts/audio, W2-W life + NPCs; smoke fixes: plate gap, "unknown" alert, kickoff invitees may be mid-tool)
- [x] Gate: QA (all suites green; plates/alerts/Show me/Sound row/phone pass; NPC + reduced motion covered by unit tests only) + review (High: repeat alerts dropped forever; Med: stranded walkers on script timeouts, reactions outliving their NPC, ambient attenuated twice + no fade, alert voices starved) + security (Med: unbounded description in plate layout O(L²) and alert typewriter; Low: control/bidi chars, second ask never shown) + docs (5 guide pages, CHANGELOG) → fixes [x]: `lib/displayText` clip+sanitize, binary-search cuts, 5x9 pixel font with real descenders, forced goHome on timeouts, `cancelFor`, janitor cooldown kept, single ambient stage + fades/crossfade, alert voice reserve, allocation-free proximity tick → re-review [x] (code: 1 Med duplicate pending alerts; security: arrow label unsanitized) → final fixes [x] → v0.7.0

## M14: Encounters, battles and hero progression → v0.8.0 [released 2026-10-02]

Pokémon-style turn-based battles from M13 encounters (Battle / Ignore), party of 1–4 heroes, level from tokens spent
(`Agent.usage` deltas credited to the bound hero), stats + per-class skill trees, XP + cosmetic loot, soft KO.
Design: `docs/design/battles.md`.

- [x] W0 design `docs/design/battles.md` + threat model (14 findings, none Critical/High, all folded in) + shared contract, settings, battle engine, content/setup, web stubs [Architect + Security + Developers]
- [x] W0d balance simulation (median 4–8 turns; solo 57–79 % wins, parties 88–100 %, difficulty 2 harder) [Developer]
- [x] UI interaction sounds + transition sounds (floor, Multiverse, day/night): game-like feedback on menu/panel open-close, character selection, toggles, tabs, floor switch, save (user request 2026-10-01) [Developer: audio/web]
- [x] Server `progression` module: S1 storage + migration 12, S2 XP crediting + skills/title/heal routes, S3 battles create/resolve/abandon with replay validation + 26 security tests [Developer: server]
- [x] BattleScene (swirl + iris, stage, animations) + controller timeline + enemy/FX/KO art + battle HUD (menu, bars, log, results) + battle audio and music + themed copy [Developers]
- [x] Hero sheet "Stats & Skills" tab (skill tree, spend/respec/confirm) + HUD level badge + data layer and demo battles [Developers]
- [x] Encounter prompt + battle flow + party picker + overlay + KO presence + loot cosmetics + coffee-break heal [Developers]
- [x] Wave 3 wiring into OfficeGame/OfficeScene/OfficeView (demo battle end-to-end + Ignore, 0 console errors), results XP bar from real progress, 300 ms music stop fade, UI-sound close/open pairing + modal-aware hover, server-wide JSON `__proto__` guard [Developers]
- [x] Gate: QA (all suites green; live demo walk passes encounter → picker → swirl → commands → win/loss/run → KO 💫/🩹 → skills/respec → title on plate → Ignore → reduced motion → phone; D1 layering, D2 no encounters under reduced motion, D3 heal unreachable, D4 phone labels) + review (5 Med: stale battle handle, skill-save 409s, no resolve retry/version dead-end, leave mid-entry, XP not backfilled → documented) + security (0 Med; Low: hook events with __proto__ dropped, 48-key test gap, party description) + guide `docs/guide/battles.md` → fixes [x] (skills-only stamp + migration 13, Retry incl. 408/429, version guard, keyed flow events, battle HUD under the top bar, phone grid, static reduced-motion NPC visits, encounter priority, coffee machine placed, hook bodies strip __proto__ by matched route, redaction re-parse hardened) → re-review [x] → v0.8.0

## M15: Dual grid: offset rendering, half-tile furniture, sub-tile navigation → v0.9.0 [released 2026-10-02]

Plan: `~/.claude-sessions/profiles/edgar/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md` (top section). User
decisions (2026-10-02): keep the 16 px tile grid; the half tile (8 px) is the single sub-grid unit (spec adapted, not
copied); build both the offset "dual-grid" wall/floor rendering and a sub-tile collision/navigation layer; v0.8.0
published first. Designs: `docs/design/dual-grid.md`, `docs/design/navigation.md`; ADR #29.

- [x] W0 designs + ADR #29 [Architect]; contract: pin positions in halves (`layout.ts`), `office.dualGrid`, theme dual hooks + `DualCtx`, `nav/{constants,classes,types}.ts`, `GeneratedMap.nav?` [Developer]
- Wave 1 (parallel)
  - [x] D0 dual-cell model `themes/dual/{dualGrid,dualGeom}.ts` + tests
  - [x] T1 nav core `nav/{grid,shapes}.ts` (nibble masks, true clearance + incremental) + `nav.perf.test.ts`
  - [x] T2 procgen half-tile: one rasterizer (`procgen/geometry.ts`), pins/triggers/seats/backWall/spots on covered tiles
  - [x] T3 editor: half-tile drag snap, Alt+arrow 0.5, half-cell hit test, Inspector
  - [x] PM: `generate.ts` emits `nav`, derives `walkable` (152 files / 1765 web tests, perf green); quick gate [x] (review: 6 low, fixed; QA: pass, +20 tests)
- Wave 2 (parallel)
  - [x] D1 modern / D2 guild / D3 rift dual painters (`paint/dual/*`)
  - [x] T4 `nav/{heap,macro,adapter}.ts`: tile A*, `PathFinder` adapter, easystar parity on 300 seeds (easystar's heuristic was inadmissible: new paths never longer, 39% shorter)
- Wave 3 (parallel)
  - [x] D4 `renderTheme.ts` dual pass + flag wiring + `renderTheme.perf.test.ts` + PreviewScene (fillRect ≈1.05×, 15–25 ms)
  - [x] T6 `nav/{micro,navigator}.ts` + `Character.walkNav`; PM wired `OfficeScene.walk` → Navigator; `navClass` set from the creature; easystarjs now a devDependency (parity test only)
- [→] W4 (optional): shape insets per kind, denser recipe pitches, painter audit for fractional sizes → moved to M16 (furniture harmony)
- [x] Gate: QA (all suites green; frame-sampled walks smooth/any-angle, seats, toggle repaints with no reseat, half-tile editor, reduced motion, phone, zero writes) + review (1 Med: navigator repair returned null → teleport; lows) + security (no exploitable issues; Low: float-tolerant multipleOf) + docs → fixes [x] (give-up keeps last tile path, re-peek after arrive, exact half-step refine, door-frame corners square) → v0.9.0

## M16: Light, time and harmonious rooms → v0.10.0 [in progress]

Plan: `~/.claude-sessions/profiles/ilomon/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md` (sections 15.1–15.4 of the
2026-10-01 plan, renumbered M16), plus the M15 W4 carry-over (per-kind collision insets, denser recipe pitches, painter audit for
fractional sizes). Designs: `docs/design/lighting.md`, `docs/design/furnishing.md`.

- [x] W0 designs (lighting + furnishing) + threat check + contract (server clock in snapshot, `office.lighting.*`, `facing`/`slotId` on furniture and pins) [Architect]
- [~] Host-clock sun cycle (server time + tz, dawn/dusk ramps, fixed/accelerated modes, HUD slider)
- [ ] Lightmap with wall occlusion (visibility polygons), room-filling lights, window sun shafts, furniture + character shadows
- [~] Furniture harmony: functional groups, wall/corner/centre affinity, facing, clearance, candidate scoring; collision insets per kind (M15 W4)
- [ ] Furniture editor: no duplicate on drag (slot consumption), stable decor, displaced items move, labels/icons, rotate/delete/palette
- [ ] Gate → v0.10.0

## M17: Deep 3/4 RPG renderer (2.5D) → v1.0.0 [todo]

- [ ] ADR + spike: y-sorted furniture sprites (walk behind), height map → shadows, see-through walls
- [ ] 4-direction characters, follow camera, optional perspective shader, editor preview on the sprite path
- [ ] Gate → v1.0.0

## Backlog

- [ ] Flaky under the full turbo run only: one `apps/web/src/lib/socket.test.ts` case timed out once at 11.7 s (passes alone and in 2 full web reruns); find the real-timer case and make it deterministic
- [ ] Flaky under load (full turbo run): server `runs.lifecycle.test.ts` "L7: when run:start is rejected…"; supervisor `service.test.ts` timing cases ("SIGTERM first… tree kill"); server `heroes.test.ts` "takes over a long-idle live subagent's hero…" failed once in the full turbo run (passes alone); procgen bsp 128x96 300-seed cases time out at 60 s when headless Chrome is left running
- [ ] Desktop CI: a tag push starts two `desktop` runs; one Windows run failed only in `smoke-desktop` temp-dir cleanup (EPERM on the Temp dir after all checks passed, v0.7.0). Make cleanup retry/ignore EPERM and dedupe the trigger
- [ ] M14 follow-ups: a free-standing infirmary coffee machine is still painted with the 6 px north-wall overdraw; layouts with no lounge/entrance (or no free slot) get no infirmary; remove the deprecated `baseUpdatedAt` skills field after one release; BattleScene.leave() during entry may flash the half-built stage
- [ ] M15 follow-ups: phone first framing after a floor switch is off-centre until Fit (unclassified, may predate M15); guild dual-grid render perf has little headroom under load (315 ms vs 400 ms cap); live harness for the cat half-gap and NPC chase (unit-tested only); Multiverse realm-border cells take one realm's outline palette
- [ ] Name plates of characters standing on the same tile (e.g. at a realm gate) overlap; plates are obstacles for bubbles but not for each other
- [ ] Sprite pack / Tiled map support (optional; the procedural guild skin comes first)

## Releases

- [x] v0.1.0: first public release on GitHub (MIT), lockstep SemVer, `pnpm release`, CHANGELOG
- [x] v0.2.0: Magic Guild Hall (M6 + M7)
