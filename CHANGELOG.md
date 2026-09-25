# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with one version shared by every package in the monorepo.
Cut a release with `pnpm release <patch|minor|major>` (see [CONTRIBUTING.md](CONTRIBUTING.md#versioning)).

## [Unreleased]

### Added
- Design spec and contract for the "Magic Guild Hall": medieval guild style, office editor with procedural generation, stairs between floors (work in progress).
- Server `layouts` module (M7 7b): CRUD for office layouts over REST (`/api/layouts`) and socket (`layouts:list|get|save|delete|assign`), a seeded read-only default layout, `PATCH /api/projects/:id { layoutId }` to assign or clear a floor's layout, deleting a layout clears it from the projects that used it, and the snapshot now carries `layouts`.

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
