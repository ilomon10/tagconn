# CLAUDE.md: tagconn (Pixel Office)

tagconn shows Claude Code sessions and their subagents as characters in a 2D "Sims-style" software
office. It is an **observer**: Claude Code hooks POST events to a local server, and the server
streams state over socket.io to a React + Phaser web app. **No Anthropic API key is used.** The user runs
the Claude Code CLI with a browser login. The planned v2 runner will spawn `claude -p` on the host.

## Start here in a new session
1. Read `ROADMAP.md`: the live checklist of what is done, in progress, or todo. Keep it updated as you work.
2. Read `docs/architecture.md` for the design and `docs/decisions.md` for why things are the way they are.
3. The approved plan: `~/.claude/plans/let-we-brainstorming-i-elegant-abelson.md`.

## Commands
- `pnpm install`: install everything. pnpm 11; native builds are allowed in `pnpm-workspace.yaml` → `allowBuilds`.
- `pnpm dev`: server (tsx watch, :4317) + web (vite, :5173). Demo without a server: `http://localhost:5173/?demo=1`.
- `pnpm typecheck` · `pnpm test` · `pnpm build`: turbo across all packages (`pnpm test` also runs `pnpm test:scripts`). Filter with `pnpm --filter @tagconn/server test`.
- `pnpm office:install` / `office:uninstall` / `office:doctor`: install hooks, role agents, and skills into `~/.claude`.
  This edits the user's real `~/.claude/settings.json` (a backup is made first). Ask before running it.
  For tests, ALWAYS sandbox: `node scripts/install.ts --claude-dir /tmp/.../.claude --repo-env-file /tmp/.../.env`
  (the config dir is then derived as `/tmp/.../.config/tagconn`; override with `--config-dir` / `TAGCONN_CONFIG_DIR`),
  and run `claude -p "<prompt>" ... --settings <sandbox>/.claude/settings.json`. Put the prompt right after `-p`, because
  `--allowedTools` is variadic and swallows a trailing prompt.
- `pnpm office:up` / `pnpm office:down` (not `pnpm up`, which is pnpm update): docker compose (server :4317, web :4318, bound to 127.0.0.1).

## Layout
```
apps/server      Fastify modular monolith (core/ + modules/<feature>/), socket.io, SQLite via Drizzle
apps/web         React + Vite + Tailwind 4 + Phaser 3 (features/, game/, stores/, lib/)
apps/runner      (v2, not started) host daemon spawning `claude -p --output-format stream-json`
packages/shared  THE CONTRACT: zod hook schema, domain types, roles, settings schema, typed socket events
packages/hook    office-hook.sh (sh + curl; always exits 0 and prints nothing)
packages/agent-templates  roles/*.md (default staff) + skills/*/SKILL.md
scripts/         install.ts, doctor.ts (Node 24 native TS, node: builtins only)
config/office.yaml  example config; docker/  Dockerfiles + nginx
apps/server/test/fixtures/  REAL hook payloads captured from Claude Code; use them for tests
```

## Conventions
- **Contract first**: change `packages/shared` before server or web. Never rename existing fields silently.
  After any shared change run the ROOT `pnpm typecheck` (not just the shared package) before committing, and avoid
  zod `.default()` inside schemas used for both input and stored types (it makes input and output types differ).
- Server modules are encapsulated `fastify-plugin`s with the same files: `index.ts`, `*.routes.ts`,
  `*.service.ts`, `*.repository.ts`, `*.schema.ts`, `*.socket.ts`, `__tests__/`. Modules talk
  through the typed **event bus** (`core/event-bus`), not by importing each other's internals.
  Dependencies are wired through awilix (`core/di`).
- **Everything is configurable**: add new options to `SettingsSchema` (with a default), never as
  hard-coded constants. Layers: schema defaults → `config/office.yaml` → env `OFFICE_<SECTION>__<KEY_SNAKE>`
  → runtime overrides in the DB (GUI). Keys that need a restart go in `RESTART_REQUIRED_SETTINGS`.
- Files written into `~/.claude/agents` carry `<!-- managed-by: tagconn -->`. Managed skill dirs contain
  `.tagconn-managed`. Never modify or delete unmanaged files.
- The hook must never break Claude Code: it always exits 0, writes no stdout, and uses a ~1s timeout.
  Its URL and token live in `~/.config/tagconn/curl.conf` (0600, read with `curl -K`), never on argv.
- **Security model (local tool)**: the server binds 127.0.0.1 (compose sets 0.0.0.0 inside the container only),
  rejects a foreign `Host` (DNS rebinding) or a foreign `Origin` (REST writes and the socket.io handshake), accepts only
  JSON bodies, and redacts secrets from the whole hook payload. Settings under `GUI_IMMUTABLE_SETTINGS`
  (`server.*`, `storage.dbPath`, `paths.*`, runner permissions) can only be set via file or env; the API rejects them.
  `hookToken` is always returned masked. Keep these guarantees when adding endpoints; regression tests are in
  `apps/server/src/core/http/__tests__/security.test.ts`.
- REST errors are `{ error, statusCode, details? }`. Settings patches deep-merge section objects;
  arrays and record maps (`agents.typeToRole`, `office.zones`) are replaced wholesale.
- Scripts in `scripts/` use erasable TS only (no enums or namespaces) so `node file.ts` runs them.
- TS is strict with `noUncheckedIndexedAccess`. Tests use vitest.

## Git, versioning, releases
- Public repo: https://github.com/ilomon10/tagconn (MIT). Branch `main`. Conventional Commits.
- **No Claude/AI attribution** in commit messages or PR bodies (the maintainer's explicit rule).
- Lockstep SemVer across all packages; record user-facing changes under `## [Unreleased]` in `CHANGELOG.md`.
  Release with `pnpm release <patch|minor|major>` (bumps, changelog, commit and tag; it never pushes), then `git push --follow-tags`
  and `gh release create vX.Y.Z --notes-file <section>`. Planned: M7 Guild Hall → v0.2.0.
- The PM commits after each verified wave; never commit a tree while subagents are mid-edit.

## Working style for this repo (virtual software house)
Use the project subagents in `.claude/agents/` (analyst, architect, developer, qa-engineer,
code-reviewer, security-engineer). The main session acts as PM. It splits work into small, file-disjoint
tasks, runs developers in parallel, then runs QA, review, and security in parallel, and records
progress in `ROADMAP.md`. Every subagent ends its reply with a ```handoff block
(see `packages/agent-templates/skills/handoff-report`).
