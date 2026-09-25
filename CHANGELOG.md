# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with one version shared by every package in the monorepo.
Cut a release with `pnpm release <patch|minor|major>` (see [CONTRIBUTING.md](CONTRIBUTING.md#versioning)).

## [Unreleased]

### Added
- Design spec and contract for the "Magic Guild Hall": medieval guild style, office editor with procedural generation, stairs between floors (work in progress).
- Server `layouts` module (M7 7b): CRUD for office layouts over REST (`/api/layouts`) and socket (`layouts:list|get|save|delete|assign`), a seeded read-only default layout, `PATCH /api/projects/:id { layoutId }` to assign or clear a floor's layout, deleting a layout clears it from the projects that used it, and the snapshot now carries `layouts`.
- Web "Hall Planner" office editor (M7 7e-A, `features/editor/`): draw a room by dragging a rectangle on a zoomable/pannable 2D plan canvas, pick its type from a popover (guild-style names when the style is guild), then select/move/resize (8 handles)/delete/duplicate rooms and stairs landings; live `validateLayout` + generator issues listed and highlighted on the canvas and flash-selectable; "Surprise me" (`generateRandomLayout`) as one undo step; a live styled preview pane (modern/guild) rendering `generateMap` through a small Phaser scene with wandering demo characters; layout name/rename/duplicate/new/delete and "Use on this floor"/"Reset floor" assignment; undo/redo (max 100, drag/resize gestures coalesced to one entry) and full keyboard shortcuts (ignored while typing); read-only builtins with "Duplicate to edit"; works in demo mode via `lib/layoutCommands.ts`. New `stores/{editorStore,layoutStore}.ts`.
- Guild skin goes live in the office scene (M7 7e-B): `OfficeScene` now renders `generateMap(layout)` painted by the current theme (`getTheme`), retypes seats/pathfinding onto the generated grid, and re-skins in place (no reseating) when only the style changes. Characters get guild costumes (hat/cloak/staff/goggles) and themed name-tag titles per role, themed speech bubbles (`themedBubble`), and per-activity particle effects, all gated by `office.ambientEffects` and reduced motion. `game/map/officeMap.ts` and `renderMap.ts` (the pre-M7 fixed office grid) are retired down to the two constants the deprecated `office.zones` editor still needs.
- Stairs and floors (M7 7e-B, `lib/floors.ts`): the stairs room's up/down portals are interactive (hover highlight + tooltip, click to move), with a fade transition (`office.floorTransitionMs`, instant under reduced motion); PageUp/PageDown/Home/End move floors and `F` opens the floor picker (ignored while typing); "All floors" mode opens the picker instead of moving and disables the ends. Characters never change floors — only the view does. The top bar shows "Floor N / M — name" with up/down buttons mirroring the stairs. `?demo=1` now runs a 3-floor demo (the built-in classic hall, a random hall, and a void keep with carved corridors) with the guild skin on by default, showcasing both.
- `transcripts.{maxLineBytes,maxFileBytes,maxTrackedFiles}` settings to bound the wave-2 hardening below.

### Fixed
- Office camera "safe region": the agent status panel no longer traps the map underneath it — dragging, wheel/pinch zoom and selecting a character (sprite or roster row) all account for the panel's occupied edges, so any tile can still be panned into view and the selected character is centered in the unobscured area, with an optional "Follow" toggle, Esc/backdrop-click dismissal, and reduced-motion support.

### Security
- `transcripts` module: transcript reads now re-validate that the file's real, symlink-free path stays under `projectsDir` on *every* read (not just when the path was first registered), closing a TOCTOU window where a tracked path could be swapped for a symlink after tracking started; reads also reject a symlinked leaf outright (`O_NOFOLLOW`) and a FIFO planted at a tracked path (`O_NONBLOCK` + `fstat` instead of stat-then-open). A symlinked `projectsDir` itself now works correctly (both sides are realpath'd).
- `transcripts`: a partial (unterminated) transcript line is now capped at `transcripts.maxLineBytes` instead of buffering forever (memory DoS), and a file stops being read past `transcripts.maxFileBytes`. The number of concurrently tracked transcript files is capped at `transcripts.maxTrackedFiles` with LRU eviction, and tracking now requires a live agent/session row and the file to already exist. `session_id`/`agent_id` are validated against a strict id shape before any path is built from them, and tracked files are keyed by `sessionId:agentId` with a same-session check before applying usage, so one session's hook can no longer overwrite another session's agent usage (or a removed agent's).

### Fixed
- `transcripts`: `applyAgentUsage` no longer emits `agent:upsert` (or re-tracks a file) for an agent that's already off the floor (`removed`); a multi-byte UTF-8 character split across two transcript reads now decodes correctly via a per-file streaming decoder instead of occasionally producing a replacement character; numeric usage counts are clamped and `model` is sanitized/truncated.
- Web: the floor-usage badge no longer sums `contextTokens` across independent sessions (which was a meaningless number); it now shows the largest single session's context, with a tooltip that says so. `sumUsage` (one session's main + subagents) is unchanged in semantics but now matches the server exactly, taking `contextTokens`/`model` from the main agent only. "Manage floors": pressing Escape in a floor's rename field now blurs it too, instead of leaving it focused with the reverted name.

### Security
- `layouts` module (M7 server-side hardening): `PUT /api/layouts/:id` now validates the URL id against `LAYOUT_ID_RE` (400), and stored rows with an invalid id (unlistable/undeletable otherwise) are purged on boot. `LAYOUT_ID_RE` rejects the reserved names `__proto__`/`constructor`/`prototype`, so `office.defaultLayoutId` can no longer be set to one, and the server also rejects a `defaultLayoutId` that isn't an existing layout (`SettingsService.addValidator`). New `office.maxStoredLayouts` (default 200) 409s `POST /api/layouts` past the cap; generated ids now use 8 hex characters instead of 4. `OfficeLayoutInputSchema` gained an optional `baseUpdatedAt` for optimistic concurrency: a `PUT` that sets it 409s on a lost update or a deleted-then-resurrected layout (omit it to keep the old create-or-replace behavior). Layout/room names are stripped of control and bidi-override characters. Socket `layouts:get`/`layouts:delete` validate their id with zod before touching the DB, and layouts socket acks no longer forward raw internal error text — only deliberately client-safe messages, everything else logged and reported generically.

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
