# Pairing your browser

## Why pairing exists

Anyone who can open the office web app can **watch** it — the floor, the characters, the roster,
even the quest board and Receptionist transcripts render for free. That's on purpose: tagconn is a
local, single-user tool, and viewing is harmless.

But two things in the browser can make your machine actually *do* something:

- **Quests** (the Quests tab) start a real `claude -p` process on your host, in a project directory
  you allow, with your subscription login.
- **The Receptionist** does the same, read-only.

And a handful of other actions — changing settings, saving a layout, editing a hero — are also
gated by default (see `auth.protect` below).

So before any of that is allowed, the browser has to prove it's *you*: an **admin session**. Once a
tab has one, it can start Claude processes on your behalf. The pairing dialog says this plainly:
**an admin session means code execution as the host user** — only pair a browser you trust with
that.

## Getting a pairing code

A pairing code is a short, single-use code (`ABCD-EFGH-JKMN`, 12 case-insensitive characters) that
proves you have access to the *host* — the runner token in `~/.config/tagconn/runner.json` — not
just the web page. There are two ways to get one.

### 1. The boot log

Every time the server starts, if `auth.mode` is `pairing` (the default) and no admin session is
currently active, it logs a fresh code:

```sh
docker compose logs server     # docker
# or, if you know the container name: docker logs tagconn-server-1
# or: your `pnpm dev` terminal
```

The log line includes the code, a ready-to-click URL (`http://localhost:4318/#pair=ABCD-EFGH-JKMN`
— the first entry of `server.corsOrigins`), and its expiry time. Opening that URL in the browser
you want to pair auto-opens the pairing dialog with the code already filled in (the `#pair=...`
fragment is read once and then stripped from the address bar immediately, so it never lingers in
history or gets sent in a `Referer` header).

If an admin session is already active when the server boots, it does **not** print a new code —
see [Troubleshooting](#troubleshooting) if you need one anyway.

### 2. `pnpm office:pair`

```sh
pnpm office:pair
```

Mints a fresh code any time, without restarting the server. It reads the runner token straight out
of `~/.config/tagconn/runner.json` (so it needs that file to exist and be mode `600` — run
`pnpm office:install` first if it doesn't) and proves possession of it to the server over a mutual
HMAC challenge-response: the server proves it holds the same token *before* the script asks it to
mint a code, and refuses to continue on any mismatch (wrong URL, wrong token, or an impersonator).
The raw token itself is never sent over the wire.

It also runs a "squatter" check by default: it compares the server's `instanceId`/version (from
`/api/health`) as seen directly and as seen through the web origin, and refuses to print the code
at all if they don't match or the printed URL's origin doesn't match `--web-url` — something else
might be answering on the web port. Skip it with `--no-squatter-check` only if you're certain
that's safe.

```
node scripts/pair.ts --help
```

| Flag | Meaning |
|---|---|
| `--config-dir <path>` | Dir holding `runner.json` (default `$TAGCONN_CONFIG_DIR` or `~/.config/tagconn`). |
| `--url <server url>` | Office server URL (default `http://127.0.0.1:4317`). |
| `--web-url <web url>` | Browser-facing origin, for the squatter check (default `http://localhost:4318`). |
| `--label <text>` | **Not** sent when minting the code (the endpoint takes no label) — it's a reminder to type the same label into the browser's pairing form when you redeem the code. |
| `--no-squatter-check` | Skip the origin/instanceId comparison above. |

Output looks like:

```
Pairing code: ABCD-EFGH-JKMN
Open: http://localhost:4318/#pair=ABCD-EFGH-JKMN
Expires in 600s.
```

### Expiry

A code lives for `auth.pairingCodeTtlSec` seconds (default **600** — 10 minutes) and is single-use:
redeeming it (or letting it expire) invalidates it. Mint a new one with either method above if it
expires before you use it.

## Entering the code

In the top bar, an unpaired browser shows a **Locked** badge. Click it (or open the `#pair=...`
link, which does this for you) to open **Pair this browser**:

1. **Pairing code** — paste the code (dashes optional).
2. **Label (optional)** — free text shown later in the sessions list, e.g. "Firefox on laptop".
3. **Remember on this device** — checked, the admin token is stored in `localStorage` (survives
   closing the tab/browser); unchecked (the default), it's stored in `sessionStorage` (cleared when
   the tab closes). `localStorage` is the more valuable target for an XSS attack, which is why it's
   opt-in rather than the default.
