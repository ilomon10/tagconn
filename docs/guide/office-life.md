# Office life

When characters have downtime or gather together, they come alive with meetings, activities, and games. Office life is purely visual — it never changes what your agents are actually doing, just makes the office feel busier and more fun.

## Meetings

When your main session spawns multiple subagents close together, they hold a kickoff meeting. They walk to a conference table (or gather in the lounge), sit down, chat, and then disperse. A few subagents might arrive late — the host walks over and calls them to the table (often with a phone in hand, looking annoyed). If everyone is already there, they skip this bit.

After some time idle, the characters also hold periodic **stand-ups** — everyone gathers, they chat for a moment, and scatter. These happen roughly every **30 minutes** by default, once a few idle characters are on the floor.

If you disable office life (`office.life.enabled: false`) or if **reduced motion** is on, meetings and stand-ups don't happen. A running meeting cancels at once when reduced motion is turned on.

## Idle activities

Between meetings, idle characters wander off to grab coffee, play a game, or just take a break. Every **60 seconds** (average), one or two idle characters walk somewhere on the floor and spend a few seconds doing something — chatting at the water cooler, playing arcade games, doing stretches, or napping on the sofa.

Activities never pull a character away if:
- They are waiting on you or blocked
- A meeting is running (meetings have higher priority)
- There's no room or furniture for the activity

### Lounge games and furniture

The **lounge** (the break room area) has new furniture for idle games:

- **Arcade cabinet** (modern) / **Dartboard** (guild) / **Holo-arcade** (rift) — single-player or a pair, quick games
- **Ping-pong table** / **Arm-wrestling trestle** / **Zero-G paddle field** — two players, medium length
- **Foosball table** / **Dice table** / **Hover-puck table** — 2–4 players, longer games
- **Board game table** / **Cards & dice** / **Holo-chess** — 2–4 players, strategic games

These are purely decorative; characters just pretend to play. They still work if you turn off office life (they're just not visited).

## Life settings

All life settings are under **Settings → Office → Office life**:

| Setting | Default | What it does |
|---|---|---|
| `enabled` | on | Whether meetings and idle activities happen. |
| `kickoffWindowSec` | 30 | When the main session delegates, a kickoff starts if 2+ subagents spawn within this many seconds. |
| `meetingSec` | 20 | How long a meeting lasts (everyone sits at the table). |
| `standupEverySec` | 1800 | Minimum seconds between stand-ups on a floor (about 30 minutes). |
| `standupMinCast` | 3 | How many idle characters needed to trigger a stand-up. |
| `idleActivityEverySec` | 60 | Average seconds between idle activities on a floor. |
| `maxConcurrent` | 2 | How many meetings and activities can run at once (on low graphics quality, max 1). |
| `maxMeetingSize` | 6 | The host plus this many invitees per meeting (larger groups split over time). |

## In modern vs. guild vs. rift

- **Modern**: "Coffee chat", water cooler gossip, arcade, ping-pong, foosball, board games, stretches, phone calls, watering plants, sofa naps, whiteboard doodles. Lines are about work and office life.
- **Guild**: Tavern scenes — ale at the bar, well gossip, darts, arm-wrestling, dice games, cards, quest banter, stretches, sending-stone calls, herb tending, hearth naps, rune doodles.
- **Rift**: Sci-fi — nutrient bars, coolant gossip, holo-arcade, zero-G paddle, hover-puck, holo-chess, gravity stretch, comm calls, void-moss tending, stasis naps, star-chart doodles.

Next: [NPCs and encounters](npcs.md).
