# Contributing

Thanks for helping build tagconn! Start with [CLAUDE.md](CLAUDE.md) (conventions and layout),
[ROADMAP.md](ROADMAP.md) (what's next) and [docs/](docs/).

## Development
```sh
pnpm install
pnpm dev                 # server :4317 + web :5173 (demo: http://localhost:5173/?demo=1)
pnpm typecheck && pnpm test && pnpm build
```
- Contract first: change `packages/shared` before the server or the web app.
- Keep the security guarantees listed in CLAUDE.md, and add tests for new endpoints.
- Never run installer tests against your real `~/.claude`. Use `--claude-dir` / `--config-dir` sandboxes.

## Commits
Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(web): …`, `fix(server): …`, `docs: …`,
`test: …`, `chore: …`. Add user-facing changes to the `## [Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) in the same PR.

## Versioning
tagconn follows [SemVer](https://semver.org/) with **one version for the whole monorepo** (every `package.json` moves together).
While the version is below 1.0.0, minor versions may contain breaking changes to the settings schema or the socket/REST contract.

Releasing (maintainers):
```sh
pnpm release minor --dry-run   # preview
pnpm release minor             # bumps every package.json, moves Unreleased notes into CHANGELOG, commits, tags vX.Y.Z
git push --follow-tags
```
The server reports its version at `GET /api/health`.
