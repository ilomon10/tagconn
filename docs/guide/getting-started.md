# Getting started

## Requirements

- **Either** Docker + Docker Compose, **or** Node.js ≥ 22.18 (the repo is developed against Node
  24) and pnpm 11 (`pnpm@11.20.0`, pinned in `package.json`'s `packageManager`).
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), logged in with your normal
  browser (subscription) login — `claude` should already work in a terminal.
- **No Anthropic API key.** tagconn never calls the Claude API itself; it only reads Claude Code's
  hook events (viewing) and, if you enable the runner, spawns `claude -p` as a subprocess using
  your existing CLI login (quests and the Receptionist). See the root
  [README](../../README.md#how-it-works-without-an-api-key) for how that works.

## Install

```sh
pnpm install
```

One-time, workspace-wide. Native modules (e.g. `better-sqlite3`) are allowed to build via
`pnpm-workspace.yaml`'s `allowBuilds`.

## Wire up the hooks

```sh
pnpm office:install
```

This is the one command that touches your real Claude Code setup. It:

- Registers tagconn's hook script for every Claude Code hook event in `~/.claude/settings.json`
  (`SessionStart`, `PreToolUse`, `Stop`, ...), after taking a timestamped backup of that file
  (`settings.json.tagconn-backup-<timestamp>`) — it never overwrites your existing hooks, only
  appends its own entry.
- Generates a hook token and writes it to the repo `.env` (`OFFICE_HOOK_TOKEN`) and to
  `~/.config/tagconn/curl.conf` (mode `600`), which is what the hook script reads with `curl -K` —
  the token is never passed on a command line.
- Copies the default role subagents (`packages/agent-templates/roles/*.md`) into
  `~/.claude/agents/`, and the default skills (office-kickoff, handoff-report,
  definition-of-done, task-sizing) into `~/.claude/skills/`. Files it writes carry a
  `<!-- managed-by: tagconn -->` marker or a `.tagconn-managed` file, so re-running the installer
  or uninstalling never touches anything you wrote yourself.
- Writes `~/.config/tagconn/runner.json` (mode `600`) with a generated runner token — the
  credential the host runner and `pnpm office:pair` use. This happens whether or not you pass
  `--allow-dir`.
- Installs `~/.config/tagconn/attribution.conf` by default, and asks (interactively, default "no")
  whether to also install `~/.config/tagconn/attribution-README.md`, which makes the hook write a
  small `.tagconn/README.md` into git repos you open. See [Attribution](attribution.md).

Useful flags:

| Flag | What it does |
|---|---|
| `--dry-run` | Print what would change, write nothing. |
| `--claude-dir <path>` | Target a different Claude config dir instead of `~/.claude` (a sandboxed install, a project-local `.claude`, or a second install). Env: `CLAUDE_CONFIG_DIR`. |
| `--config-dir <path>` | Pin where `curl.conf`/`runner.json`/the hook script live instead of the derived location. Env: `TAGCONN_CONFIG_DIR`. |
| `--project <dir>` | Install into `<dir>/.claude` instead of the user-level dir. |
| `--url <server url>` | Office server URL (default `http://127.0.0.1:4317`). |
| `--allow-dir <path>` | A directory quests and the Receptionist's "This project" scope may run in. Repeatable. Written to `runner.json`'s `allowedProjectDirs`; without at least one, the runner and Receptionist project scope have nowhere to run. A broad parent (`$HOME`, or a directory with more than 3 git repos under it) prints a warning — prefer listing individual project directories. |
| `--attribution yes\|no` | Explicit answer to the README-writing prompt, instead of asking interactively (which defaults to "no" outside a terminal). |
| `--no-agents` | Skip installing role subagents. |
| `--no-skills` | Skip installing skills. |
| `--repo-env-file <path>` | Repo `.env` path to read/write (default `<repo>/.env`). |
| `--uninstall` | Remove tagconn's hooks/agents/skills (see [Uninstall](#uninstall)). Same flags apply. |

Passing a non-default `--claude-dir` (or `CLAUDE_CONFIG_DIR`) automatically derives a matching
`--config-dir`, so two side-by-side installs never clobber each other's token. Use the *same*
`--claude-dir`/`--config-dir` (or env vars) with `office:doctor` and `office:uninstall` so they
check/remove the matching install.

## Start the server

```sh
pnpm office:up
```

Docker Compose builds and starts the server (`:4317`) and web app (`:4318`), both bound to
`127.0.0.1` only. Stop it with `pnpm office:down` (not `pnpm up`, which is `pnpm update`).

## Verify the install

```sh
pnpm office:doctor
```

Prints a ✔/✖/○ line per check: `curl` installed, `curl.conf` present and mode `600`, the hook
script installed and executable, `~/.claude/settings.json` has tagconn's entry for every hook
event, the server's `/api/health` reachable, `runner.json` present with at least one allowed
directory, the `claude` CLI has the flags the runner needs, whether a systemd user scope and
`bwrap` are available, and the current pairing mode. See
[Troubleshooting](troubleshooting.md) for what to do about a failure.

## Dev mode

```sh
pnpm dev   # server (tsx watch, :4317) + web (vite, :5173) in parallel via turbo
```

Point `office:install --url http://127.0.0.1:4317` (the default) at the dev server, or run
`pnpm office:up` for the server and `pnpm --filter @tagconn/web dev` alone if you only need to
iterate on the UI.

Running Vite headlessly (no browser attached — over SSH, or in a script) may need `--host
127.0.0.1` (`pnpm --filter @tagconn/web dev -- --host 127.0.0.1`): Vite's dev server can end up
bound only to the IPv6 `[::1]` address, so `curl http://localhost:5173` fails even though the
process is running.

## Try it with no server

```
http://localhost:5173/?demo=1
```

Runs a scripted simulation entirely in the browser — no hooks, no backend, no pairing. Good for a
first look at the office before wiring up a real project.

## Uninstall

```sh
pnpm office:uninstall
pnpm office:down
```

Removes only the hook entries tagconn added to `~/.claude/settings.json` (a fresh timestamped
backup is made first), and only the role/skill files it manages — anything you wrote yourself is
left alone. `~/.config/tagconn/curl.conf`, `attribution.conf`, `attribution-README.md`,
`server-url` and `runner.json` are deleted too. The hook script and the repo `.env` are left in
place (harmless if unused); remove `~/.config/tagconn` yourself if you want those gone as well.

Next: [Pairing your browser](pairing.md).
