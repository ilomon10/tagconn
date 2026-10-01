# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with one version shared by every package in the monorepo.
Cut a release with `pnpm release <patch|minor|major>` (see [CONTRIBUTING.md](CONTRIBUTING.md#versioning)).

## [Unreleased]

## [0.7.0] - 2026-10-01

### Added
- **RPG name plates** (v0.7.0): each character displays a multi-line label above their head showing name, role title, and current task. The label is drawn in a hand-made pixel font that stays crisp at any zoom. Configure which lines show and the plate width with `office.labels.*` settings; plates fall back to system text in canvas mode or when glyphs are missing.
- **Office life — meetings and activities** (v0.7.0): when subagents gather during a kickoff, they hold a meeting at a conference table. Every ~30 minutes, idle characters hold stand-ups. Between meetings, characters take breaks roughly every minute: coffee chats, arcade games, ping-pong, foosball, board games, stretches, naps on the sofa, and more. Meetings last ~20 seconds; activities last a few seconds. All controlled by `office.life.*` settings. Reduced motion disables walking and meetings; on low graphics quality, only 1 concurrent activity runs.
- **Lounge furniture** (v0.7.0): new game tables in the lounge — arcade cabinet, ping-pong table, foosball table, board game table — plus refurbished water cooler and sofa. Characters gather at these during idle activities.
- **NPCs and random encounters** (v0.7.0): routine staff (janitor, courier, plant waterer) clock in at regular hours, sweeping and delivering. Random visitors (guests, police, CIA agents, sales dogs, monsters, office cats) show up roughly every 4 minutes. They're styled per theme (modern office workers, guild fantasy, sci-fi rift). Idle characters react — gathering, fleeing, or chasing — controlled by `office.npcs.*` settings. Encounters are disabled on the Multiverse floor; chaos reactions respect low graphics quality.
- **Game-style alerts** (v0.7.0): JRPG alert boxes in the top-right corner (top-center on phones) for key events — when an agent asks for you, a tool fails, or a quest completes. Alerts are rate-limited (4 per minute by default), coalesce when multiple characters need you, and auto-dismiss after 8 seconds (configurable). Click "Show me" to jump to the character. Controlled by `office.alerts.*` settings; browser notifications still work when the tab is hidden.
- **Procedurally generated sound and music** (v0.7.0): WebAudio synthesis creates sound effects and ambient beds in real-time — no asset files. Meeting gongs, NPC sounds (barks, meows, whistles), footsteps, typing, alert jingles, and per-style ambient beds (office hum, crickets, tavern chatter, rift drones). Sound is off by default; each browser can toggle it from the menu (**Sound** row in the **☰ Menu**) and adjust volume independently. Spatial audio: effects play louder near the center of your view. Controlled by `office.sound` (master switch) and `office.audio.*` (mix toggles per browser).

### Changed
- Display page now links to [Name plates](docs/guide/name-plates.md) for label configuration.

## [0.6.0] - 2026-10-01

### Added
- **HUD**: the party bar (bottom, one portrait chip per character in roster order) replaces the docked roster column; on a phone it collapses to a pill. The status card (top-left, shown while a character is selected) shows name, role title, status, **Mana** meter (context window use), **XP** tokens and level, current tool and tool time, quest time, and work strain summary; a **Details** button opens the full agent panel (activity, recent tools, Edit hero) in a focus-trapping dialog; **Follow** checkbox keeps the camera on the character. The card compresses to one row on phones.
- **Office and tavern drama**: roughly every `office.drama.idleChatSec` (45 s), one or two idle characters walk to a piece of furniture (cooler, machine, counter, fireplace, etc.) and perform a short scene — speech bubbles and an emote icon (mug, dice, phone, laugh, etc.). Modern style plays office chat; guild plays tavern tales; antics controlled by `office.drama.enabled` (default `true`).
- **Work strain**: characters on quests show icons and text when under stress: tired (over `tiredAfterSec`, 20 min), dizzy (tool over `dizzyToolSec`, 90 s), sweating (blocked/waiting over `sweatAfterSec`, 2 min), on a roll (`streakTools` calls in `streakWindowSec`). When strain starts, the character speaks a strain line. Strain is controlled by `office.drama.*` settings; with `office.ambientEffects` off, icons are static (no motion/fx); with reduced motion, antics stay in place.
- **Furniture triggers**: click a **Kanban board** (modern) / **War map** (guild) on the map to open the Board, or a **Bookcase** to open the Log, etc. (six furniture kinds per action). Hover shows the label and hotkey. The first time you approach a trigger, it pulses. Disable with `office.furnitureTriggers` in Settings.
- **Hall Planner Furniture tool** (F key): lock generated furniture in place by selecting it (shows kind, position, size) and dragging to pin; or click **Lock in place** in the Inspector. Pinned furniture (marked with a 🔒 padlock) stays when you reroll the seed. Nudge with arrows, Delete to release, or use **Lock all** / **Release all** in the room section. Up to 48 pins per room; each pin must be <= 8×8 tiles.

### Changed
- The roster now floats at the bottom as the **party bar**, no longer docked on the right; on phones and tablets it becomes a tray. The right-hand drawer is replaced by the **Details** button on the status card, which opens a focus-trapping dialog with the full agent panel.

## [0.5.3] - 2026-10-01

### Fixed
- `pnpm office:runner` failed at start with `ERR_MODULE_NOT_FOUND` (`packages/shared/src/hook.js`): it now runs through `tsx`. The runner also logs when it is connected, and says when it is probing a newly updated `claude` CLI (about a minute, once per version).

## [0.5.2] - 2026-10-01

### Changed
- A compact top bar with one **☰ Menu** (M): Board (B), Log (L), Quests (Q), Roles (R), Settings (S), Heroes (H), Hall Planner (P), Receptionist (D), Manage floors (F), screen effect, alerts and help. Board, Log, Quests, Roles and Settings now open as panels over the office instead of replacing it; `#board`-style links still work.
- The web app works on phones and tablets, in portrait and landscape: panels become full-screen or side sheets, the roster becomes a tray, touch targets are larger, and you can pinch to zoom.
- A floor is now the repository: the hook sends the session's git root, and a session stays on the floor it started on. Older floors for subfolders (e.g. `ovor/apps/platform`) merge into their repository's floor once the hook confirms it is a git root, after a database backup (`office.db.pre-merge-*.bak`). Your home folder and the folders directly inside it never absorb other floors, and nested git repos keep their own floor.
- Hero editor: change a hero's role (once it is released), and give it a different title and look per style (Modern, Guild, Rift) on tabs.
- The Receptionist is drawn like every other character and dresses for the floor's style (Receptionist / Gatekeeper).

### Fixed
- Role titles follow your role settings and the floor's style everywhere (roster, drawer, tags, sessions popover); the lead no longer shows as "Guild Master" on Modern floors or on the Multiverse.
- The selected character is easy to find at any zoom: an arrow and a ring that keep their size, and an edge arrow pointing to it when it is off-screen (`office.selectionBeacon`).
- Subagents no longer appear on a separate floor without their lead when the session `cd`s into a subfolder.
- Hero name pools accept spaces and new lines while typing.
- Esc closes the panel on top everywhere (Heroes, Receptionist, Settings after saving), and the Receptionist, Heroes and Hall Planner panels fit on a phone.

### Security
- The hook finds `git` by absolute path and runs it outside the repository with git's environment overrides cleared, accepts a git root only if it contains the project folder, and caches it; hook paths (`cwd` and the root) are validated on the server. A profile found in another folder than the session's floor is never imported automatically.

## [0.5.1] - 2026-09-29

### Fixed
- The first desktop installers: v0.5.0 was tagged, but its CI packaging failed (the Linux package lost its bundled node through a config override, a package check expected the wrong path form, and unpacking node on Windows got an empty path), so v0.5.0 has no GitHub release. v0.5.1 is the first release with tagconn Desktop (preview) installers; everything else is the same as v0.5.0.
- The release script also bumps the desktop app's version files.

## [0.5.0] - 2026-09-29

### Added
- **tagconn Desktop, preview** (Windows and Linux): unsigned installers, in-app updates off until signed releases, and the Windows build is experimental (not yet tested on real hardware). One app with a setup wizard (system check with one-click fixes, runner folders, a consented hook install that shows what changes and where the backup goes) and an XAMPP-style control panel (status lights, Start/Stop/Restart, crash backoff, logs, settings, diagnostics, tray, start with system). Native services by default, Docker optional. Ships as a Windows installer, an AppImage and a .deb; signed in-app updates follow once releases are signed. See `docs/guide/desktop.md`.
- The server can serve the web app itself (`server.webDir`) with the same security headers as nginx, so the desktop app needs no nginx or Docker.
- A cross-platform Node hook (runs without a shell, ~30 ms) alongside the sh hook; `pnpm office:install --hook node`.
- The runner works on Windows, with stricter defaults: no Bash or PowerShell for quests, at most accept-edits, and a read-only Receptionist without a sandbox. Quests are also denied tagconn's own folders, Windows credential stores, browser profiles, other tools' tokens, startup scripts and every PATH folder.
- The web app explains these Windows limits when a quest is refused.

### Changed
- One small `.tagconn/` folder per project: the agents' working notes move from `.office/` to `.tagconn/work/` (git-ignored), and the README is five lines.
- `pnpm office:install`, `office:doctor` and `office:pair` run on a shared setup library (`packages/setup`) with OS-correct paths, locked-down secret files (by SID on Windows), and a `settings.json` merge with a backup and automatic rollback.

### Fixed
- The installer names the line and column of a broken `settings.json`, and refuses before writing anything if a folder isn't writable.

### Security
- Several rounds of review of the desktop work (hook, runner, setup, supervisor, the Tauri shell and the release pipeline). Among the fixes: hook tokens validated and `hook.json` trusted only when owned by you; Windows helpers run by absolute System32 path; the pairing code never goes on a command line or into logs; the desktop server ignores stray `.env`/`office.yaml` files; releases are built from the tag, signed in an isolated job and published as drafts; shipped dependencies match the lockfile; the bundled node is checksum-pinned.

## [0.4.1] - 2026-09-26

### Added
- The Quests tab and the Receptionist now say exactly what to do next: "Pair this browser", the `pnpm office:runner` command with a Copy button when the runner is offline, the setting to change when it's disabled, and Retry when a load fails.
- "Raise the limit" on the "+N more not shown" banner opens Settings → Office, and a "Connecting to the office…" message replaces the blank canvas while the page connects.
- `pnpm test:perf` runs the wall-clock timing tests separately, so `pnpm test` no longer flakes on a busy machine.

### Changed
- better-sqlite3 13 (N-API rewrite); Docker images move from the Node 24.16 pin to Node 24.21.0 after a crash-free soak test.
- Quests no longer request `TodoWrite` (the CLI ignored it).

### Fixed
- With reduced motion on, following a character no longer glides the camera.
- A failed quest transcript load now shows an error with Retry instead of "No events yet".
- nginx sent two conflicting `Cache-Control` headers for built assets.
- Demo mode can start a quest again (the demo runner's allowed folders didn't match the demo floors).
- A paired browser no longer flashes "Pair this browser" in Quests or the Receptionist while its status loads, and a late error from a previously selected quest no longer shows under the current one.

## [0.4.0] - 2026-09-26

### Added
- **Screen effects**: a top-bar **Screen** button (hotkey `V`) puts a CRT, LCD or VHS monitor look over the office. The choice is saved per browser (no pairing needed); `office.shaders.screen` / `screenStrength` set the default for everyone.
- **Edge vignette in pixel style**: the vignette now darkens only a thin frame along the screen edges (`vignetteSize`, default 12% of the shorter side), drawn as 4 hard pixel-art bands (25/50/75/100%). `vignetteStyle: smooth` gives a soft fade instead; `vignetteSteps` and `vignettePixel` tune the bands.
- **User guide** in `docs/guide/`: getting started, pairing your browser, runner and quests, the Receptionist, the office, attribution, display, configuration and troubleshooting.

- **Keyboard and accessibility pass**: `[` / `]` step through the characters on a floor (with a screen-reader announcement), `?` opens a list of every shortcut, dialogs keep and return keyboard focus and close with Esc, click areas stay at least 24px when zoomed out, and reduced motion now also stops the leave fade and pulsing dots.

### Fixed
- Low-contrast grey captions in the top bar and roster, and the red "needs you" badge, now meet WCAG AA.
- Saving in a browser that isn't paired now asks you to pair straight away (and opens the pairing dialog) instead of failing after 10 seconds with "Timed out waiting for settings:update".
- The hover tooltip ("Travel to …", stairs) now sits right next to the cursor at every zoom level, and no longer stays on screen after you travel.
- `pnpm office:pair` explains what to do when the server has no runner token yet (run `pnpm office:install`, then `pnpm office:up`).
- The web build no longer triggers a Content-Security-Policy "eval" warning in the console (a Phaser helper used `new Function`).
- The vignette no longer darkens most of the screen.

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

[Unreleased]: https://github.com/ilomon10/tagconn/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/ilomon10/tagconn/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/ilomon10/tagconn/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/ilomon10/tagconn/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/ilomon10/tagconn/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/ilomon10/tagconn/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ilomon10/tagconn/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/ilomon10/tagconn/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ilomon10/tagconn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ilomon10/tagconn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ilomon10/tagconn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ilomon10/tagconn/releases/tag/v0.1.0
