# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with one version shared by every package in the monorepo.
Cut a release with `pnpm release <patch|minor|major>` (see [CONTRIBUTING.md](CONTRIBUTING.md#versioning)).

## [Unreleased]

### Added
- **Quest board, web side** (M8 8k, W2): a "Quests" top bar tab shows a runner status banner
  (disabled/offline/capability-missing/connected guidance), a per-floor quest list (status, model, mode, started,
  duration, usage/cost), a "New quest" form (floor picker disabling projects outside `runner.allowedProjectDirs`
  with an explanation, a prompt counter capped to `runner.maxPromptChars`, a mode picker narrowed by the connected
  runner's cap and containment — auto/bypassPermissions disabled without a systemd scope — and an optional hero
  target), and a run detail pane with a live sanitized-markdown transcript, Stop, Follow up (resume) and Focus, plus
  human guidance for every rejection reason (`dir_not_allowed`, `dir_not_trusted`, `mode_not_allowed`,
  `tool_not_allowed`, `isolation_unavailable`, `resume_not_allowed`, `capability_missing`, `runner_disabled`,
  `output_cap`, `invalid_command`). New `stores/runsStore.ts`, `features/quests/*`, and `lib/markdown.ts` — a safe
  markdown-to-React renderer (no `dangerouslySetInnerHTML`, `http(s)`-only links with `rel="noopener noreferrer"`,
  images dropped). A simulated quest plays out at `/?demo=1`.
- **Receptionist help desk, web side** (M8 8l, W3): a "Receptionist" top bar button (admin-gated, pairing prompt
  otherwise) opens a chat panel with a conversation list, a General/"This project" scope picker (project options
  outside `runner.allowedProjectDirs` disabled with an explanation), streaming assistant replies with tools-used
  chips, a Stop button, a "can read, never change anything" badge, and graceful disabled/runner-offline states. A
  canned conversation shows at `/?demo=1`. New `stores/receptionistStore.ts`, `features/receptionist/*`, and a
  self-contained `game/npc/receptionist.ts` NPC helper (not yet wired into the office scene).
- **Receptionist help desk, server side** (M8 8l, S3): conversations and messages for the read-only NPC at the Guild
  Gate — `modules/receptionist` (new `receptionist_conversations`/`receptionist_messages` tables, migration slot 7),
  `/api/receptionist/conversations*` REST and `receptionist:*` socket events, both always `admin`-gated. Every turn is
  dispatched through the `RunDispatcher` port (kind `'receptionist'`); project scope is only ever allowed for a
  registered project whose `cwd` is inside `settings.runner.allowedProjectDirs` (a realpath-free, normalized-path
  prefix check, re-checked at both create and send time — the runner still re-validates with `realpath`). Streamed
  `run:event`s are projected onto a bounded conversation history (`receptionist.maxConversations`/
  `maxMessagesPerConversation`, oldest evicted/pruned first), one turn in flight per conversation, and the runner's
  `init` session id is stored per conversation for `--resume`. Redaction is inherited from the already-redacted
  `run.event`/`run.upserted` bus payloads plus a local pass over the user's own message text.
- **Attribution import/export, server side** (M8 8j, S4): `POST /api/attribution/import` (hook-token authenticated
  like `/api/hooks`, but an empty `server.hookToken` now refuses rather than opens the endpoint) resolves the
  project from the `x-tagconn-session-id` header's SESSION only, never from the posted profile, and only within
  `attribution.importWindowSec` of that session's `SessionStart`. The profile is size-capped
  (`attribution.maxProfileBytes`), schema- and redaction-checked, and geometry-validated with `validateLayout`; a
  rejected/invalid profile never logs or echoes the raw body or zod details (only a reason code and sizes). Per
  `attribution.autoImport`: `'ask'` (default) stores it pending and emits `attribution:pending` to admins (with the
  repo path and roles that would be dropped); `'auto'` applies immediately if the project has no layout/heroes yet;
  `'off'` ignores it. Applying creates a brand-new `imported-<slug>` layout (never overwrites one) and heroes only
  for roles that already exist on this host — never creating or changing roles, skills, agents or settings. New
  `GET /api/attribution/pending` / `POST /api/attribution/resolve` (both `admin`), and the public
  `GET /api/attribution/export?cwd=` used by the `/tagconn-save` skill. New `modules/attribution` (`attribution_imports`
  table, migration slot 9).
- **"Save profile to project"** (M8 8k/8l, §6.4): `attribution:save` / `POST /api/attribution/save` (both `admin`)
  build a floor's portable profile and forward it as `attribution:write` to the verified host runner — the only
  thing that ever touches the repo, and only inside `runner.allowedProjectDirs`, never overwriting
  `.tagconn/office.json` without a second, explicit `overwrite: true`. Settings → Attribution gets a "Save profile to
  project" button per floor with a confirm dialog (target path, floor/layout/hero summary, no secrets or absolute
  paths) and an overwrite confirm when the file already exists. New `runsService.sendAttributionWrite`.
- **Hall Planner: furnishing, doors and reachability** (M8 8n, E1): per-room "Furnishing" controls (density, a
  seat/desk/rack/bench count with a size-adapting label, decoration amount, aisle width, "Re-roll arrangement",
  "Reset to defaults") plus layout-wide "Furnishing defaults", all live-previewed and undoable. A "Doors" tool
  adds (click a wall, Shift-click for width 2), moves (drag), resizes (drag its end handles, width 1-3) and
  deletes doors, is keyboard-accessible (arrows nudge, Delete removes), and materializes a room's automatic
  doors into an explicit list on first edit; an "Auto doors" toggle and a confirmed "Seal room" round out the
  Inspector. The issue list now shows the generator's reachability report — each unreachable room with its
  reason and a one-click "Fix: add door on \<side\>" — and the plan highlights unreachable rooms with red
  hatching; saving is blocked while a room is genuinely unreachable, with a confirmation for a deliberately
  sealed one.
- **Runner/attribution infra** (M8 8j/8k, I1): the hook exits immediately for Receptionist runs and adds an
  `x-tagconn-run-id` correlation hint; on `SessionStart` it can (opt-in) write a `.tagconn/README.md` into a git repo and
  import `.tagconn/office.json` in the background, both strictly guarded (no `$HOME`/root, no symlinks, no overwrite,
  size-capped). `pnpm office:install` now asks before enabling those README writes (`--attribution yes|no`), writes a
  runner token + `runner.json` (`--allow-dir`, with a loud warning on broad parent dirs), and sets `OFFICE_RUNNER__TOKEN`;
  `pnpm office:doctor` reports the runner config, CLI capabilities, pairing status and the `:4318` squatter check; new
  `pnpm office:pair` mints a browser pairing code via mutual HMAC (the runner token is never sent raw). New
  `pnpm office:runner` script and the `/tagconn-save` skill.
- **Runner server integration** (M8 8k, S2): the `/runner` socket.io namespace with the mutual HMAC challenge-response
  handshake (`runner:challenge`/`runner:prove`/`runner:hello`; an empty `settings.runner.token` refuses every runner
  connection, and nothing but the handshake is processed before it is verified). Runs (quests and, via the new
  `RunDispatcher` port, Receptionist turns) are queued FIFO (`runner.maxQueued`), dispatched up to
  `min(runner.maxConcurrent, runner-local maxConcurrent)`, and reconciled against the runner's reported active runs on
  every `runner:hello` and after a `runner.lostGraceSec` disconnect grace period. `run:event`/`run:end` are accepted
  only from the runnerId a run was dispatched to, deduped by `(runId, seq)`, capped by `runner.maxEventsPerRun`/
  `maxEventBytesPerRun`/`previewChars`, and redacted with the same patterns as hook ingest (moved to `core/redact/`,
  reused — not duplicated — by `modules/ingest`). A bare `WebFetch` allow rule is rejected server-side even if it
  somehow bypassed the settings schema. New `runs`/`run_events` tables, `/api/runs*` + `/api/runner/status` REST
  (`admin`), and `runs:*`/`runner:getStatus` socket events, broadcasting `run:upsert`/`run:event`/`runner:status` to
  the admin room only. The `runLinker` port (`x-tagconn-run-id` hint, non-authoritative; `init` always wins) is ready
  for the ingest/sessions linking task.
- **Hero editor** (M8 8i, web UI): a "Heroes" panel (TopBar button, `H` hotkey, and "Edit hero" from the agent drawer) lists a floor's named heroes grouped by role with their quest/resting/away status, and edits name, title, skin, hair style/colour, outfit colour, hat, prop and accessory (auto/none options) with a live two-style preview, Randomize, Reset, Save (`Ctrl/Cmd+S`, with a "changed elsewhere" reload/overwrite dialog), Recruit within the configured caps, and Delete (disabled while on a quest). A "Name pools" tab edits `heroes.namePools` per role; Settings links to it instead of the generic per-key form. Works in both live and demo mode.
- Selection glow: the character whose drawer is open pulses a glow in its role color (WebGL `preFX.addGlow` on the shadow, with a soft ring + outline fallback on the canvas renderer), plus a subtle hover highlight; the rest of the floor dims via `office.focusDim` (0 disables). Respects reduced motion (no pulse).
- Bubble and name-tag declutter (`game/labels`): a pure, greedy layout engine places speech bubbles above/beside/stacked with short leader lines when displaced, so they never overlap; priority order is selected > waiting-for-you/blocked > most recent > others, capped at `office.maxBubbles` (extra bubbles collapse to a small "…" badge that expands on hover). Below `office.labelMinZoom`, name tags and bubbles hide except for the selected/waiting/hovered characters, and labels counter-scale so they stay readable when zoomed out.
- New settings: `office.focusDim`, `office.maxBubbles`, `office.labelMinZoom`.
- **Named heroes** (M8 8i, server-side): agents are bound to persistent named characters per (project, role, slot) — `heroes` DB table, `/api/heroes` REST and `heroes:*` socket CRUD, broadcast `hero:upsert`/`hero:remove` events, and `OfficeSnapshot.heroes`. A subagent gets a themed name and appearance on its first live event and keeps it across restarts; the next subagent of the same role reuses a released hero, or takes over a long-idle live one past `heroes.reuseIdleAfterSec`; main agents bind to pm slot 0 (the future Guild Master). New settings: `heroes.enabled`, `heroes.maxPerRole`, `heroes.maxPerProject`, `heroes.reuseIdleAfterSec`, `heroes.namePools`, `office.pmMode`, `office.pmSwitchCooldownSec`, `office.idleLeaveSec`, `office.multiverseMaxRealms`, `office.multiverseMaxCharacters`. The layout id `multiverse` is now reserved for the web-generated Multiverse floor.
- **Living Office scene** (M8 8b/8c/8h/8i, web scene): actors are now keyed by a stable hero/agent/Guild-Master identity instead of the raw agent id — a subagent that reuses a released hero walks in from the tavern with **no new sprite**; an idle hero rests at a lounge seat (dimmed, "Resting · Name") and walks out after `office.idleLeaveSec` (0 = at once), and a rebind (or the hero coming back before then) cancels the walk-out and turns it around instead. `office.pmMode: 'single'` draws one Guild Master per floor with a "+N" session chip (clicking it opens the popover; `office.pmMode: 'per-session'` still draws one actor per session). A bound hero's skin, hair, outfit, hat, prop and accessory now render on the sprite (`resolveHeroCostume`), and switching visual style never moves anyone. On the Multiverse, each realm is painted in its own project's style (the rest in "rift"), seats and lounges are scoped to a realm so characters never wander into another project's rooms, each realm has a clickable travel zone, and `office.multiverseMaxCharacters` is split fairly across realms (Guild Masters first).
- **The Multiverse floor** (M8 8h, web bridge): "All floors" is now "The Multiverse" (an "∞" icon), reachable via the stairs from the top floor (PageUp goes up to it, PageDown/its own down stairs return to the top floor; `End` still goes to the top *project* floor) and listed first in "Manage floors". The floor is generated live from `planMultiverse`, fed by a new `lastLiveAt`-per-project hysteresis in `officeStore` so a project's realm doesn't flicker out the instant its last agent goes idle. A Guild Master's session-count chip opens a popover listing that floor's live sessions (short id, last prompt, status, age) with "Pin as Guild Master" (`officeStore.pinnedPrimary`, cleared automatically once that session ends), and clicking a Multiverse realm travels there with the usual stairs transition. The roster now marks idle/unbound/chip-collapsed/over-cap agents as "off canvas" (via `game/cast.ts`'s `resolveCast`), with a "Show off-canvas" toggle.

### Security
- **Admin auth** (M8 8m): every `/api/*` route now declares a fail-closed access level (`public`, `admin-write`,
  `admin`, `hook`, `runner`) and the server refuses to boot if one is missing; every socket event on `/office` is
  gated the same way (`socket.use`, re-checked per packet), with a 60s sweep evicting expired/revoked sockets from
  the admin room. Default mode `pairing`: a 12-character one-time code (printed at boot, or minted via a mutual-HMAC
  `pnpm office:pair` challenge/response that never sends `runner.token` over the wire) redeems for an admin session
  token (`tca_...`, stored only as sha256, sliding idle expiry capped by a max age, `auth.maxSessions`). An opt-in
  `same-origin` mode adds `POST /api/auth/bootstrap`, refused without a present allowed `Origin`, on `cross-site`, or
  when `corsOrigins` includes `'*'`. `GET /api/auth/status`, `/api/auth/sessions` (list/revoke) and `/api/auth/logout`
  round out the REST surface; `auth:status`/`auth:sessions`/`auth:revoke` mirror it over the socket. `/api/auth/*`
  responses are always `Cache-Control: no-store`, and `settings.runner.token` is now masked like `server.hookToken`.
  New settings: `auth.mode`, `auth.protect`, `auth.sessionIdleHours`, `auth.sessionMaxAgeDays`,
  `auth.pairingCodeTtlSec`, `auth.maxSessions`, `auth.logPairingCodeOnBoot` (all GUI-immutable). `GET /api/health` adds
  a per-boot `instanceId` used by the pairing squatter check.
- **Admin auth client** (M8 8m, W1): the web app now speaks the auth protocol above — a top-bar badge (locked/admin),
  a pairing dialog with the "an admin session = code execution as the host user" warning (auto-opened and prefilled by
  a `#pair=<code>` link, which is stripped from history immediately), a sessions panel (revoke one or all), and log
  out. The token lives in sessionStorage by default, only promoted to localStorage behind an explicit "Remember on
  this device" choice, and is attached to every REST call and the socket handshake automatically. A 401, a revoked/
  expired `auth:changed` push, or a gated socket event that never acks (fail-closed — timeout means "not authorized")
  all drop the badge to locked and show a "Pair this browser to make changes" toast instead of failing silently; a new
  `useRequireAdmin()` hook lets other write UIs gate themselves the same way. Demo mode is unaffected (no server to
  pair with).
- **WebGL shaders / post-processing** (M8 8o, `game/postfx`): the office camera now runs a small
  per-style color grade (warm cozy modern, candlelit amber guild, cool teal/violet rift), a vignette,
  and optional CRT scanlines (modern only), plus a bloom light layer — soft additive glow sprites at
  every torch/lantern/lamp/console position (one shared generated texture, tinted per light, batched
  in a single draw call), blurred only on that layer so the pixel art itself never blurs. All of it
  hot-applies from `office.shaders` with no scene rebuild (style switches re-grade instantly), `quality:
  'auto'` measures frame time for ~2s and drops to a lighter tier (no blur pass, fewer lights, capped
  at 48) if the frame budget is blown, and a canvas renderer or any pipeline failure silently falls
  back to plain rendering (logged once). New `apps/web/src/game/postfx/*`.
- **Settings and attribution UI, dev CSP** (M8 8j/8m/8o, W4): Settings now has full `runner`/`receptionist`/`auth`/
  `attribution` sections — every GUI-immutable key (all of `runner` and `auth`, plus the receptionist safety keys)
  renders read-only with the exact `OFFICE_<SECTION>__<KEY_SNAKE>` env var to set instead, secrets stay masked, and
  Runner carries a standing "An admin session can run Claude on this machine" notice. A new Settings → Attribution
  list and a floating toast (`attribution:pending`) show "Found a tagconn profile in \<path\>" with what would be
  imported (floor, layout, hero count) and which heroes would be skipped (unknown role), gated behind
  `useRequireAdmin()` for Import/Dismiss. `apps/web/vite.config.ts` now sends the same CSP and security headers as
  `docker/nginx.conf` in both `preview` and the dev server, the latter with two documented, dev-only relaxations
  (`script-src`/`style-src 'unsafe-inline'`) for `@vitejs/plugin-react`'s Fast Refresh preamble and Vite's own
  CSS-HMR `<style>` injection — verified against `/?demo=1` with no CSP console errors.
- **SC2 hardening of the runner/auth surface** (`modules/runs`, `modules/auth`, `core/realtime/admin-guard.ts`,
  `core/config`): a runner-namespace packet can no longer crash the server (missing ack / garbage payload / a
  throwing handler all just disconnect the offending socket now); the `/office` handshake and the periodic
  ADMIN_ROOM sweep no longer slide a session's idle expiry (only real activity does), so a truly idle admin session
  now actually expires; pairing's rate limits are split per-endpoint and count only failed attempts, so a flood of
  wrong codes/proofs can never lock out a legitimate one; `settings.runner.enabled` (default off) is now enforced
  by both the `/runner` handshake and the run queue (`409 runner_disabled`); quests and the receptionist re-check
  `runner.allowedProjectDirs` server-side before ever queuing, and the fully-built runner command is re-validated
  against its own schema right before dispatch; once a run exceeds its event/byte cap it now drops everything
  further instead of growing past the limit, sends exactly one stop (`output_cap`, added to `RunStopCommand`'s
  reasons), and its byte counter survives a server restart; a follow-up may only resume a session id its own `init`
  event actually reported and re-checks the permission mode against current settings; the hook's run-id hint
  validates the session id shape; a rejected/timed-out dispatch now asks the runner to stop that run instead of
  leaving it possibly orphaned; concurrent unverified `/runner` sockets are capped; and a malformed `runner.token`
  now fails loudly at boot instead of surfacing later as an opaque handshake error.

### Fixed
- A subagent whose `SubagentStop` was lost or killed no longer lingers on the floor forever: past `agents.staleAfterSec` (default 900s) with no events it's marked done and removed via the usual `doneLingerSec` linger; a later event for the same `agent_id` brings it back. A session's main agent (PM) that's gone idle with no other live agent in its session leaves the floor after `sessions.pmIdleLeaveSec` (default 600s) and reappears on the session's next event. A session ended by the inactivity sweep (crashed/killed CLI, no `SessionEnd` hook) now finishes its still-live agents too, so its PM doesn't linger past `sessions.endAfterSec` either. Both rules also run once immediately on server start, cleaning up rows left over from before a restart.

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

[Unreleased]: https://github.com/ilomon10/tagconn/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ilomon10/tagconn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ilomon10/tagconn/releases/tag/v0.1.0
