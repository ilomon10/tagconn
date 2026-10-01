# NPCs and encounters

Your office isn't just for your team. Starting in v0.7.0, routine staff and random visitors come and go, adding life to the floors.

## Routine NPCs

These NPCs always work regular hours and don't need to be enabled:

- **Janitor** — mops the floors in the evening and empties the bins when there's been a lot of activity (a sudden burst of work). Evening hours are 6 PM to 11 PM by default. Sounds: mop squeaks.
- **Courier** — drops by during the day (9 AM to 5 PM) with packages and mail. Very efficient.
- **Plant waterer** — tends the office plants in the mornings (7 AM to 11 AM). Waters, wanders, waters again, polite.

## Random encounters

When random encounters are enabled (`office.npcs.encounters`), unexpected visitors show up roughly every **4 minutes** (average):

| Kind | Hours | Behavior | Reaction |
|---|---|---|---|
| **Guest** | 9 AM–6 PM | Wanders in, chats with the crowd, leaves | Gather around them (friendly) |
| **Police** | 10 AM–10 PM | Arrives, blows a whistle at the crowd, leaves | Characters flee (surprised) |
| **CIA Agent** | 8 PM–4 AM | Wanders mysteriously, makes phone calls, departs quietly | Characters ignore them (suspicious) |
| **Sales Dog** | 9 AM–5 PM | Bounces in, chats, barks, leaves | Characters chase them (playful) |
| **Monster** | 10 PM–5 AM | Wanders in, roars, leaves quickly | Characters flee (scared) |
| **Office Cat** | All day (double at night) | Finds a comfy sofa to nap on | Characters gather around them (cute) |

The hour shown is **host time** (your system time on your machine).

### Encounter reactions

When idle characters react to an NPC, they might:

- **Flee** — panic and run away to a safe distance
- **Gather** — crowd around to interact or play
- **Chase** — playfully follow them around

Only idle characters react (never waiting or blocked ones). Reactions respect `office.npcs.maxReactors` — how many characters react to one NPC at once.

## Styles

Each style has its own flavor of NPCs:

- **Modern**: realistic office workers (Janitor, Courier, Guest, Sales Dog), plus Receptionist, Police, CIA Agent, a Monster, and an Office Cat
- **Guild**: fantasy staff (Broom Goblin, Messenger, Herbalist, plus medieval encounters — Town Guard, Inquisitor, Slime, Wolf, Familiar)
- **Rift**: sci-fi (Maintenance Drone, Cargo Runner, Hydroponist, plus star-faring encounters — Rift Warden, Void Auditor, Void Blob, Hover Hound, Astro Cat)

The same NPC kind looks and sounds different in each style, and floor styles can have their own character pools.

## NPC settings

All NPC settings are under **Settings → Office → NPCs**:

| Setting | Default | What it does |
|---|---|---|
| `enabled` | on | Whether any NPCs appear. |
| `janitor` | on | The janitor mops and empties bins. |
| `encounters` | on | Random visitors show up (guests, police, etc.). |
| `encounterEverySec` | 240 | Average seconds between encounters on a floor (about 4 minutes). |
| `maxConcurrent` | 2 | NPCs on a floor at once (1 on low graphics quality). |
| `allowChaos` | on | Idle characters may flee, gather, or chase. Turn off for a calmer office. |
| `maxReactors` | 4 | How many characters react to one NPC. |
| `disabledKinds` | none | NPC kinds you never want to see (one per line: janitor, courier, plant-waterer, guest, police, cia-agent, sales-dog, monster, office-cat). |

## Gating

NPCs require `office.ambientEffects` to be on and no **reduced motion** setting, just like idle activities. On low graphics quality, only one NPC appears at a time. The Multiverse floor never has NPCs (they stay on individual project floors).

If you turn off `allowChaos`, characters will still see NPCs but won't react dramatically — they'll just go about their business, less noisy and more zen.

Next: [Game alerts](alerts.md).
