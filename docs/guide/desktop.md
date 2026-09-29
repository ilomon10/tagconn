# tagconn Desktop

(v0.5.0, in development)

tagconn Desktop is a control panel app — like XAMPP — for Windows and Linux. When you open it, a setup
wizard checks your system, installs the hooks that connect Claude Code to tagconn, starts the
services, and then you can manage everything from the control panel: start/stop services, view logs,
and open the office.

## Download

[GitHub Releases](https://github.com/ilomon10/tagconn/releases) has builds for Windows and Linux (macOS is not supported yet):

- **Windows**: `tagconn_X.Y.Z_x64-setup.exe` (NSIS installer)
- **Linux**: `tagconn_X.Y.Z_x64.deb` (Debian/Ubuntu) and `tagconn_X.Y.Z_x64.AppImage` (any distro)

When you first run the Windows setup on an older machine, SmartScreen may warn "unknown publisher"
if the app is not code-signed. This is normal for small projects; click "More info" → "Run anyway"
to continue.

## First-run wizard

The first time you open the app, you'll see a setup wizard. It checks your system, installs the
hooks, and starts the services. You can re-run it anytime from the control panel's **Setup and
checks** button.

### Welcome

The wizard explains what tagconn does:

- It watches your Claude Code sessions (no API key, uses your existing CLI login).
- Everything runs on your computer, not the cloud.
- Any change can be undone from the app.

Click **Start setup** to continue.

### System check

The wizard runs checks for:

- **Claude CLI**: your `claude` executable and version.
- **Logged in**: `claude auth status` confirms you're logged in to Claude Code.
- **Git for Windows** (Windows only): needed if your Claude Code has Git tool access.
- **Port 4317**: the office server port; if it's busy, the wizard offers the next free port.
- **Config folder**: write access to where tagconn stores settings (varies by OS, see below).
- **Data folder**: write access to where the SQLite database lives.
- **Claude settings.json**: can read and write `~/.claude/settings.json`.
- **Hooks**: tagconn's hook entries in `settings.json`.
- **Docker** (optional): if you plan to use Docker mode instead of native services.
- **WebView2** (Windows only): the browser component the app window uses.
- **Runner platform** (Windows only): checks that Bash is not exposed as a tool on Windows (a safety
  limit).

A **✔** means everything is fine. A **⚠** (warning) won't stop you, but lists something to know. An
**✖** (failed) on a required check blocks moving forward; click the fix button next to it (or **Re-check**
after fixing it yourself), and try again. Optional checks like Docker can be skipped.

### Runner folders

Quests and the Receptionist can only run inside folders you list here. Without at least one, the
runner won't start quests.

Click **Add folder** and pick directories where your projects live. You can remove folders later.

**Attribution**: toggle "Write a small README into repos that use tagconn" if you want
`.tagconn/README.md` written to each repo that uses tagconn (off by default). See [Attribution](attribution.md).

### Install hooks

This step shows exactly which files the wizard will change:

- **Edits** `~/.claude/settings.json`: adds tagconn hook entries (your other settings are left
  alone).
- **Backup**: a copy is saved as `settings.json.tagconn-backup-<timestamp>` before anything is
  written, so you can restore it if needed.
- **Writes**: the hook script and a private token file into your tagconn config folder (varies by
  OS, see below), and the default staff roles and skills into `~/.claude/`.

If a write fails, the backup is restored automatically. The control panel's **Uninstall hooks**
button undoes everything.

Click **Install hooks** to proceed. You'll see a confirmation showing which files changed and where
the backup is.

### Start services

The server and runner services start here. The server (always needed) runs the office on
`127.0.0.1:4317`. The runner (optional) lets you run quests and the Receptionist from the office.

Click **Start all** to start them. The wizard checks that at least the server is running before
moving on.

### Done

The server is up and auto-paired with this app. Click **Open office** to open it in the app window,
or **Open in browser** to use your browser instead. Then click **Go to control panel** to close the
wizard.

## Control panel

After the wizard, the control panel shows:

### Services

A row per service (Server, Runner, and optionally Docker on Docker mode) with:

- **Status light**: green (running), yellow (starting/stopping), red (crashed), gray (stopped or
  unavailable).
- **Label**: "Server", "Runner", etc.
- **Restart count**: how many times it auto-restarted after a crash.
- **PID**: the process ID, if running.
- **Buttons**:
  - **Start**: only clickable when the service is stopped or crashed.
  - **Stop**: only clickable when running or starting.
  - **Restart**: only clickable when running.
- **Error message** (if crashed): the last error, e.g., "port 4317 in use; try port 4318".

If a service crashes, it auto-restarts with backoff (1 s → 30 s); after 5 crashes in 2 minutes it
gives up and turns red with the error shown.

Click **Start all** or **Stop all** at the top to manage all services together.

### Tools

**Logs**: opens a drawer showing the last ~100 lines from each service. Filter by service and follow
new output in real time. You can copy them for bug reports.

**Settings**: opens a dialog to change:

- **Run mode**: Native (default, recommended) or Docker. Takes effect the next time services
  start.
- **Server port**: the office URL is `http://127.0.0.1:<port>`. If you change it, the office URL
  and CORS origins follow. Restart the server to apply.
- **Start with system**: launch tagconn to the tray when you log in (Windows and Linux desktops that support autostart).
- **Start services when the app starts**: auto-start the server and runner (default on).
- **Open the office once the server is up**: auto-open the office window or browser (default on).
- **Data folder**: shows where the SQLite database lives (click "Settings" to customize, if needed).

**Setup and checks**: re-runs the wizard.

**Copy diagnostics**: collects your app version, platform, check results and recent redacted logs,
and copies them to the clipboard for pasting in a bug report.

**Check for updates**: looks for a new version and offers to install and restart (in release
builds only; dev builds don't have the updater).

**Uninstall hooks**: removes the tagconn hook entries from `settings.json` (a backup is made first)
and the tagconn staff roles/skills. Your other settings are left untouched. After this, Claude Code
won't report to tagconn, but the office and data stay in place (click Settings to restore later, or
delete the data folder by hand).

### Tray (system tray icon)

Right-click the tagconn icon in your system tray (bottom-right on Windows; on Linux it depends on your desktop, and some need an AppIndicator extension)
for:

- **Open office**: opens the office window (or browser).
- **Start all / Stop all**: quick toggle for services.
- **Quit**: closes the app and stops services.

## Where things live

### Windows

- **Config**: `%APPDATA%\tagconn` (usually `C:\Users\<username>\AppData\Roaming\tagconn`)
  - Includes hook token, runner config, and hook.json
- **State**: `%LOCALAPPDATA%\tagconn\state` (usually `C:\Users\<username>\AppData\Local\tagconn\state`)
  - Runtime state, including PID files
- **Data**: `%LOCALAPPDATA%\tagconn\data` (usually `C:\Users\<username>\AppData\Local\tagconn\data`)
  - SQLite database, transcripts, and session logs
- **Stable Node**: `%LOCALAPPDATA%\tagconn\node\node.exe`
  - A fixed version of Node.js used by the hook, so it keeps working even when you update
    tagconn

### Linux

- **Config**: `$XDG_CONFIG_HOME/tagconn` (default `~/.config/tagconn`)
- **State**: `$XDG_STATE_HOME/tagconn` (default `~/.local/state/tagconn`)
- **Data**: `$XDG_DATA_HOME/tagconn` (default `~/.local/share/tagconn`)
- **Stable Node**: `~/.local/share/tagconn/node/bin/node`

The node hook reads the URL and token from `hook.json` in the config dir (Windows uses an ACL, Linux uses `chmod 600`).

## Windows limitations

tagconn on Windows has a few structural limits, by design (see [Decision #28](../decisions.md#28)):

- **Bash is always denied** as a Claude Code tool (safety limit; the runner has nowhere to sandbox
  bash on Windows without specialized tools).
- **Quest permission mode capped at Accept Edits** (no Bash or PowerShell, so higher modes like
  Auto/Bypass Permissions gain no extra capability and introduce unnecessary risk).
- **Receptionist works in read-only mode** (it sees your exact tool set but has no sandbox
  (`bwrap`/`systemd-run` equivalents don't exist), so safety depends on the tool allowlist alone).
  The setup wizard shows a note about this.
- **Quests have a stricter deny list** (e.g. `AppData\Roaming`, `Documents\PowerShell\*profile.ps1`,
  and other Windows-specific sensitive paths are denied, in both path forms).

When you try to run a quest or Receptionist tool that's blocked, you'll see a plain-English
rejection (e.g., "Bash is not available on Windows"). This is the same guidance that appears on
Linux when `bwrap` or `systemd-run` are missing.

## Troubleshooting

### Setup check failed

The wizard will tell you what failed and offer a fix button. Common ones:

| Check | Issue | Fix |
|---|---|---|
| Claude CLI | `claude` not found or too old | Update Claude Code or add it to PATH |
| Logged in | `claude auth status` failed | Run `claude` once in a terminal and log in |
| Git for Windows | Not found (Windows only) | Link from the check; install it |
| Port 4317 | In use by another process | The wizard offers the next free port |
| Config/Data folders | No write access | Run the app as yourself, not as admin |
| settings.json | Parse error or locked | Fix the JSON or close another app using it |
| WebView2 (Windows) | Old OS | Windows 11 has it; Windows 10 needs download |

### Service crashed

If a service crashes and auto-restart fails, the control panel shows the error. Common causes:

| Error | Reason | Fix |
|---|---|---|
| `port_in_use` | Another app is using the server port | Close it or change the port in Settings |
| `docker_unavailable` | Docker isn't running or installed | Switch to Native mode or start Docker |
| `spawn_failed` | The runner couldn't start `claude` | Check `claude --version` works |
| `rolled_back` | The server crashed, and install rolled back | Check the logs for why |
| `install_failed` | Hook installation failed | Check file permissions in `~/.claude` |

If the **Service manager** (the sidecar supervisor) itself crashes, you'll see "Service manager
stopped" with its logs and a Retry button. This is rare; if it keeps happening, copy the
diagnostics and file an issue.

### Can't connect to the office

The server is running but the office won't load:

- Confirm the server status light is green.
- Check the server port in Settings matches your office URL.
- If you changed the port, restart the server.
- Look at the server logs (click **Logs** → filter by "server").

### Claude Code not reporting sessions

- Confirm the wizard says "Hooks: ok".
- Confirm `~/.claude/settings.json` has tagconn hook entries (the wizard shows you where).
- Run `claude` in a project you allowed in the wizard; new sessions should appear immediately.
- If not, check the server logs.

## Uninstall

To remove tagconn completely:

1. Open the app, go to the control panel, and click **Uninstall hooks**. This removes the hook
   entries from `~/.claude/settings.json` and the tagconn staff roles/skills. A backup is made first.
2. Close the app.
3. Use your OS uninstaller to remove the app:
   - **Windows**: Settings → Apps → Apps & features → tagconn → Uninstall.
   - **Linux (deb)**: `sudo apt remove tagconn` or use your package manager.
   - **Linux (AppImage)**: Delete the AppImage file.

Your projects, sessions, and office data stay in the `~/.local/share/tagconn` (Linux) or
`%LOCALAPPDATA%\tagconn\data` (Windows) folder. Delete them by hand if you want to clean up
completely.

## Docker mode

By default, tagconn runs the server and web app as native Node.js processes. If you prefer Docker,
go to Settings and switch to Docker mode.

When you do, the app will:

- Check that Docker is running.
- Start the docker-compose stack with published images from `ghcr.io/ilomon10/tagconn-server:<version>`
  and `ghcr.io/ilomon10/tagconn-web:<version>`.
- Otherwise behave the same (same control panel, logs, and settings).

The stack runs on the same ports (`:4317` for the server, internal `:5173` for the web app),
and the same rules apply: config and data in `~/.config/tagconn` and `~/.local/share/tagconn` /
`%APPDATA%\tagconn` and `%LOCALAPPDATA%\tagconn\data`.

## Updates

The app checks for updates automatically (if enabled in Settings). When a new version is available:

1. A dialog offers "Install and restart".
2. The app stops all services, downloads the update (its signature is verified), and installs it.
3. The app restarts with the new version. Config and data are untouched.

You can also check manually with the **Check for updates** button. Updates are only available in
release builds (not `tauri dev` dev mode).

Next: [Pairing your browser](pairing.md) to make changes to the office.
