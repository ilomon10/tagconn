# Using the office

## Floors and stairs

Each registered project gets its own floor. A floor is the **repository**: the hook sends the
session's git root, so a session that starts in `repo/apps/web` or later `cd`s there stays on the
`repo` floor, together with its subagents. A session stays on the floor it started on.

When the hook first confirms a folder is a git root, older floors for its subfolders (from before
v0.5.2) are merged into it. Before each merge the server saves a copy of the database next to it
(`office.db.pre-merge-<time>.bak`, readable only by you, newest 3 kept); to undo a merge, stop the
server and put that copy back. Only confirmed git roots absorb floors, and never your home folder or
a folder directly inside it (`~`, `~/Projects`, `C:\Users\you\source`), so a session started in
`~` or a plain workspace folder never swallows your other repos. A separate git repo nested inside
another keeps its own floor. The dropdown at the top left switches floors and shows
a live character count; **Manage** opens [Manage floors](#manage-floors-f). Next to it, a small pill
shows **Floor N / M — name** with up/down buttons that run the same animated transition as walking
onto in-scene stairs.

| Key | Action |
|---|---|
| `Page Up` / `Page Down` | Go to the neighboring floor (in `office.floorOrder`). From the top floor, `Page Up` continues into the Multiverse; from the Multiverse, `Page Down` returns to the top floor. |
| `Home` | Jump to the first floor. |
| `End` | Jump to the top *project* floor (never the Multiverse). |
| `F` | Open **Manage floors**. |
| `M` | Open the **Menu** (see below). |
| `B` `L` `Q` `R` `S` | Open Board, Log, Quests, Roles, Settings as panels over the office. |
| `H` | Open the [Heroes](#heroes-h) panel for the current floor. |
| `P` / `D` | Open the Hall Planner / the Receptionist's desk. |
| `V` | Turn the [screen effect](display.md#screen-effect-per-browser) on or off for this browser. |
| `[` / `]` | Select the previous / next character on this floor (same order as the roster). The drawer opens and screen readers announce who is selected. |
| `?` | Show every keyboard shortcut (also **Keyboard shortcuts** in the menu). |
| `Esc` | Close the panel on top (a Board/Log/Quests/Roles/Settings panel, Manage floors, the sessions popover, the shortcuts list, then the character drawer). |

## The top bar and menu

The top bar is small on purpose: the floor picker (with floor up/down), your connection and admin
status, and one **Menu** button. The menu lists everything else, each with its hotkey: Board, Log,
Quests, Roles, Settings, Heroes, Hall Planner, Receptionist, Manage floors, the screen effect,
alerts and the shortcut list. Board, Log, Quests, Roles and Settings open as panels over the office
(the canvas stays mounted behind them), and `#board`, `#log`, `#quests`, `#roles` and `#settings`
still deep-link to them; `Esc` closes the top panel.

On a phone the panels are full-screen sheets in portrait and side sheets in landscape, the
character drawer is a bottom sheet, and the roster is a **Roster** pill that opens a tray over the
full-width canvas. Tablets and desktops keep centred dialogs, the right-hand drawer and, on wide
screens, the docked roster.

Hotkeys are ignored while you're typing in a text field, while a modal (Hall Planner, Heroes,
Receptionist, ...) is open, or mid-transition.

## The Multiverse

A special floor above the top project floor, generated fresh every time from your live projects: a
central Nexus with one **realm** per active project (painted in that project's own style), joined
by a blended "rift" style. Click a realm to travel straight to its floor; an overflowing "Other
realms" bucket opens the floor picker instead. It's capped by `office.multiverseMaxRealms` and
`office.multiverseMaxCharacters` (characters are split fairly across realms, Guild Masters first).

## Party bar and character selection

The **party bar** at the bottom shows one portrait chip per character on this floor, in roster order
(so `[` / `]` cycling moves left and right along the bar). Each chip displays a portrait, role colour
ring, status dot (showing whether the character is `active`, `waiting`, `blocked`, or `done`), and a
strain icon when the character is experiencing work strain (see below). Selected chips are raised.
On a phone, the bar collapses to a pill that opens a tray showing all characters in a grid.

Click any character's chip or portrait on the map to select them and open the **status card** at the
top-left:
- Character name (or themed title if no hero is named)
- Status badge and plain role title (when it differs from the themed title)
- **Mana** bar (context window use: `contextTokens` / `contextWindowFor(model)`)
- **XP** display (total tokens used) with **Lv** level (1–99, based on tokens)
- Current **Tool** and how long it has been running (if any)
- **Quest** time (how long this agent has been on this floor's quest)
- Work strain description (e.g., "Dizzy · tool running 2m 10s")
- **Details** button to open the full agent panel (activity, recent tool calls, task board, Edit hero link)
- **Follow** checkbox to keep the camera centered on this character as it moves
- Close button (or press `Esc`)

On a phone, the status card compresses to one row: portrait, name, mana bar, Details button, and
close. Press `Esc` again to deselect the character. Click empty map space to deselect.

Idle characters with no live agent rest in a lounge/tavern zone, and leave (walk out) after
`office.idleLeaveSec`. One project can have several live sessions at once — the most recently active
one is the floor's "Guild Master"; the rest collapse into a small "+N sessions" chip you can click
to switch which one the Guild Master represents (`office.pmMode: single` — the default — vs
`per-session`, which shows every session as its own character).

## Idle drama and work strain

When characters have downtime (waiting in the lounge or tavern), they interact with their
surroundings. Roughly every `office.drama.idleChatSec` (45 s default) per floor, one or two idle
characters walk to a piece of furniture (water cooler, coffee machine, tavern counter, fireplace,
etc.) and perform a short scene: speech bubbles in turn and a small emote icon (mug, dice, phone,
laugh, etc.), then walk back to their seat. In the **modern** style, they chat about work and
office life; in the **guild** style, they bandy tavern tales and quest banter. Dramatic antics occur
only when `office.drama.enabled` is `true` (default).

Characters on an active quest show **work strain** when they run into trouble:

| Strain | Icon | Shows when | Setting |
|---|---|---|---|
| **Tired** | Yawn | On a quest longer than `office.drama.tiredAfterSec` (default 20 min) | `office.drama.tiredAfterSec` |
| **Dizzy** | Spinning stars | A single tool runs longer than `office.drama.dizzyToolSec` (default 90 s) | `office.drama.dizzyToolSec` |
| **Sweating** | Sweat drop | Waiting on you or blocked longer than `office.drama.sweatAfterSec` (default 2 min) | `office.drama.sweatAfterSec` |
| **On a roll** | Flame | Made >= `office.drama.streakTools` tool calls (default 8) within `office.drama.streakWindowSec` (default 60 s) | `office.drama.streakTools`, `office.drama.streakWindowSec` |

When a strain icon appears, the character also speaks a strain line (e.g., "Still compiling..." for
dizzy, "Ship it!" for on a roll). These lines come last in the speech-bubble priority, so if a server
message arrives, it takes precedence. Turn off `office.drama.enabled` to hide antics and strain,
though status icons will still show. Turning off `office.ambientEffects` hides the motion and
particle effects but keeps icons and speech.

You cannot disable ambient effects by themselves: they respect your system's **reduced motion**
preference (`prefers-reduced-motion: reduce`). Antics play in place (no walking) when reduced motion
is on.

## Furniture triggers

Some furniture on each floor opens UI panels when clicked — a **Kanban board** (modern style) or
**War map** (guild style) opens the Board, a **Bookcase** or **Guild ledger** opens the Log, and so
on. Hover over any furniture to see what it opens (e.g., "Quest board · Open Quests (Q)"). The first
time you approach a trigger, it pulses gently to catch your eye. Click to open the panel, or use the
menu hotkey instead (B, L, Q, S, H, D) — the furniture is purely visual.

| Furniture | Panel | Hotkey | Modern label | Guild label | Rift label |
|---|---|---|---|---|---|
| **Kanban board** / War map / Star chart | Board | B | Kanban board | War map | Star chart |
| **Bookcase** / Guild ledger / Archive crystal | Log | L | Bookcase | Guild ledger | Archive crystal |
| **Notice board** / Quest board / Bounty shard | Quests | Q | Notice board | Quest board | Bounty shard |
| **Server console** / Arcane terminal / Rift console | Settings | S | Server console | Arcane terminal | Rift console |
| **Team roster** / Hall of Heroes / Hero constellation | Heroes | H | Team roster | Hall of Heroes | Hero constellation |
| Reception desk / Gatekeeper's desk / Nexus gate desk | Receptionist | D | Reception desk | Gatekeeper's desk | Nexus gate desk |

The ☰ menu (hotkey `M`) lists every panel with its hotkey; furniture triggers are just a shortcut
for the impatient. Turn off `office.furnitureTriggers` in Settings to hide the hover rings and
disable clicking.

## Heroes (`H`)

Named, persistent characters bound to a project + role, so a subagent's "actor" keeps the same name
and look across restarts instead of spawning a fresh anonymous sprite. Open it from **Heroes** in the
menu, the `H` hotkey, or "Edit hero" in a character's detail drawer.

- **Roster tab** — per floor: recruit a new hero for a role, then edit its name, title, skin, hair,
  outfit color, hat/costume, prop and accessory with a live preview; **Roll name** picks a new one
  from the role's name pool; **Reset** restores the seeded name/look; a hero can only be **deleted**
  once released (no live agent bound to it).
- **Name pools tab** — edit which names each role can be assigned, per project.

`Ctrl/Cmd+S` saves whichever tab is active; closing with unsaved changes asks to confirm.

## Hall Planner

Opens from **Hall Planner** in the menu (`P`), or "Edit floor" in Manage floors. Draw and
edit a floor's room layout: rectangular rooms with a type (office, lounge, QA lab, server room,
...), doors, and live validation (a room the reachability checker can't reach from the stairs is
flagged with a one-click fix). "Surprise me" generates a random layout; a live preview renders it in
either visual style before you save.

| Key | Action |
|---|---|
| `V` / `R` / `S` / `D` / `F` / `H` (or Space) | Select / Room / Stairs / Doors / Furniture / Hand tool |
| Drag (Room/Stairs tool) | Draw a room; release to pick its type |
| `1`–`9`, `0` | Pick a room type from the popover |
| Click / Shift+click | Select / add to selection |
| Drag a selected room's body | Move the selection |
| Drag a resize handle | Resize the selected room |
| Arrows / Shift+Arrows | Nudge the selection by 1 / 5 tiles |
| Alt+Arrows | Resize the selected room by 1 tile |
| Delete / Backspace | Delete the selection |
| Ctrl/Cmd+D | Duplicate the selected rooms |
| Doors tool: click a wall | Add a door (Shift+click for width 2) |
| Doors tool: drag a door | Move it along its wall |
| Doors tool: drag its end handle | Resize it (width 1–3) |
| Doors tool: select + Delete | Remove a door |
| Doors tool: select + Arrows | Nudge a door along its wall |
| Furniture tool: click a furniture item | Select it (shows kind, position, size; buttons to Lock or Release) |
| Furniture tool: drag a selected item | Move it (or Lock it in place if it is not already pinned) |
| Furniture tool: Arrows | Nudge the selected pin by 1 tile (Shift+Arrows = 5 tiles) |
| Furniture tool: Delete | Release a locked pin back to procedural generation |
| Room section: **Lock all** | Lock every pinnable generated furniture in the room (limit 48 per room) |
| Room section: **Release all** | Release all locked furniture in the room to procedural generation |
| Ctrl/Cmd+Z | Undo |
| Ctrl/Cmd+Shift+Z or Ctrl+Y | Redo |
| Ctrl/Cmd+G | "Surprise me" (random layout) |
| `P` | Toggle the styled preview |
| Ctrl/Cmd+S | Save (blocked while validation errors exist) |
| `?` | Show this help |
| Esc | Cancel the open popover, then clear the door/room selection, then close |

**Room furnishing:** while a room is selected, the Inspector panel shows:
- Desk count, seat count, density, decoration amount, and aisle width (controls for procedural generation)
- Re-roll seed (change to shuffle the layout)
- Number of locked furniture items and buttons to **Lock all** / **Release all**

Locked furniture (marked with a **padlock** 🔒 icon on the canvas) stays in place when you change
the seed or regenerate. Generated furniture can be dragged to lock in place; once locked, locked
furniture can be nudged with arrow keys or dragged to a new position. Reachability checking is
shown as an overlay while a room is selected.

## Manage floors (`F`)

Lists every floor: rename, archive/unarchive (archived floors are hidden from the floor picker by
default — toggle "Show archived" to see them), and jump straight into the Hall Planner for a
specific floor with **Edit floor**.

## Notifications

Click **Enable alerts** in the menu (shown only until you grant or deny permission) to allow
browser notifications for agent state changes, controlled by **Settings → Notifications**:

| Key | Default | Meaning |
|---|---|---|
| `notifications.onWaiting` | `true` | An agent is waiting on you (`AskUserQuestion`/`ExitPlanMode`). |
| `notifications.onBlocked` | `true` | An agent is blocked. |
| `notifications.onDone` | `false` | An agent finished. |

## Settings panel

The **Settings** tab exposes most of `SettingsSchema` grouped by section (Server, Storage, Ingest,
Paths, Agents, Heroes, Sessions, Transcripts, Activity rules, Office, Notifications, Runner,
Receptionist, Admin access, Attribution). Keys the GUI can't change (see
[Configuration](configuration.md)) render as a read-only, disabled field with a tooltip naming the
config file/env var that controls them instead. A **restart required** badge marks keys that only
take effect after the server process restarts.

Next: [Name plates](name-plates.md).

## Accessibility

- Everything in the office can be reached from the keyboard: `[` / `]` move between characters, and
  dialogs keep keyboard focus inside until you close them, then give it back to where you were.
- Characters, stairs and realm areas keep a click area of at least about 24 screen pixels however far
  you zoom out.
- With your system's **reduced motion** setting on, characters stop fading, glows stop pulsing, the camera
  jumps instead of gliding, and the screen effects hold still.
- Text meets WCAG AA contrast (4.5:1) on the dark panels.

