# Configuration

## How settings layer

Every setting has a schema default; each layer below overrides the previous one, and only the
values you actually set at a layer take effect — everything else falls through:

1. **Schema defaults** — `packages/shared/src/settings.ts` (`SettingsSchema`), the single source of
   truth for every key, its type and its default.
2. **`config/office.yaml`** (path from env `OFFICE_CONFIG`, default `./config/office.yaml`) — a
   fully commented example of every section at its default value; uncomment what you want to
   change.
3. **Environment variables** — `OFFICE_<SECTION>__<KEY_SNAKE>`, e.g. `OFFICE_SERVER__PORT=4317`,
   `OFFICE_STORAGE__DB_PATH=/data/office.db`, `OFFICE_PATHS__AGENTS_DIR=/claude/agents`. A key that's
   an array (like `OFFICE_RUNNER__ALLOWED_PROJECT_DIRS`) takes a JSON array string, e.g.
   `["/home/me/project"]`. Shortcut: `OFFICE_HOOK_TOKEN` for `server.hookToken`.
4. **Runtime overrides**, saved to SQLite from the web GUI's Settings tab (socket `settings:update`).
   A patch deep-merges section objects, except a few keys that get replaced wholesale instead of
   merged field-by-field: `agents.typeToRole`, `office.zones`, `heroes.namePools`.

Keys in `RESTART_REQUIRED_SETTINGS` — `server.host`, `server.port`, `server.corsOrigins`,
`storage.dbPath`, `paths.projectsDir` — only take effect after the server process restarts; the
Settings tab marks each with a **restart required** badge.

## Where files live

| File | Holds |
|---|---|
| `config/office.yaml` | The example config, all sections commented at their defaults. |
| `.env` (repo root) | `OFFICE_HOOK_TOKEN`, `OFFICE_RUNNER__TOKEN`, `OFFICE_RUNNER__ALLOWED_PROJECT_DIRS`, `OFFICE_RUNNER__ENABLED`, `OFFICE_PORT`, `OFFICE_WEB_PORT`. Mode `600` — holds secrets. |
| `~/.config/tagconn/curl.conf` | The hook's shared secret + server URL, mode `600`, read by `curl -K` (never on a command line). |
| `~/.config/tagconn/runner.json` | The host-side runner config: its own token, `allowedProjectDirs`, tool policy, and everything else in `RunnerLocalConfigSchema` — the runner's own authority, which server settings can only narrow. Mode `600`. |
| `~/.config/tagconn/attribution.conf` | The token used to POST `.tagconn/office.json` imports. Mode `600`. |
| `~/.config/tagconn/server-url` | Plain text, non-secret: just the server URL, for skills/scripts that need it without reading `.env`. |
| `~/.claude/agents/*.md`, `~/.claude/skills/*` | Managed role subagents and skills (marked, never touching unmanaged files). |

`OFFICE_TEMPLATES_DIR` points at the directory containing `roles/` (default the repo's
`packages/agent-templates`; the server image sets it to `/app/templates`), used when the GUI syncs
roles to `~/.claude/agents`.

## What the GUI can never change

`GUI_IMMUTABLE_SETTINGS` lists dotted prefixes that can only be set via the config file or
environment — never the web GUI or its socket/REST API, because they control network exposure,
secrets, filesystem paths, or code execution:

- `server` (the whole section)
- `storage.dbPath`
- `paths` (the whole section)
- `runner` (the whole section)
- `auth` (the whole section)
- `receptionist.webSearch`, `receptionist.webFetch`, `receptionist.webFetchAllowDomains`,
  `receptionist.extraDenyReadGlobs`, `receptionist.allowTagconnDocs`, `receptionist.projectSafeMode`

The Settings tab still shows these — as a disabled, read-only field with a tooltip naming the file
or env var that controls it — rather than hiding them. Secret-shaped values (`server.hookToken`,
`runner.token`) are always returned masked (`********`) by the API, never their real value.

## Most useful keys, by section

| Section | Key | Default | Notes |
|---|---|---|---|
| `server` | `host` / `port` | `127.0.0.1` / `4317` | Restart required. Docker sets `host` to `0.0.0.0` internally only. |
| `server` | `hookToken` | `""` | Env shortcut `OFFICE_HOOK_TOKEN`. Empty = no hook auth (local-only). |
| `storage` | `eventRetentionDays` | `14` | How long raw hook events are kept. |
| `agents` | `staleAfterSec` | `900` | A live subagent with no events past this is presumed lost and marked done. |
| `agents` | `typeToRole` | `{general-purpose: developer, Explore: analyst, Plan: architect}` | Maps a Claude `agent_type` to a role when the names differ. |
| `heroes` | `enabled` | `true` | Off = anonymous characters (pre-M8 look), no persistent names. |
| `sessions` | `endAfterSec` | `1800` | A session with no events and no live subagents ends after this (covers a crashed CLI). |
| `office` | `style` | `guild` | `modern` \| `guild`. See [Display & shaders](display.md). |
| `office` | `floorOrder` | `created` | `created` \| `name` \| `recent` — stair order. |
| `office` | `shaders.*` | — | See [Display & shaders](display.md). |
| `office` | `pmMode` | `single` | `single` \| `per-session` — see [Using the office](office.md). |
| `notifications` | `onWaiting` / `onBlocked` / `onDone` | `true` / `true` / `false` | Browser notification triggers. |
| `runner` | `enabled` | `false` | GUI-immutable. `pnpm office:install --allow-dir` flips it on for you. |
| `runner` | `allowedProjectDirs` | `[]` | GUI-immutable. Where quests/project-scope Receptionist may run. |
| `runner` | `defaultModel` | `sonnet` | Pre-selects a model in the New quest form. |
| `receptionist` | `enabled` | `true` | Master switch. |
| `receptionist` | `webFetch` | `never` | GUI-immutable. `never` \| `allowlist`. |
| `auth` | `mode` | `pairing` | GUI-immutable. `pairing` \| `same-origin`. See [Pairing your browser](pairing.md). |
| `auth` | `protect` | `all-writes` | GUI-immutable. `all-writes` \| `execution`. |
| `attribution` | `autoImport` | `ask` | `ask` \| `auto` \| `off`. See [Attribution](attribution.md). |

Full field-by-field docs live as comments in `config/office.yaml` and as JSDoc comments on
`SettingsSchema` itself in `packages/shared/src/settings.ts` — this table is a starting point, not
the whole schema.

Next: [Troubleshooting](troubleshooting.md).
