# Attribution

tagconn can leave a small, portable marker in a project's own repo, so anyone else who clones it
and opens it with tagconn can restore the same floor. Nothing here holds secrets or host-specific
paths, and nothing is ever applied without asking first (by default).

## `.tagconn/` in a project

| File | Written by | When |
|---|---|---|
| `.tagconn/README.md` | The hook, once | Only if you opted in at install time (`pnpm office:install --attribution yes`, or "y" at the interactive prompt — the default is **off**), and only the first time you open that repo with Claude Code with the hook installed. Explains what the directory is and how to restore/save. Never overwritten. |
| `.tagconn/office.json` | An explicit save action | The floor's name, visual style, room layout, and any named heroes (referenced by role, never host-specific data). Only ever written when you ask for it (below) — never automatically. |

`.tagconn/README.md`'s own text documents an opt-out: replace the directory with an empty **file**
(not a directory) named `.tagconn` (`rm -rf .tagconn && touch .tagconn`). The hook always skips a
repo where `.tagconn` already exists in *any* form — file, directory or symlink — so this
permanently opts that repo out.

## Saving a profile

**From the browser:** Settings → Attribution → **Save profile to project**, one button per floor.
It shows what would be saved (floor name/style, whether a layout is included, hero count) and asks
you to confirm the exact path (`<project>/.tagconn/office.json`) before writing — refusing to
overwrite an existing file unless you confirm that too. This goes through the runner (so the
project needs to be inside `runner.allowedProjectDirs`, same as a quest) and needs a paired admin
session.

**From Claude Code, in the project itself:** run the `/tagconn-save` skill. It fetches the current
export from the server over a public read-only endpoint, then writes `.tagconn/office.json` with
Claude Code's own **Write** tool — so the normal permission prompt applies, same as any other file
change it makes. It refuses to touch a `.tagconn` that's a plain file (the opt-out) or a symlink,
and shows a diff summary before overwriting an existing profile.

## Importing a profile

When the hook fires in a project that has a `.tagconn/office.json` tagconn hasn't seen configured
yet, it POSTs the profile to the server for a decision, controlled by **Settings → Attribution →
"Auto-import"** (`attribution.autoImport`):

| Value | Behavior |
|---|---|
| `ask` (default) | A toast appears (bottom-right, and in Settings → Attribution) showing the repo path and what would be imported — **Import** or **Dismiss**. |
| `auto` | Applied immediately, no prompt. |
| `off` | The profile is never imported (still received and validated, just parked). |

An import **never** creates or changes roles, `~/.claude/agents`, skills, or settings — a hero
whose `role` doesn't already exist on your host is simply dropped, listed in the prompt as an
"unknown role" so you know what was skipped. The profile itself is treated as untrusted content
from a cloned repo: strictly schema-validated, size-capped (`attribution.maxProfileBytes`, ceiling
64 KiB), and rejected outright if it contains anything that looks like an absolute host path.

## Settings

Under **Settings → Attribution**:

| Key | Default | Meaning |
|---|---|---|
| `attribution.enabled` | `true` | Master switch for the whole feature. |
| `attribution.autoImport` | `ask` | `ask` \| `auto` \| `off`, as above. |
| `attribution.maxProfileBytes` | `65536` | Upper bound on an incoming profile's size. |
| `attribution.importWindowSec` | `120` | How long after a hook event the import stays valid before it's considered stale. |

Whether the README template gets installed at all (`--attribution yes\|no`) is an install-time flag,
not a runtime setting — see [Getting started](getting-started.md).

Next: [Display & shaders](display.md).
