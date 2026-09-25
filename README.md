# tagconn (Pixel Office)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![version](https://img.shields.io/github/package-json/v/ilomon10/tagconn) · [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md)

tagconn turns your Claude Code sessions and subagents into characters walking around a 2D
"Sims-style" software office. Each project gets its own floor; the main session is the PM, and every
subagent (analyst, developer, QA, reviewer, ...) spawns as a character that walks to the zone
matching what it's doing - typing at a desk, testing in the QA lab, reviewing in the review booth -
with a speech bubble showing its current tool, and a task board tracking work from each subagent's
handoff report.

## How it works without an API key

tagconn is an **observer**, not a runner: it never calls the Claude API. You log in to the Claude
Code CLI with your normal browser (subscription) login and use `claude` exactly as you do today.
Claude Code's [hooks](https://docs.claude.com/en/docs/claude-code/hooks) fire on session/tool
lifecycle events; `pnpm office:install` registers a tiny `sh + curl` script as the handler for every
hook event. That script POSTs the raw event JSON to a local server, which normalizes it into
projects/sessions/agents/tasks and streams state to the web UI over socket.io. No API key, no token
spend, no change to how you use Claude Code.

A planned v2 **runner** (`apps/runner`, not built yet) will let you assign tasks to characters from
the GUI; it spawns `claude -p --output-format stream-json` as a subprocess on your host (still your
CLI login, still no API key) rather than using the Agent SDK.

## Architecture

```
HOST                                                   DOCKER COMPOSE (127.0.0.1 only)
claude (any project dir)
  └─ hooks → ~/.config/tagconn/office-hook.sh ──POST /api/hooks──▶ server :4317
                                                                     │ Fastify + socket.io + SQLite
~/.claude/agents   ◀── role sync (rw bind mount) ────────────────────┤
~/.claude/projects ─── transcripts (ro bind mount) ─────────────────▶┤
                                                                     │ socket.io namespace /office
browser ◀── web :4318 (nginx: static + proxy /api, /socket.io) ◀─────┘
runner (v2, host) ◀── socket.io client ──▶ server; spawns `claude -p --output-format stream-json`
```

The hook is deliberately dumb (POSIX `sh` + `curl`, always exits `0`, prints nothing to stdout, ~1s
timeout) so it can never slow down or break a Claude Code session, even if the server is down.

## Quick start

```sh
pnpm install          # one-time, workspace-wide
pnpm office:install    # registers hooks in ~/.claude/settings.json, installs role
                        # subagents + skills, writes a local hook token
pnpm office:up                 # docker compose: server :4317, web :4318 (both 127.0.0.1 only)
```

Open <http://localhost:4318>, then run `claude` in any project directory. Sessions and subagents
appear on that project's floor as you work.

Stop the containers with `pnpm office:down`. See [Uninstall](#uninstall) to remove the hooks again.

By default `office:install` writes into `~/.claude` and `~/.config/tagconn`. Pass `--claude-dir
<path>` (or set `CLAUDE_CONFIG_DIR`) to target a different Claude config dir - a sandboxed install,
a project-local `.claude`, or a second install alongside the real one. Doing so automatically moves
the curl config and installed hook script (normally `~/.config/tagconn`) alongside it too, so the
two installs never clobber each other's token; pass `--config-dir <path>` (or set
`TAGCONN_CONFIG_DIR`) to pin that location explicitly instead of relying on the derived one. Use the
same `--claude-dir`/`--config-dir` flags (or env vars) with `office:doctor` and `office:uninstall` so
they check/remove the matching install.

## Dev mode

```sh
pnpm dev   # server (tsx watch, :4317) + web (vite, :5173) in parallel via turbo
```

Point `pnpm office:install --url http://127.0.0.1:4317` (the default) at the dev server, or just use
`pnpm office:up` for the server and run `pnpm --filter @tagconn/web dev` alone if you only need to iterate
on the UI.

Running Vite headlessly (no browser attached, e.g. over SSH or in a script) may need `--host
127.0.0.1` (`pnpm --filter @tagconn/web dev -- --host 127.0.0.1`): Vite's default dev server can end
up bound only to the IPv6 `[::1]` address, so `curl http://localhost:5173` or `http://127.0.0.1:5173`
fails to connect even though the process is running.

No server running yet and just want to see the office move? `http://localhost:5173/?demo=1` runs a
scripted simulation entirely in the browser, no hooks or backend required.

## Configuration

Settings layer in this order, each overriding the previous:

1. **Schema defaults** - `packages/shared/src/settings.ts` (`SettingsSchema`), the single source of truth.
2. **`config/office.yaml`** (path from env `OFFICE_CONFIG`, default `./config/office.yaml`) - a fully
   commented example of every section at its default value; uncomment what you want to change.
3. **Environment variables** - `OFFICE_<SECTION>__<KEY_SNAKE>`, e.g. `OFFICE_SERVER__PORT=4317`,
   `OFFICE_STORAGE__DB_PATH=/data/office.db`, `OFFICE_PATHS__AGENTS_DIR=/claude/agents`,
   `OFFICE_PATHS__PROJECTS_DIR=/claude/projects`. Shortcut: `OFFICE_HOOK_TOKEN` for
   `server.hookToken`.
4. **Runtime overrides** saved to SQLite via the web GUI's settings page (socket `settings:update`).
   Keys in `RESTART_REQUIRED_SETTINGS` only take effect after the server restarts.

`OFFICE_TEMPLATES_DIR` points at the directory containing `roles/` (default the repo's
`packages/agent-templates`; the server image sets it to `/app/templates`), used when the GUI syncs
roles to `~/.claude/agents`.

