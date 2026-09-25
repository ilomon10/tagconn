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

## M6: Wave 2 (session 2)  [PM]
- [x] Contract: `TokenUsage` on Agent/Session, `sessions.{idleAfterSec,endAfterSec}`, `transcripts.{enabled,debounceMs}`, `WHOLESALE_REPLACE_SETTINGS` in shared
- [x] Server: transcripts module (token usage per agent/session, deduped, path-contained to projectsDir) + session settings; 71 server tests  [Developer: server]
- [x] Web: token usage in roster/drawer/top bar, "Manage floors" (rename/archive), demo usage; 41 web tests  [Developer: web]
- [x] Tests: 57 tests for `scripts/install.ts` + `doctor.ts` (unit + sandboxed integration + real-paths guard), `pnpm test:scripts`  [Developer: infra]
- [x] Security review of wave 2: 3 Med (symlink/TOCTOU escape, unbounded line buffer, unbounded tracked files), 5 Low; release.ts + install.ts clean
- [x] Code review of wave 2: 1 High (usage update could resurrect a removed agent), 3 Low
- [x] Fix pass: transcripts hardening (fd-based open, O_NOFOLLOW, per-read containment, caps, LRU, id validation, TextDecoder) + web floor-usage fix; 99 server tests

## Bugs / UX
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
- [~] 7f. Review + security + QA of M7 → fixes → docker rebuild → release v0.2.0
  - [x] Security: 0 Critical/High; 2 Med (layout ids that break the id rule are stored but can't be listed or deleted; no cap on stored layouts and a snapshot carries them all), 4 Low (defaultLayoutId "constructor" breaks the view, A* node limit, lost updates, socket arg validation)
  - [x] Code review: 1 High (floor hotkeys fire under the open editor), 1 Med (camera zoom compounds on each floor change), 1 Low (transition re-entrancy)
  - [x] QA: 7/9 pass, 0 console errors; bugs: ambientEffects toggle not live (Med), camera fit/focus centering wrong esp. zoomed in (Med/High), roster titles not themed (Low)
  - [x] Server security fixes (layout id validation + purge, maxStoredLayouts 200, defaultLayoutId existence, baseUpdatedAt 409, socket arg validation, name sanitizing); 109 server tests
  - [~] Web fixes A (camera fit/focus math, zoom drift, transition lock, hotkeys under editor, live ambient toggle, animated TopBar floor jump)
  - [~] Web fixes B (client layout hardening, editor baseUpdatedAt/409 dialogs, Edit floor entry, themed roster titles, procgen A* limits)
- [~] 7g. Follow-ups: animated TopBar floor jump (fixes A), "Edit floor" entry in Manage floors (fixes B)

## M8: Living Office UX + Multiverse + Heroes + Attribution (next, after v0.2.0 ships) → v0.3.0  [PM plan]
User request: no stale characters, one clear PM per floor, reuse idle characters, glow on the selected character, bubbles that never overlap, and UX best practice for showing characters and the office.
Diagnosis (live data, 2026-09-25): subagents whose SubagentStop never arrived (killed or lost background agents) stay "active/idle" in the lounge forever
(the sweeper only moves them to the lounge); each Claude session has its own PM, and idle or abandoned sessions only end after `sessions.endAfterSec` (30 min),
so parallel or old sessions leave extra PMs on a floor.
- [ ] 8a. Server lifecycle: `agents.staleAfterSec` (default 900). A subagent with no events past it is marked `done` (reason `stale`) and leaves the floor; it comes back if a later event arrives. The main agent of an idle session leaves the floor after `sessions.pmIdleLeaveSec`. Recovery at restart; tests with a replay of lost SubagentStop.  [Developer: server]
- [ ] 8b. One PM per floor: the floor's "Guild Master" is the main agent of the most recently active session; other live sessions show as smaller "Deputy" characters with a session badge (or collapse into a count chip). Configurable `office.pmMode: single | per-session`.  [Architect → Developer: web]
- [ ] 8c. Character pool / reuse: when a subagent spawns and an idle character of the same role is on the floor, that character takes the new quest (walks from the tavern to the new zone) instead of a new sprite spawning; idle characters leave (walk out) after `office.idleLeaveSec`. Presentation-only mapping of agent → actor in the web.  [Developer: web]
- [ ] 8d. Selection glow: WebGL preFX glow (Phaser 3.60+ `preFX.addGlow`) in the role color with a pulse, plus a canvas fallback ring; the other characters dim slightly in focus mode.  [Developer: web]
- [ ] 8e. Bubble and label declutter: collision-free bubble layout (greedy placement with stacking and leader lines), priority for the selected/newest/waiting characters, max visible bubbles, fade after `bubbleSeconds`; zoom-based level of detail (names and bubbles hidden when zoomed out, shown on hover); hover card; "waiting for you" gets a persistent badge.  [Developer: web]
- [ ] 8f. UX review pass: a best-practice checklist (focus + context, level of detail, affordances, motion guidelines, accessibility: reduced motion, contrast, keyboard navigation of characters), optional minimap.  [Analyst/Architect → Developer]
- [ ] 8h. **Multiverse floor** (replaces "All floors"): a special floor showing every project's characters together. Its layout is generated each time from the live projects (a central Nexus with one realm per project, joined by rift corridors), and the special "rift" style blends each project's own style per realm with a starfield/void between them. Reachable by the stairs (top floor) and from the floor picker.  [Architect → Developer: web + server contract]
- [ ] 8i. **Named, customizable heroes**: persistent characters per project and role (name, look: skin, hair, outfit color, hat/costume variant, pronoun-free title). Subagents are assigned to heroes (this ties in with 8c's reuse). Name pools per role you can edit, and a hero editor in the GUI; stored on the server (`heroes` module).  [Architect → Developer: server + web]
- [ ] 8j. **tagconn attribution in projects**: projects that used tagconn get a small `.tagconn/` marker (a README with the setup link and version, plus an optional `office.json` profile holding the floor name, layout and heroes), so the setup can be restored on another host. A SessionStart hook import of an existing profile, a GUI or skill "save profile to project", opt-in and on by default, never overwrites, no secrets. Security review required (writes into user repos).  [Architect → Developer: infra + server]
- [ ] 8k. **Orchestrator runner (M5, pulled into v0.3.0)**: `apps/runner`, a host daemon (not in Docker; it needs your CLI login and project dirs). It connects out to the server over socket.io with its own runner token and spawns `claude -p "<task>" --output-format stream-json --verbose` (plus `--resume` for follow-ups) using your subscription login, with no API key. Browser: assign a task to a floor or character, watch the streamed progress live on the characters, send follow-ups, stop a run. Guardrails: `runner.allowedProjectDirs` allowlist, `runner.permissionMode` and `runner.maxConcurrent` (settable from file or env only, never the GUI), and a visible quota/usage note.  [Architect → Developer: runner + server + web]
- [ ] 8l. **Receptionist (help desk)**: an independent read-only assistant you chat with in the browser. It's a character at the Guild Gate. It runs through the runner with `--permission-mode plan`, a read-only tool allowlist (Read, Grep, Glob, WebSearch, WebFetch) and an explicit disallow list for Edit, Write, Bash and NotebookEdit, and it can never change a project. It can answer questions about any floor/project (read-only) or about tagconn itself. It streams answers into a chat panel, keeps conversation history and resumes the session.  [Architect → Developer: web + runner]
- [ ] 8m. **GUI admin auth for code execution** (decision 12 revisited): because the browser can now start Claude runs, run and receptionist actions need an admin session. It is a same-origin bootstrap token issued to the local UI, sent in the socket handshake and on REST writes, separate from the hook and runner tokens. There are regression tests for cross-origin, CSRF and rebinding attempts against the run endpoints.  [Architect + Security → Developer: server + web]
- [ ] 8g. Review + security + QA → v0.3.0

## Backlog
- [ ] Sprite pack / Tiled map support (optional; the procedural guild skin comes first)

## M5 (v2): Orchestrator runner → moved into M8 (8k, 8l, 8m) for v0.3.0
