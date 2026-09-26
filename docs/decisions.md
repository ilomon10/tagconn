# Decisions (lightweight ADR log)

| # | Date | Decision | Why |
|---|------|----------|-----|
| 1 | 2026-09-25 | **Observer first** (hooks → server), orchestrator later | Works with every existing project immediately; no API key; the visuals can be proven first. |
| 2 | 2026-09-25 | **No Agent SDK**: v2 runner spawns the `claude -p --output-format stream-json` CLI | The user has only the CLI with a browser (subscription) login and no API key. The Agent SDK needs an API key. |
| 3 | 2026-09-25 | **Fastify** modular monolith (plugins + awilix DI + typed event bus) | User rejected NestJS/Express. Payload CMS is Next.js-based and a poor host for socket.io plus long-lived watchers/processes. |
| 4 | 2026-09-25 | **socket.io** for realtime | User requirement; rooms map neatly to project floors. |
| 5 | 2026-09-25 | **SQLite + Drizzle** (better-sqlite3, WAL) | Zero-setup local file; typed schema; can move to Postgres later by swapping the driver. |
| 6 | 2026-09-25 | **Docker compose** delivery, ports on 127.0.0.1 | User choice. Hooks run on the host and reach the published port; `~/.claude/agents` is bind-mounted for role sync; the container runs as the host UID. |
| 7 | 2026-09-25 | Hook = **sh + curl**, always exit 0, no stdout, 1s timeout | Hosts may not have Node on PATH; the hook must never slow down or break Claude Code. |
| 8 | 2026-09-25 | Roles edited in the GUI, **synced** to `~/.claude/agents/*.md` with a managed-by marker | One source of truth; never touch user-authored agent files. |
| 9 | 2026-09-25 | React + **Phaser 3**, procedurally generated map/sprites | No asset licensing or download step; swappable for a Tiled map and sprite pack later. |
| 10 | 2026-09-25 | pnpm workspaces + turbo; `packages/shared` is the contract (zod) | Server and web share types and validation; contract-first lets developers work in parallel. |
| 11 | 2026-09-25 | Security hardening after review: Host/Origin allowlists, 127.0.0.1 bind, GUI-immutable path/network/runner settings, masked token, JSON-only, whole-payload redaction | The security review showed any website could rewrite `~/.claude/agents` through socket.io (CSWSH) and move `agentsDir`. |
| 12 | 2026-09-25 | **No admin token** for the GUI (for now) | With Origin/Host checks, a localhost bind and immutable dangerous settings, browsers and the LAN are excluded, and local processes are already trusted. Revisit when the v2 runner can execute code. |
| 13 | 2026-09-25 | Hook token in `curl.conf` (0600) read via `curl -K`, not sourced shell | Keeps the token out of `ps` and avoids executing a config file on every tool call. |
| 14 | 2026-09-25 | Named Docker volume `office-data` for `/data` | A host bind of `./data` is created by Docker as root when missing, so the non-root server can't open SQLite. |
| 15 | 2026-09-25 | Scripts are `office:up` / `office:down`, not `up` / `down` | `pnpm up` is a built-in alias of `pnpm update` and never runs the script. |
| 20 | 2026-09-25 | Web acks use `emitWithAckTimeout` (manual timer), not socket.io `.timeout().emitWithAck()` | The built-in timeout fired false timeouts through the Vite dev proxy; a denied admin event never acks, so a timeout means "not authorized". |
| 21 | 2026-09-26 | Visual style follows the user's pixel-art references (cozy 3/4 office; castle, tavern and keep for guild), drawn procedurally | References are third-party art: kept outside the repo, used for style only, never traced or committed. |
| 22 | 2026-09-26 | All art is code-drawn, packed into one runtime texture atlas per theme | No asset files. Code-drawn textures are GPU textures once generated, so runtime cost equals sprite sheets; packing them into an atlas cuts draw calls. References are recreated in style, not transcribed pixel for pixel (third-party art). |
| 23 | 2026-09-26 | Quests keep project attribution (only the Receptionist skips it) | A quest is real work in that repo; the README write is opt-in at install and profile imports default to 'ask'. |
| 24 | 2026-09-26 | Pin Docker images to node:24.16-bookworm-slim | node:24 floated to 24.21.0, where better-sqlite3 12.11's Statement destructor hits "Assertion failed: (env) != nullptr" during GC and the server crash-looped (~every 45 s). 24.16 is stable; revisit with better-sqlite3 13.x. |
| 25 | 2026-09-26 | Screen effect (CRT/LCD/VHS) is a per-browser display preference layered over the `office.shaders.screen` server default | Settings writes are admin-gated since v0.3.0; a purely visual preference shouldn't need pairing, and each viewer may want a different look. |
