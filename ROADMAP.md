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
- [ ] 7e. Office editor UI (draw regions, pick room type, place stairs, validate, preview, save) + stairs interaction + scene integration  [Developer: web]  (after 7c + 7d)
- [ ] 7f. Review + security + QA of M7, docker rebuild

## Backlog
- [ ] Sprite pack / Tiled map support (optional; the procedural guild skin comes first)

## M5 (v2): Orchestrator runner  *(later)*
- [ ] Host runner daemon spawning `claude -p --output-format stream-json`
- [ ] Assign tasks to characters from the GUI
