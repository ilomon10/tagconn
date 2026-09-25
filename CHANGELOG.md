# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with one version shared by every package in the monorepo.
Cut a release with `pnpm release <patch|minor|major>` (see [CONTRIBUTING.md](CONTRIBUTING.md#versioning)).

## [Unreleased]

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

[Unreleased]: https://github.com/ilomon10/tagconn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ilomon10/tagconn/releases/tag/v0.1.0
