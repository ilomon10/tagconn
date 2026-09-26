# Runner & quests

## What the runner is

The **runner** (`apps/runner`) is a small daemon that runs on your host — not in Docker, because it
needs your Claude Code CLI login and access to your actual project directories. It connects out to
the server over socket.io with its own runner token and, when asked, spawns `claude -p
--output-format stream-json` as a subprocess, using your normal subscription login. **No API key,
no separate billing** — it's the exact same `claude` you'd run yourself, just started for you.

It's the thing that makes two features possible:

- **Quests** — post a prompt to a floor from the browser; a character runs it.
- **The Receptionist** — a read-only chat NPC (its own page: [The Receptionist](receptionist.md)).

Without a runner connected, quests and the Receptionist just show a banner saying so; viewing
sessions started from your own terminal never needs the runner at all.

## Enabling it

1. **Allow a directory.** The runner will only ever run inside directories you explicitly allow:

   ```sh
   pnpm office:install --allow-dir /path/to/your/project
   ```

   This writes the realpath into `~/.config/tagconn/runner.json`'s `allowedProjectDirs`, and (since
   at least one dir is now allowed) sets `OFFICE_RUNNER__ENABLED=true` and
   `OFFICE_RUNNER__ALLOWED_PROJECT_DIRS` in the repo `.env` — the server-side mirror of the same
   allowlist. `--allow-dir` is repeatable. Re-running the installer without `--allow-dir` keeps
   whatever directories were already allowed.

   A directory that looks broad — `$HOME`, `/`, or a folder with more than 3 git repos under it —
   prints a warning: the runner can run in *any* repo below an allowed directory, so prefer listing
   individual project directories over a broad parent.