## Security model

tagconn is built to be local-only, single-user:

- **Network exposure.** `docker-compose.yml` binds both ports to `127.0.0.1` only. Inside the
  container the server listens on `0.0.0.0` (`OFFICE_SERVER__HOST`, set by compose) so nginx can
  reach it, but nothing outside the host can reach either published port.
- **Host/Origin allowlists.** The server checks the incoming `Host` header (port ignored) against
  `server.allowedHosts` (default: `localhost`, `127.0.0.1`, `[::1]`, `server` - the internal
  compose service name) and rejects anything else, to block DNS-rebinding attacks from a malicious
  page in your browser. `corsOrigins` similarly restricts which origins the browser is allowed to
  call the API from.
- **Hook auth.** `server.hookToken` (env shortcut `OFFICE_HOOK_TOKEN`) is a shared secret the hook
  sends as `x-office-token`. `office:install` generates one and writes it to
  `~/.config/tagconn/curl.conf`, mode `0600`, read by `curl -K` - it is never passed as a
  command-line argument, so it never shows up in `ps` output for other users on the machine.
- **GUI-immutable settings.** The whole `server.*` section, `storage.dbPath`, `paths.*`,
  `runner.permissionMode` and `runner.allowedProjectDirs` can only be changed via the config file or
  env vars, never from the web GUI or its socket API - they control network exposure, secrets,
  filesystem paths, or (for the planned runner) what gets executed.

## Roles & skills

`packages/agent-templates/roles/*.md` are the default staff (analyst, architect, developer,
qa-engineer, code-reviewer, security-engineer, devops-engineer, tech-writer, pm). `office:install`
copies the enabled ones (everything except `office-enabled: false` / `office-sync: false`, currently
`devops-engineer`, `tech-writer` and `pm`) into `~/.claude/agents/*.md` as real Claude Code
subagents, stripping the `office-*` frontmatter keys Claude doesn't understand and appending
`<!-- managed-by: tagconn -->` so the installer (and the GUI's role sync) knows it owns the file. The
`pm` role is the main-session character, not a subagent.

`packages/agent-templates/skills/*/SKILL.md` are Claude Code skills installed the same way (marked
with a `.tagconn-managed` file in each skill dir):

- **office-kickoff** - the PM playbook: clarify the goal, build `.office/backlog.md`, spawn
  analyst/architect/developer/qa-engineer/code-reviewer/security-engineer in parallel, file-disjoint
  waves, verify, report.
- **handoff-report** - the exact ` ```handoff ` block every subagent ends its reply with, so the
  office (and the PM) can parse status/files/tests/next/blockers.
- **definition-of-done** - the checklist a task must pass before it's really "done".
- **task-sizing** - rules for splitting work into 10-20 minute, file-disjoint, contract-first tasks.

Both the installer and a running server can write these files; either way, an unmanaged file or
directory with the same name is left untouched and a warning is printed.

## Project structure

```
apps/server                 Fastify + socket.io + SQLite (Drizzle) - the office backend
apps/web                    React + Vite + Phaser 3 - the office UI
apps/runner                 (v2, not started) host daemon spawning `claude -p`
packages/shared              THE CONTRACT: zod hook schema, domain types, roles, settings, socket events
packages/hook                office-hook.sh - the Claude Code hook handler (sh + curl)
packages/agent-templates     roles/*.md (default staff) + skills/*/SKILL.md
scripts/                     install.ts, doctor.ts (Node 24 native TS, no deps)
config/office.yaml           example server config (all sections, defaults commented)
docker/                      server.Dockerfile, web.Dockerfile, nginx.conf
docker-compose.yml           server + web, ports bound to 127.0.0.1
.env.example                 OFFICE_HOOK_TOKEN, OFFICE_PORT, OFFICE_WEB_PORT, UID/GID, overrides
apps/server/test/fixtures/   real hook payloads captured from Claude Code
```

## Uninstall

```sh
pnpm office:uninstall
pnpm office:down
```

Removes only the hook entries tagconn added to `~/.claude/settings.json` (a timestamped backup is
made first either way), and only the role/skill files it manages - anything you wrote yourself is
left alone. `~/.config/tagconn/curl.conf` (the hook token) is deleted too. The hook script and the
repo `.env` are left in place (harmless if unused); delete `~/.config/tagconn` yourself if you want
them gone too.

## Troubleshooting

Run the doctor:

```sh
pnpm office:doctor
```

It checks: `curl` is installed, `~/.config/tagconn/curl.conf` exists, is mode `600`, and holds the
token/URL directives, the hook script is installed and executable, `~/.claude/settings.json` has
tagconn's entry for every hook event, the server's `/api/health` is reachable, and (optionally)
whether `docker compose` shows the services running - printing a ✔/✖ (or ○ for optional/soft checks)
line with a fix hint for each failure.

Other common issues:
- **Characters never appear**: confirm `pnpm office:doctor` is all green, then confirm the server is
  actually up (`pnpm office:up` or `pnpm dev`) - the hook silently drops events when it can't reach the
  server, by design (it must never block or fail a Claude Code session).
- **`docker compose up` can't write to `~/.claude/agents`**: if that directory doesn't exist yet on
  the host, Docker creates it as root on first bind-mount, which the container's non-root user then
  can't write to. Run `mkdir -p ~/.claude/agents` (or `pnpm office:install` once, which creates it)
  before `pnpm office:up`.
- **Re-running `office:install` didn't pick up a new server URL**: pass `--url <server url>` again;
  it rewrites `~/.config/tagconn/curl.conf` every run (your hook token is preserved).

## License

[MIT](LICENSE) © ilomon10