4. Click **Pair**.

Once paired, the badge turns into **Admin** (green dot). Click it to open a small menu:

- **Sessions…** — opens the sessions panel (below).
- **Log out** — ends this browser's admin session immediately.

### `auth.mode: same-origin`

This is a file/env-only setting (see [Configuration](configuration.md)), not something you toggle
from the browser. In `same-origin` mode there's no code at all — the pairing dialog just shows a
single **Enable admin access** button (still with the same "code execution as the host user"
warning and label field), because the server trusts any request that already shares its origin.
Use this only if you understand the trade-off; `pairing` (the default) is safer for most setups.

## Sessions panel

Lists every active admin session: its label (or a truncated User-Agent, or its id), whether it's
**this browser**, when it was last used, and when it expires. Each row has its own **Revoke**
button, and the header has a **Revoke all** button. Revoking a session (including your own) drops
its admin status immediately — the paired browser gets pushed an `auth:changed` event and falls
back to **Locked**.

## Expiry & session settings

All of these are under `settings.auth` and are **GUI-immutable** — file or environment only, never
the web GUI or API (see [Configuration](configuration.md) for the layering). Their env-var form is
`OFFICE_AUTH__<KEY_SNAKE>`.

| Key | Default | Meaning |
|---|---|---|
| `auth.mode` | `pairing` | `pairing` or `same-origin` (see above). |
| `auth.protect` | `all-writes` | `all-writes`: every write (settings, layouts, roles, hero edits, ...) needs an admin session. `execution`: only actions that run Claude (quests, the Receptionist, role sync) need one — cosmetic writes are open. |
| `auth.sessionIdleHours` | `72` | A session expires after this many hours with no use (sliding). |
| `auth.sessionMaxAgeDays` | `30` | Absolute cap on a session's age, regardless of use. |
| `auth.pairingCodeTtlSec` | `600` | How long a minted code stays redeemable. |
| `auth.maxSessions` | `10` | Cap on concurrently active admin sessions. |
| `auth.logPairingCodeOnBoot` | `true` | Whether the server logs a fresh code at startup (only when `mode` is `pairing` and no session is currently active). |

## Troubleshooting

- **"Pair this browser to make changes"** — shown the moment you try an admin-gated action (saving
  settings, a layout, a hero, starting a quest…) in a browser that isn't paired, and it opens the
  pairing dialog for you. It also appears if your session expired or was revoked since the page
  loaded (the server silently ignores the action, so the browser says "pair" instead of a bare
  timeout). Just pair.
- **"Code expired" / the code from a stale terminal doesn't work** — mint a new one
  (`pnpm office:pair`, or restart the server to get a fresh boot-log code, but only if no session is
  currently active — see below).
- **No code in the boot log** — the server only logs one when `auth.mode` is `pairing` **and** no
  admin session is currently active. If you're locked out anyway (lost the paired browser, revoked
  your own session by mistake), run `pnpm office:pair` instead — it always mints a fresh code
  regardless of active sessions.
- **A new code after restart** — codes live only in the server's memory, so a restart invalidates
  every unused code. It then logs a fresh one if no admin session is active; use that one (or
  `pnpm office:pair`).
- **`pnpm office:pair` fails with "Pairing is disabled: settings.runner.token is not configured"** —
  the server has no runner token. Run `pnpm office:install` (it writes `OFFICE_RUNNER__TOKEN` into the
  repo `.env`), then **recreate** the server with `pnpm office:up`. `docker compose restart` is not
  enough: it keeps the container's old environment. Until then, pair with the boot-log code
  (`docker compose logs server | grep "pairing code"`).
- **`pnpm office:pair` fails with "runner.json not found"** — run `pnpm office:install
  --allow-dir <path>` first; pairing needs the runner token even if you never intend to enable the
  runner itself.

Next: [Runner & quests](runner-and-quests.md).
