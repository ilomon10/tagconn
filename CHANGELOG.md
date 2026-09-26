# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with one version shared by every package in the monorepo.
Cut a release with `pnpm release <patch|minor|major>` (see [CONTRIBUTING.md](CONTRIBUTING.md#versioning)).

## [Unreleased]

## [0.3.0] - 2026-09-26

### Added
- **Quests from the browser** (runner, M5): a new host daemon (`pnpm office:runner`) runs `claude -p` on your machine using your normal CLI login, with no API key. The "Quests" tab starts a quest on a floor. You pick a model, a permission mode and an optional hero, then watch a live transcript and can Stop it or Follow up (resume). Every rejection comes with an explanation. Quests only run inside `runner.allowedProjectDirs` and trusted folders, with an exact tool list. Bash needs an explicit local rule and a systemd scope. User and project settings, MCP servers and slash commands are isolated from each run.
- **Receptionist help desk**: a read-only NPC at the Guild Gate answers questions in a chat panel, in either "General" or "This project" scope. Replies stream in, and it can read but never change anything: it has a read-only tool set and, when available, a bwrap sandbox.
- **Named heroes**: every subagent is bound to a persistent named character per project and role, and keeps the name and look across restarts. A new subagent reuses a resting hero instead of spawning a new sprite. The Heroes panel (`H`) edits the name, title, skin, hair, outfit, hat, prop and accessory with a live preview, and also covers recruiting, deleting and per-role name pools.
- **The Multiverse**: a special floor above the top floor. Each active project appears as a realm painted in its own style, joined by a blended "rift" style. Click a realm to travel to its floor.
- **Living office**: one Guild Master per floor, with a "+N sessions" chip to pick which session it shows. Idle heroes rest in the lounge and then walk out. A selection glow and dimming mark the selected character. Speech bubbles never overlap, and name tags adapt to the zoom level.
- **tagconn attribution**: "Save profile to project" writes the floor's layout and heroes to `.tagconn/office.json` in the repo, through the runner and only inside allowed folders. Opening that repo elsewhere offers to import the profile. The installer can also add a `.tagconn/README.md` (opt-in; the default is off).
- **Richer procedural rooms**: per-room furnishing controls (desk and seat count, density, decorations, aisle width, re-roll). The Doors tool adds, moves, resizes and deletes doors. A reachability verifier offers one-click fixes and blocks saving an unreachable layout.
- **New look**: a 3/4 back wall with windows, fireplaces and appliances. The office and guild styles are refined from style references and drawn entirely in code. WebGL post-processing adds a colour grade per style, a vignette, bloom for torches, lamps and indicator lights, and optional scanlines. It adapts automatically to slower machines and falls back cleanly without WebGL (`office.shaders`).
- New settings sections: `runner`, `receptionist`, `auth`, `attribution`, `heroes` and `office.shaders`, plus `office.pmMode`, `office.idleLeaveSec`, `office.focusDim`, `office.maxBubbles`, `office.labelMinZoom`, `agents.staleAfterSec` and `sessions.pmIdleLeaveSec`.
- New commands: `pnpm office:runner` and `pnpm office:pair`. The `/tagconn-save` skill saves a profile from inside Claude Code, and `pnpm office:doctor` now checks the runner.

### Security
- **Admin auth**: every REST route and socket event now declares an access level, and the server refuses to start if one is missing. Changes require pairing the browser with a one-time code. The code is printed at startup or minted by `pnpm office:pair` through a mutual HMAC exchange that never sends the runner token. Sessions are stored hashed, expire when idle, and can be listed and revoked. Viewing stays public.
- The runner and server authenticate each other with a mutual HMAC handshake, and nothing else is processed before it succeeds. Runner events are accepted only from the runner a run was sent to. They are deduplicated, size-capped and redacted, and a run over its cap is stopped. The runner re-validates every command, and a follow-up can only resume a session that its own run reported.
- Quests can never read or write common credential and startup files (`~/.ssh`, `~/.gitconfig`, shell rc files, systemd user units, npm and PyPI tokens and similar), even through user-level allow rules.
- Runner, auth and receptionist safety settings can only be set in the config file or environment, never through the GUI or API. The runner token is masked like the hook token.
- nginx and the Vite servers send a strict Content-Security-Policy and security headers.

### Fixed
- Stale agents whose stop event was lost now leave the floor after `agents.staleAfterSec`, and an idle PM leaves after `sessions.pmIdleLeaveSec`. A floor no longer shows several PMs for one project.
- The Hall Planner button no longer covers the roster panel.
- With `receptionistSandbox: auto`, the runner no longer wrongly reports bwrap as unavailable on a fresh start, which had left the Receptionist unsandboxed. Cached capability results are re-probed once.
- Docker images pin Node 24.16 to avoid a better-sqlite3 crash on newer Node 24 releases.

## [0.2.0] - 2026-09-25

### Added
- **Magic Guild Hall**: a medieval guild style (`office.style: guild`, now the default) drawn entirely in code, with stone halls, torches, banners, rune circles, cauldrons and portal stairs. Characters wear role costumes (Guild Master, Archmage, Oracle, Artificer, Alchemist, Scribe, Paladin…), carry guild titles, speak in themed bubbles ("Inscribing runes", "Brewing potions") and show spell effects. The modern style is still available.
- **Procedural offices**: every floor is generated deterministically from a layout (rooms = rectangles + room type), producing walls, doors, corridors, furniture, seats and stairs. Open-hall and void (rooms linked by corridors) backgrounds are supported.
- **Hall Planner editor**: draw rooms by dragging, pick room types, move and resize rooms, place stairs, see live validation, and use "Surprise me" random layouts, a live preview in either style, undo/redo and shortcuts. Save, duplicate and assign a layout to a floor, or open it from "Edit floor" in Manage floors.
- **Stairs between floors**: clickable portal stairs with a transition, PageUp/PageDown/Home/End hotkeys, and a "Floor N / M" indicator with up and down buttons in the top bar. The demo showcases three floors.
- **Layouts API**: `/api/layouts` REST and `layouts:*` socket CRUD, a read-only built-in default, project layout assignment, and `baseUpdatedAt` concurrency checks.
- New settings: `office.style`, `office.defaultLayoutId`, `office.floorOrder`, `office.floorTransitionMs`, `office.ambientEffects`, `office.maxStoredLayouts`, `sessions.idleAfterSec`, `sessions.endAfterSec`, and `transcripts.*` limits.
- Token usage in the roster, the agent panel and the top bar; "Manage floors" (rename and archive); guild titles in the roster.
- Tests for the installer and doctor (`pnpm test:scripts`) and a dependency-free release script (`pnpm release`).

### Fixed
- The agent panel no longer blocks the map: the camera respects a safe region, selected characters center in the visible area, an optional follow mode is available, and Esc or a click on empty map closes the panel.
- Camera "Fit" and focus now center correctly at every zoom level, floor transitions no longer creep the zoom in, and transitions can't overlap.
- Floor hotkeys no longer fire while the Hall Planner is open; the ambient effects toggle applies live.
- A token-usage update can no longer bring a removed agent back onto the floor; the floor usage badge no longer adds context sizes across sessions.

### Security
- Transcript reads re-validate the real path under `projectsDir` on every read (no symlinks, FIFOs or TOCTOU window), with caps on line size, file size and the number of tracked files, and with validated session and agent ids.
- Layouts: ids are strictly validated (reserved names rejected, invalid stored rows purged), the number of stored layouts is capped, `defaultLayoutId` must exist, socket arguments are validated without leaking internal errors, and control and bidi characters are stripped from names.
- The web layout store can't be tricked by prototype-named ids, and procedural generation bounds its corridor search so a hostile layout can't stall viewers.

## [0.1.0] - 2026-09-25

First public release: an observer that turns Claude Code sessions into a live 2D office.

### Added
- Claude Code hook observer: a POSIX `sh` + `curl` hook that always exits 0 and prints nothing, with its token kept in `~/.config/tagconn/curl.conf` (0600).
- Fastify server built as modules (config, db, DI, event bus, socket.io core; ingest, projects, sessions, agents, activity, tasks, events, snapshot, settings, roles, health, transcripts) on SQLite through Drizzle.
- Agent state machine: main session as PM, subagents as characters, and correct pairing of parallel subagents of the same type in any event order.
- Task board built from Agent calls, TodoWrite and `handoff` reports.
- Token usage per agent and per session, read from Claude Code transcripts (deduplicated by message id).
- Settings in layers (schema defaults → `config/office.yaml` → `OFFICE_*` env → GUI overrides) that apply live over socket.io.
- Roles editor that syncs to `~/.claude/agents/*.md` and marks the files it manages; six default roles and four workflow skills (`office-kickoff`, `handoff-report`, `definition-of-done`, `task-sizing`).
- React + Phaser web office drawn entirely in code, with zones, pathfinding, speech bubbles, roster, Board, Log, Roles, Settings, a "Manage floors" dialog (rename and archive), token usage display, browser notifications and a `?demo=1` mode.
- Installer and doctor (`pnpm office:install | office:uninstall | office:doctor`) with sandbox support (`--claude-dir`, `--config-dir`).
- Docker compose delivery (ports bound to 127.0.0.1, non-root server, named data volume).
- Test suites: server, web and scripts, including a guard test proving that installer tests never touch real user files.

### Security
- Host and Origin allowlists (against DNS rebinding and cross-site WebSocket hijacking), 127.0.0.1 bind by default, JSON-only bodies, redaction of secrets across the whole hook payload, settings that the GUI cannot change (paths, network, runner permissions), and a masked hook token.

[Unreleased]: https://github.com/ilomon10/tagconn/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ilomon10/tagconn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ilomon10/tagconn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ilomon10/tagconn/releases/tag/v0.1.0
