# Troubleshooting

Run the doctor first, always:

```sh
pnpm office:doctor
```

It prints one ✔ (pass), ✖ (hard failure) or ○ (warning/optional) line per check, with a fix hint
under each failure. If you used non-default `--claude-dir`/`--config-dir` flags with
`office:install`, pass the same ones here so it checks the right install:

```
node scripts/doctor.ts [--claude-dir <path>] [--config-dir <path>] [--url <server url>] [--web-url <web url>]
```

## What it checks

| Check | What a failure means |
|---|---|
| `curl` installed | The hook script needs it to reach the server. |
| `curl.conf` present, mode `600`, has the token/URL directives | Run `pnpm office:install`. |
| Hook script installed and executable | Run `pnpm office:install`, or `chmod 755` the printed path. |
| `~/.claude/settings.json` has tagconn's hook for all 11 events | Run `pnpm office:install`. |
| `settings.json` permissions (warning only) | A broad `Bash`/`WebFetch`/`mcp__*` allow rule, or a bare `Edit`/`Write`/`Read` rule, or `additionalDirectories`, or a non-`plan` `defaultMode` — quests run with `--setting-sources=user`, so these are inherited by every quest too. Narrow them if that's not what you want. |
| Server reachable at `/api/health` | Start it: `pnpm office:up` or `pnpm dev`. |
| Docker Compose running (optional) | `pnpm office:up`. |
| Repo `.env` mode `600` (warning) | It holds secrets: `chmod 600 .env`. |
| `attribution.conf` present, mode `600` (optional) | `pnpm office:install` (installed by default). |
| `runner.json` present, mode `600`, has at least one allowed dir | `pnpm office:install --allow-dir <path>`. |
| A broad allowed dir (warning) | Prefer individual project directories over `$HOME` or a directory with many git repos under it. |
| `claude --help`/`--version` expose the flags the runner needs | Update the Claude Code CLI. |
| `systemd-run --user --scope` available (warning) | Quests that can run shell commands (Bash rules, `auto`/`bypassPermissions`) are refused (`isolation_unavailable`) without it. |
| `bwrap` available (warning) | The Receptionist falls back to `--restricted` alone, no filesystem sandbox, if missing. |
| Pairing status reachable | Confirms `/api/auth/status` answers and reports the current `auth.mode`. |
| Web origin matches the server (":4318 squatter check") | Compares `/api/health`'s `instanceId`/version fetched directly vs. through the web origin; a mismatch means something else may be listening on the web port — check `docker compose ps` / `lsof -i :4318`. |

## Common issues

- **Characters never appear** — confirm `pnpm office:doctor` is all green, then confirm the server
  is actually up (`pnpm office:up` or `pnpm dev`). The hook silently drops events when it can't
  reach the server, by design — it must never block or fail a Claude Code session.
- **`docker compose up` can't write to `~/.claude/agents`** — if that directory doesn't exist yet on
  the host, Docker creates it as root on first bind-mount, which the container's non-root user then
  can't write to. Run `mkdir -p ~/.claude/agents` (or `pnpm office:install` once, which creates it)
  before `pnpm office:up`.
- **Re-running `office:install` didn't pick up a new server URL** — pass `--url <server url>`
  again; it rewrites `~/.config/tagconn/curl.conf` every run (your hook token is preserved).
- **"Pair this browser to make changes"** — expected the first time you touch anything that writes;
  see [Pairing your browser](pairing.md).
- **Quests/Receptionist say "runner offline" or "not allowed"** — see
  [Runner & quests](runner-and-quests.md) and [The Receptionist](receptionist.md).
- **A quest or Receptionist turn was rejected** — every rejection includes a plain-English reason
  and fix in its detail panel; see the tables in
  [Runner & quests](runner-and-quests.md#common-rejections-and-fixes).

Still stuck? Check `docs/architecture.md` and `docs/decisions.md` for how a piece is meant to work,
or open an issue at <https://github.com/ilomon10/tagconn/issues>.
