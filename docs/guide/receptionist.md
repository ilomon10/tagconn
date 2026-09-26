# The Receptionist

The Receptionist is a read-only NPC standing at the office's Guild Gate. You chat with it in a
panel in the browser; it can answer questions about a project or about tagconn itself, but it can
**never change anything** — no edits, no commands, no proposing them either.

## Step by step

1. **Pair your browser** — the Receptionist is gated the same way any other write is (see
   [Pairing your browser](pairing.md)). In demo mode (`?demo=1`) it works unpaired, against canned
   data, since there's no real server to protect.
2. **Get the runner online** — every Receptionist turn is a run through the host runner, same as a
   quest (see [Runner & quests](runner-and-quests.md)). Without a connected runner the panel shows
   an "offline" badge and disables sending.
3. **Open the panel** — click **Receptionist** in the top bar (or click the NPC itself, standing at
   the gate/Nexus on the floor).
4. **Pick a scope** for a new conversation:
   - **General** — tagconn and general knowledge, no project files. Always available.
   - **This project** — the project's own files, read-only. Only floors whose `cwd` falls inside
     `runner.allowedProjectDirs` are selectable; others are disabled with "(not allowed)" and a
     tooltip explaining why (add the directory with `--allow-dir`, see
     [Runner & quests](runner-and-quests.md)).
5. Click **New conversation**, type a question, and press **Enter** (or click **Send**). The reply
   streams in; tool calls it made (`Read`, `Grep`, `Glob`, `WebSearch`) show as small chips you can
   hover for the file/pattern it used.
6. **Stop** replaces **Send** while a turn is in flight, if you want to cut it short.
7. Conversations persist in the sidebar (title, scope, a "thinking…" indicator while busy) — click
   one to reopen its history, or the ✕ next to it to delete it permanently.

## What it can and cannot do

- **Read-only by construction**, not just by prompt: its exact tool set is `Read`, `Grep`, `Glob`
  (plus `WebSearch` when enabled, plus `WebFetch` only for General scope with a domain allowlist
  and a sandbox), and every write/execute/delegate tool — `Bash`, `Edit`, `Write`, `NotebookEdit`,
  `Agent`, `Task`, `SlashCommand`, `ExitPlanMode` and more — is on its disallow list. It always runs
  in `plan` permission mode, which cannot leave plan mode headless.
- It can't read your secrets or private Claude Code history either way (`~/.ssh`, `~/.aws`,
  `~/.npmrc`, `.env*`, `~/.claude/plans`, `~/.claude/projects`, `~/.claude.json`, and more are
  always denied) — a General-scope turn also never sees your repo root, only tagconn's own
  read-only docs copy (`README.md`, `CLAUDE.md`, `ROADMAP.md`, `docs/`) when
  `receptionist.allowTagconnDocs` is on.
- **Sandboxing**: when available, the runner wraps the process in `bubblewrap` (an empty `$HOME`,
  no network beyond an allowed WebFetch domain) on top of the tool restrictions above. This is
  controlled by `receptionistSandbox` in the host's `runner.json` (not a GUI setting — see
  [Configuration](configuration.md)):
  - `auto` (default) — sandbox when the runner's own probe confirmed `bwrap` works.
  - `bwrap` — *require* the sandbox; if the probe didn't confirm it, every turn is refused
    (`isolation_unavailable`) rather than silently running unsandboxed.
  - `none` — never sandbox, even if available.
- If the user asks for a change, it's told to explain what to change and suggest posting it as a
  quest — it never does the change itself.
- Anything it reads from files or the web is treated as untrusted content, never as instructions to
  it.

## Settings

Under **Settings → Receptionist**. Most of the section is GUI-editable; a few safety-relevant keys
are file/env only (see [Configuration](configuration.md)):

| Key | Default | GUI? |
|---|---|---|
| `receptionist.enabled` | `true` | yes |
| `receptionist.model` | `sonnet` | yes |
| `receptionist.timeoutSec` | `300` | yes |
| `receptionist.maxTurns` | `30` | yes |
| `receptionist.maxConversations` | `50` | yes |
| `receptionist.maxMessagesPerConversation` | `200` | yes |
| `receptionist.webSearch` | `true` | file/env only |
| `receptionist.webFetch` | `never` (`never`\|`allowlist`) | file/env only |
| `receptionist.webFetchAllowDomains` | `[]` | file/env only |
| `receptionist.extraDenyReadGlobs` | `[]` | file/env only |
| `receptionist.allowTagconnDocs` | `true` | file/env only |
| `receptionist.projectSafeMode` | `false` | file/env only |

Settings can only ever **narrow** what the Receptionist is allowed to do, never widen its constant
tool set or system prompt — those live in `packages/shared/src/receptionist.ts` and the runner
ignores anything the server sends that would broaden them.

## Troubleshooting

- **The Receptionist is disabled in settings** — turn on `receptionist.enabled` in Settings, or ask
  whoever runs the host to.
- **Pair this browser to talk to the Receptionist** — see [Pairing your browser](pairing.md).
- **"Runner offline" / new turns can't start** — run `pnpm office:runner -- --config <path>` on the
  host (see [Runner & quests](runner-and-quests.md)).
- **`isolation_unavailable`** — the host set `receptionistSandbox: bwrap` in `runner.json` but
  `bubblewrap` isn't actually usable on this machine. Either install/fix `bwrap` (`pnpm
  office:doctor` checks for it), or have the host relax `receptionistSandbox` to `auto` or `none`.
- **"This project" option is greyed out** — that floor's directory isn't in
  `runner.allowedProjectDirs`; add it with `--allow-dir` (see [Runner & quests](runner-and-quests.md)).

Next: [Using the office](office.md).
