# Game alerts

Starting in v0.7.0, tagconn shows JRPG-style alert boxes in the top-right corner for key events — when an agent asks for you, stumbles on a tool failure, or completes a quest. These are in *addition to* browser notifications (which still work when the tab is hidden).

## When alerts appear

By default, four kinds of events trigger alerts:

| Event | Icon | When | Triggered by |
|---|---|---|---|
| **Asks for you** | ❓ | An agent enters a waiting or blocked state (needs your input) | `AskUserQuestion` or `ExitPlanMode` |
| **Stumbled** | 💥 | A tool call fails with an error | Tool error / exception |
| **Encounter** | ⚔️ | A random NPC offers to battle your heroes | Encounter prompt (Battle / Ignore) |
| **Quest complete** | ⚔️ | A session finishes (all agents done) | Session end |

If an NPC shows up and multiple characters react, one alert might say "3 heroes need you" instead of three separate alerts.

## How they work

- Alerts appear in a stack in the top-right corner (top-center on phones), with the most important first
- Each alert shows the character's portrait, name, title, and event details
- Newer alerts appear at the top; you can dismiss one by clicking the ✕ button
- By default, an alert auto-dismisses after 8 seconds, or never if you set `autoDismissSec` to 0
- Click **Show me** to jump to that character and dismiss the alert

Alerts are **rate-limited**: no more than 4 per minute by default, with a burst of 3 (the bucket fills back up slowly). If an alert can't fit in the queue, it waits until there's room. This prevents spam if something goes wrong and emits many errors at once.

## Coalescing and cooldown

If two alerts for the same character arrive within 1.5 seconds, they merge into one ("2 heroes need you"). An agent also has a **cooldown**: once they raise an alert, the same character can't raise another one of equal or lower priority for 60 seconds. This stops the same character from spamming the same type of alert over and over.

Alerts for different priorities always show (a "Quest complete" doesn't cancel an active "Asks for you").

## Settings

All alert settings are under **Settings → Office → Alerts**:

| Setting | Default | What it does |
|---|---|---|
| `enabled` | on | Show JRPG alert boxes (browser notifications still work). |
| `onAsk` | on | Alert when an agent asks for you. |
| `onDone` | on | Alert when a quest completes. |
| `onFailure` | on | Alert when a tool call fails. |
| `perMinute` | 4 | Token-bucket refill rate — alerts per minute. |
| `burst` | 3 | Token-bucket size — how many alerts can appear back-to-back. |
| `agentCooldownSec` | 60 | Seconds before the same character can raise another alert of the same or lower priority. |
| `autoDismissSec` | 8 | Seconds before an alert auto-dismisses (0 = until you dismiss it). |
| `maxVisible` | 2 | How many alert boxes appear on screen at once. |

## Turning off alerts

- To turn off **all** game alerts: `enabled: false` (browser notifications still work when the tab is hidden)
- To turn off **specific** kinds: `onAsk: false`, `onDone: false`, `onFailure: false`
- Browser notifications still appear on top of these settings when the tab is hidden (controlled by **Settings → Notifications**)

Next: [Sound and audio](sound.md).
