# Using the office

## Floors and stairs

Each registered project gets its own floor. The dropdown at the top left switches floors and shows
a live character count; **Manage** opens [Manage floors](#manage-floors-f). Next to it, a small pill
shows **Floor N / M — name** with up/down buttons that run the same animated transition as walking
onto in-scene stairs.

| Key | Action |
|---|---|
| `Page Up` / `Page Down` | Go to the neighboring floor (in `office.floorOrder`). From the top floor, `Page Up` continues into the Multiverse; from the Multiverse, `Page Down` returns to the top floor. |
| `Home` | Jump to the first floor. |
| `End` | Jump to the top *project* floor (never the Multiverse). |
| `F` | Open **Manage floors**. |
| `H` | Open the [Heroes](#heroes-h) panel for the current floor. |
| `V` | Turn the [screen effect](display.md#screen-effect-per-browser) on or off for this browser. |
| `Esc` | Close whatever panel/drawer is open. |

Hotkeys are ignored while you're typing in a text field, while a modal (Hall Planner, Heroes,
Receptionist, ...) is open, or mid-transition.

## The Multiverse

A special floor above the top project floor, generated fresh every time from your live projects: a
central Nexus with one **realm** per active project (painted in that project's own style), joined
by a blended "rift" style. Click a realm to travel straight to its floor; an overflowing "Other
realms" bucket opens the floor picker instead. It's capped by `office.multiverseMaxRealms` and
`office.multiverseMaxCharacters` (characters are split fairly across realms, Guild Masters first).

## Roster & selection

The roster lists every character on the current floor (or, on the Multiverse, every project),
grouped and colored by role, with a status pill (`active` / `waiting` / `blocked` / `done`),
elapsed time and token usage. Click a character (in the roster or on the map) to open its detail
drawer: current activity, recent tool calls, its task board from the handoff report, and (for a
named hero) an "Edit hero" link into the Heroes panel. Click empty map space, or press `Esc`, to
close it. A **Follow** toggle keeps the camera centered on the selected character as it moves.

Idle characters with no live agent rest in a lounge/tavern zone, and leave (walk out) after
`office.idleLeaveSec`. One project can have several live sessions at once — the most recently active
one is the floor's "Guild Master"; the rest collapse into a small "+N sessions" chip you can click
to switch which one the Guild Master represents (`office.pmMode: single` — the default — vs
`per-session`, which shows every session as its own character).

## Heroes (`H`)

Named, persistent characters bound to a project + role, so a subagent's "actor" keeps the same name
and look across restarts instead of spawning a fresh anonymous sprite. Open it from the **Heroes**
button in the top bar, the `H` hotkey, or "Edit hero" in a character's detail drawer.

- **Roster tab** — per floor: recruit a new hero for a role, then edit its name, title, skin, hair,
  outfit color, hat/costume, prop and accessory with a live preview; **Roll name** picks a new one
  from the role's name pool; **Reset** restores the seeded name/look; a hero can only be **deleted**
  once released (no live agent bound to it).
- **Name pools tab** — edit which names each role can be assigned, per project.

`Ctrl/Cmd+S` saves whichever tab is active; closing with unsaved changes asks to confirm.

## Hall Planner

Opens from the **Hall Planner** button in the top bar, or "Edit floor" in Manage floors. Draw and
edit a floor's room layout: rectangular rooms with a type (office, lounge, QA lab, server room,
...), doors, and live validation (a room the reachability checker can't reach from the stairs is
flagged with a one-click fix). "Surprise me" generates a random layout; a live preview renders it in
either visual style before you save.

| Key | Action |
|---|---|
| `V` / `R` / `S` / `D` / `H` (or Space) | Select / Room / Stairs / Doors / Hand tool |
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
| Ctrl/Cmd+Z | Undo |
| Ctrl/Cmd+Shift+Z or Ctrl+Y | Redo |
| Ctrl/Cmd+G | "Surprise me" (random layout) |
| `P` | Toggle the styled preview |
| Ctrl/Cmd+S | Save (blocked while validation errors exist) |
| `?` | Show this help |
| Esc | Cancel the open popover, then clear the door/room selection, then close |

Room furnishing (desk/seat count, density, decoration amount, aisle width, re-roll seed) and a
reachability overlay are in the Inspector panel while a room is selected.

## Manage floors (`F`)

Lists every floor: rename, archive/unarchive (archived floors are hidden from the floor picker by
default — toggle "Show archived" to see them), and jump straight into the Hall Planner for a
specific floor with **Edit floor**.

## Notifications

Click **Enable alerts** in the top bar (shown only until you grant or deny permission) to allow
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

Next: [Attribution](attribution.md).
