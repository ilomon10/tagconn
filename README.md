# tagconn (Pixel Office)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![version](https://img.shields.io/github/package-json/v/ilomon10/tagconn) · [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md)

tagconn turns your Claude Code sessions and subagents into characters walking around a 2D
"Sims-style" software office. Each project gets its own floor; the main session is the PM, and every
subagent (analyst, developer, QA, reviewer, ...) spawns as a character that walks to the zone
matching what it's doing - typing at a desk, testing in the QA lab, reviewing in the review booth -
with a speech bubble showing its current tool, and a task board tracking work from each subagent's
handoff report.

## User guide

Using a running tagconn day to day? Start with the **[user guide](docs/guide/README.md)**:

- [Getting started](docs/guide/getting-started.md) — install, start the stack, dev mode, uninstall.
- [Pairing your browser](docs/guide/pairing.md) — why viewing is public but changes need an admin session.
- [Runner & quests](docs/guide/runner-and-quests.md) — run Claude from the browser on your machine.
- [The Receptionist](docs/guide/receptionist.md) — the read-only chat help desk.
- [Using the office](docs/guide/office.md) — floors, heroes, the Hall Planner, notifications.
- [Attribution](docs/guide/attribution.md) — sharing a project's floor via `.tagconn/`.
- [Display & shaders](docs/guide/display.md) — visual styles and WebGL post-processing.
- [Configuration](docs/guide/configuration.md) — settings layering and the most useful keys.
- [Troubleshooting](docs/guide/troubleshooting.md) — the doctor script and common problems.

The rest of this README covers the project itself: how it's built and how to set it up.

## How it works without an API key

tagconn is an **observer**, not a runner: it never calls the Claude API. You log in to the Claude
Code CLI with your normal browser (subscription) login and use `claude` exactly as you do today.
Claude Code's [hooks](https://docs.claude.com/en/docs/claude-code/hooks) fire on session/tool
lifecycle events; `pnpm office:install` registers a tiny `sh + curl` script as the handler for every
hook event. That script POSTs the raw event JSON to a local server, which normalizes it into
projects/sessions/agents/tasks and streams state to the web UI over socket.io. No API key, no token
spend, no change to how you use Claude Code.

The **runner** (`apps/runner`, a small daemon you start on your host) lets you assign quests to
characters from the GUI, and chat with the read-only Receptionist; it spawns `claude -p
--output-format stream-json` as a subprocess (still your CLI login, still no API key) rather than
using the Agent SDK. See the [user guide](docs/guide/runner-and-quests.md) for how to enable it.

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
runner (host daemon) ◀── socket.io client ──▶ server; spawns `claude -p --output-format stream-json`
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

Settings layer schema defaults → `config/office.yaml` → `OFFICE_<SECTION>__<KEY_SNAKE>` env vars →
runtime overrides saved from the web GUI, with a handful of network/secret/path keys that only the
config file or env can ever set. See the **[Configuration guide](docs/guide/configuration.md)** for
the full layering, file locations and a table of the most useful keys.

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
- **GUI-immutable settings.** The whole `server`, `paths`, `runner` and `auth` sections,
  `storage.dbPath`, and the Receptionist's safety keys (`webSearch`, `webFetch`,
  `webFetchAllowDomains`, `extraDenyReadGlobs`, `allowTagconnDocs`, `projectSafeMode`) can only be
  changed via the config file or env vars, never from the web GUI or its socket API - they control
  network exposure, secrets, filesystem paths, or code execution. See
  [`GUI_IMMUTABLE_SETTINGS`](packages/shared/src/settings.ts) for the exact list.
- **Admin sessions.** Viewing the office is always public, but running Claude from the browser
  (quests, the Receptionist) or changing anything requires pairing the browser with a one-time code
  first - see the [pairing guide](docs/guide/pairing.md).

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
apps/runner                 host daemon (not in Docker) spawning `claude -p` for quests + the Receptionist
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

Removes only the hooks, role/skill files and config tagconn itself manages - anything you wrote
yourself is left alone, and a settings.json backup is made first. See
[Getting started § Uninstall](docs/guide/getting-started.md#uninstall) for exactly what's removed
and what's left behind.

## Troubleshooting

```sh
pnpm office:doctor
```

Checks the hook, its config, `settings.json`, the runner, pairing and more, printing a ✔/✖/○ line
with a fix hint for each failure. See the **[Troubleshooting guide](docs/guide/troubleshooting.md)**
for what each check means and fixes for common issues.

## License

[MIT](LICENSE) © ilomon10