2. **Trust each directory once, interactively.** Claude Code's headless `-p` mode never sets
   `hasTrustDialogAccepted` — there's no prompt to accept in a script. So the runner requires you to
   have opened the directory *interactively* at least once and accepted the trust dialog:

   ```sh
   cd /path/to/your/project
   claude   # accept the trust dialog, then exit
   ```

   Do this for every directory you allow. (A host operator can also list directories in
   `runner.json`'s `trustOverrideDirs` to skip this, but the interactive step is the normal path.)

3. **Start the runner:**

   ```sh
   pnpm office:runner -- --config ~/.config/tagconn/runner.json
   ```

   (The `--` is needed because `office:runner` is a plain `node apps/runner/src/main.ts` with no
   default `--config`; the flag is required.) Leave it running — the Quests tab and the
   Receptionist only work while it's connected. `runner.json`'s path is whatever `--config-dir`
   your install used; the default is `~/.config/tagconn/runner.json`.

For something that survives logout/reboot, copy the example systemd **user** unit:

```sh
mkdir -p ~/.config/systemd/user
cp apps/runner/contrib/tagconn-runner.service ~/.config/systemd/user/
# edit ExecStart/WorkingDirectory in that file to point at your tagconn checkout, then:
systemctl --user daemon-reload
systemctl --user enable --now tagconn-runner.service
loginctl enable-linger "$USER"   # optional: keep it running after you log out
```

Build the runner first (`pnpm build`, or `pnpm --filter @tagconn/runner build`) so `dist/main.js`
exists — the unit runs the built output, not the TypeScript source.

## The Quests tab

Click **New quest**:

| Field | Notes |
|---|---|
| **Floor** | Only floors inside `runner.allowedProjectDirs` are selectable; others show "(not allowed)" with a tooltip. |
| **Prompt** | Character-counted against `runner.maxPromptChars` (default 20,000). |
| **Model** | `opus`, `sonnet` or `haiku`. |
| **Mode** | See the table below — only modes in `runner.allowedPermissionModes`, within the connected runner's own cap, and (for the two that can run shell commands) with process isolation available, are selectable. |
| **Hero (optional)** | Hand the quest to a named character instead of the anonymous Guild Master. |

| Mode | What it means |
|---|---|
| `plan` | Plans only — no edits, no commands. |
| `dontAsk` | Pre-allowed tools only; anything else is refused instead of asked. |
| `default` | Claude Code's normal per-tool rules — prompts are disabled headless, so anything not pre-allowed is refused. |
| `acceptEdits` | Edits with pre-allowed tools automatically; shell commands still need the host to allow them. |
| `auto` | Can run shell commands without asking. Needs a systemd user scope on the host. |
| `bypassPermissions` | Skips tool checks entirely. Needs a systemd user scope *and* the host opting in separately. |

Once a quest is running, its detail panel shows a live transcript and:

- **Stop** — available any time the run isn't already finished.
- **Follow up** — only once a quest has **succeeded** (resumes the same Claude session with a new
  prompt).
- **Focus** — jumps the office view to that quest's floor.

The runner status banner at the top of the tab tells you, in order: the runner is disabled
(with the exact env var to set), no runner is connected, a connected runner is missing a required
CLI capability, or — the healthy case — how many runs are active/queued and whether shell-capable
modes are available on this host.

## Safety

Quests are deliberately boxed in, independent of whatever mode you picked:

- **Exact tool list**, not just allow/deny rules: `Read`, `Grep`, `Glob`, `TodoWrite` always
  included; `Edit`, `Write`, `NotebookEdit`, `WebSearch` only via allow rules, always scoped to the
  project directory by default (`Edit(./**)`, not a bare `Edit`). `Agent`/`Task` (delegation) are
  **never** allowed, however permissive the host's policy is.
- **Denies that always apply**: a quest can never read or write `.claude/`, `.git/`, `.mcp.json`
  (repo-local or under `~/`), your real `~/.claude.json`, shell startup files (`~/.bashrc`,
  `~/.zshrc`, `~/.gitconfig`, ...), or common secret locations (`~/.ssh`, `~/.aws`, `~/.npmrc`,
  any `.env*`, `*.pem`, `*.key`, ...) — even through your own `~/.claude/settings.json` allow rules
  (quests run with `--setting-sources=user`, so your personal allow rules *are* inherited on top of
  this, never as a replacement for it).
- **Bash needs an explicit local rule** *and* process isolation: a host operator has to add a Bash
  allow rule to `runner.json`'s `questToolPolicy.maxAllowedTools` themselves (it isn't in the
  default allowlist), and any mode that can run shell commands without one (`auto`,
  `bypassPermissions`) is refused outright unless a **systemd user scope** is available
  (`systemd-run --user --scope`) — that's what lets the runner reliably kill the whole process
  group, including anything the command spawned.
- Project settings, `.mcp.json` and slash commands never load for a quest — only your
  `~/.claude/settings.json` and whatever `runner.json`'s `questMcpConfigPath` points at (unset by
  default, meaning no MCP servers at all).

## Common rejections and fixes

| Rejection | Fix |
|---|---|
| **Outside the runner's allowed project directories** | Ask the host to add the folder with `--allow-dir`. |
| **This project isn't trusted** | Open it once with `claude` interactively and accept the trust dialog (see step 2 above) — a headless quest can't accept it for you. |
| **This permission mode isn't allowed here** | Pick one of the offered modes, or ask the host to widen `runner.allowedPermissionModes`. |
| **A tool this quest needs isn't allowed** | A bare `WebFetch` is never allowed (only `WebFetch(domain:x)`); ask the host to add the specific tool to `runner.json`'s `questToolPolicy.maxAllowedTools`. |
| **This mode can run shell commands, but there's no process isolation** | Pick a mode that can't run commands, or ask the host to enable a systemd user scope. |
| **This follow-up can't resume the earlier session** | It was created with different tools/mode, or by a different runner — start a fresh quest instead. |
| **No runner connected** | Run `pnpm office:runner -- --config <path>` on the host. |
| **Runner disabled** | Set `OFFICE_RUNNER__ENABLED=true` (the installer does this automatically once you pass `--allow-dir`). |

Next: [The Receptionist](receptionist.md).
