---
name: tagconn-save
description: Save (or update) this project's tagconn office profile (.tagconn/office.json) - the floor's name, style, room layout and named heroes - from the running tagconn server. Use when the user asks to "save the office profile", "export the floor", "commit the office layout", or similar, in a repo that already has (or wants) a .tagconn directory.
---

# Save the tagconn office profile

tagconn (a local tool that shows this Claude Code session as a character in a 2D office) can save a
portable snapshot of this project's floor into `.tagconn/office.json`, so anyone who clones the repo
and opens it with tagconn sees the same floor. See `.tagconn/README.md` if one already exists.

This skill does the export **through the CLI's own Write tool**, not through a host-side write from
the server or runner, so the normal Claude Code permission prompt applies - you approve the write
like any other file change.

## Steps

1. Fetch the export for this project's working directory:
   ```
   GET <server url>/api/attribution/export?cwd=<absolute path to this repo>
   ```
   The server URL defaults to `http://127.0.0.1:4317` (the same one `pnpm office:install --url`
   points the hook at; check `.env`'s `OFFICE_PORT` if unsure). This is a public, read-only endpoint -
   no token needed. If the request fails (connection refused, 404, or a body that fails to parse as
   JSON), tell the user tagconn's server isn't reachable or the project isn't registered yet, and
   stop.
2. The response body is the profile JSON (matching `AttributionProfileSchema` in
   `packages/shared/src/attribution.ts`): `kind`, `version`, `tagconnVersion`, `savedAt`, `floor`,
   an optional `layout`, and `heroes`. Pretty-print it (`JSON.stringify(profile, null, 2) + '\n'`).
3. If `.tagconn/office.json` already exists, read it and show the user a short diff summary (what
   changed: floor name/style, whether the layout changed, heroes added/removed/renamed) before
   writing.
4. Use the **Write** tool to write the pretty-printed JSON to `.tagconn/office.json` in this repo's
   root (create `.tagconn/` first with a plain directory write/mkdir if it doesn't exist yet). Do
   not use curl, `cat > file`, or any other route that bypasses the tool-use permission prompt.
5. If `.tagconn/README.md` doesn't exist yet, mention to the user that they can get one by opting in
   during `pnpm office:install` (interactive: answer "y" to the README prompt; non-interactive:
   `--attribution yes`) - this skill does not write the README itself.
6. Tell the user what was written and that both files are safe to commit (no secrets, no
   host-specific paths - the server already validates this before returning the export).
