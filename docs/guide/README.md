# tagconn user guide

tagconn shows your Claude Code sessions and subagents as characters in a 2D pixel office. This
guide is for using the running app day to day — for the project's architecture and internals, see
[docs/architecture.md](../architecture.md) and [docs/decisions.md](../decisions.md) instead.

## Pages

1. **[Getting started](getting-started.md)** — install, start the stack, dev mode, the no-server
   demo, uninstall.
2. **[Pairing your browser](pairing.md)** — why viewing is public but changing anything needs a
   paired admin session, every way to get a pairing code, and troubleshooting.
3. **[Runner & quests](runner-and-quests.md)** — the host runner that lets the browser run Claude
   for you, and the Quests tab.
4. **[The Receptionist](receptionist.md)** — the read-only help desk NPC you can chat with.
5. **[Using the office](office.md)** — floors, stairs, the Multiverse, heroes, the Hall Planner,
   notifications, settings.
6. **[Attribution](attribution.md)** — the `.tagconn/` marker, saving and importing a project's
   office profile.
7. **[Display & shaders](display.md)** — visual styles, WebGL post-processing, and the screen
   effects/vignette work landing in the next release.
8. **[Configuration](configuration.md)** — how settings layer, what the GUI can't change, and the
   most useful keys.
9. **[Troubleshooting](troubleshooting.md)** — the doctor script and common problems.

## The 5-minute path

This is the shortest route from a fresh checkout to talking to the Receptionist.

1. **Start the stack.**

   ```sh
   pnpm install
   pnpm office:up
   ```

   This builds and starts the server (`:4317`) and web app (`:4318`) with Docker Compose, both
   bound to `127.0.0.1`. See [Getting started](getting-started.md) for the dev-mode alternative
   (`pnpm dev`).

2. **Install the hooks.**

   ```sh
   pnpm office:install --allow-dir /path/to/a/project
   ```

   This wires Claude Code's hooks to the server, writes a local hook token, and — because
   `--allow-dir` was passed — enables the host runner for that project directory too (the runner
   and Receptionist otherwise have nowhere to run). See [Getting started](getting-started.md) for
   every flag.

3. **Open the office.** Visit <http://localhost:4318>. You'll see an empty floor — nothing to
   watch yet.

4. **Pair this browser.** The server printed a pairing code at boot (check `docker logs
   tagconn-server-1`, or your `pnpm dev` terminal). Click **Locked** in the top bar, paste the
   code, and click **Pair**. See [Pairing your browser](pairing.md) for every way to get a code.

5. **Start the runner.**

   ```sh
   pnpm office:runner -- --config ~/.config/tagconn/runner.json
   ```

   Leave this running in its own terminal. It's what actually spawns `claude -p` on your machine
   for quests and the Receptionist. See [Runner & quests](runner-and-quests.md).

6. **Ask the Receptionist.** Click **Receptionist** in the top bar, start a **General** or **This
   project** conversation, and ask it something — "what does this repo do?" is a good start. See
   [The Receptionist](receptionist.md).

Meanwhile, run `claude` in the project directory you allowed in step 2 — its session and any
subagents will appear as characters on that project's floor, no pairing or runner required (viewing
is always public; see [Pairing your browser](pairing.md) for why).
