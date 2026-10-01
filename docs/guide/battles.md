# Encounters, battles and hero progression

Starting in v0.8.0, heroes level up from the tokens their agents spend in Claude Code. Meet random encounter NPCs on your office floors, and choose to battle them for XP, skill points, and cosmetic loot — or ignore them and go about your work. Battles are turn-based, Pokémon-style, and entirely cosmetic: your real agent work is never affected by battles, KOs, or loot.

## How levels work

Each hero bound to an agent earns **XP** from the tokens that agent spends in Claude Code. The XP comes from the token usage counters: input tokens, output tokens, cache-creation tokens, and optionally cache-read tokens (by default, cache reads don't count, so long sessions don't inflate XP).

### XP weights

You can adjust how much XP each token type contributes, under **Settings → Progression → XP weights**:

| Token | Default weight | What it represents |
|---|---|---|
| **Output** | 1.0 | Tokens Claude generates (thinking, responses, tool calls). Usually the heaviest lifter. |
| **Input** | 0.2 | Tokens Claude reads (prompt, context, tool results). One-fifth of an output token. |
| **Cache creation** | 0.1 | Tokens saved to a context cache (if your model supports it). One-tenth of an output token. |
| **Cache read** | 0 | Tokens read from cache (pre-computed context). Disabled by default to avoid inflating XP. |

XP only comes from work done while it counts: tokens an agent spends while progression is off, before a hero is bound to it, or while the hero's progress is unreadable are never credited afterwards (turning progression on starts from now). A single usage update is also capped (5,000,000 XP) and anything above the cap is dropped, which stops forged or corrupt usage numbers from inflating levels.

Each setting ranges from 0 to 10 (turning a weight to 0 disables it). All weights apply equally to all heroes bound to agents in the same session.

### Level curve

A hero needs progressively more XP to reach each level. The curve is: **XP at level L = levelBase × (L − 1) ^ levelExponent**, starting at level 1 (requires 0 XP).

Adjust the curve under **Settings → Progression**:

| Setting | Default | What it does |
|---|---|---|
| **Level base** | 1500 | Multiplier for the curve. Higher = more XP needed per level. |
| **Level exponent** | 2 | Curve steepness. Higher = faster XP requirements grow (quadratic at 2). |
| **Max level** | 50 | The highest level a hero can reach. |
| **Skill points per level** | 1 | Skill points earned for each level gained. |

### Rough guide: how long is a level?

The defaults (base 1500, exponent 2) give a smooth curve:
- **Early levels (1–10):** light work — 1–2 typical Claude tasks per level.
- **Mid levels (10–30):** regular daily work — 3–8 tasks per level.
- **High levels (30+):** sustained work — 10–20+ tasks per level.

This is *very* approximate and depends on token usage of your tasks, the weights you set, and your agent's model. The XP bar at the top-left (under the hero's **Lv** badge) shows exactly how far to the next level.

## Encounters

When random encounters are enabled (`office.npcs.encounters`), NPCs like guests, police, sales dogs, and more walk through your office roughly every 4 minutes. Some of them are **aggressive** and offer you a battle:

**A wild Sales Dog appeared!**
- **Battle** — accept the challenge and open the party picker
- **Ignore** — decline and carry on (auto-ignores after 20 seconds by default)

Encounter NPCs still visit with reduced motion on (they stand still instead of walking), so you can still get and accept battles.

Ignoring a battle costs nothing and never affects your agent. The prompt disappears, the NPC leaves, and work continues.

If you accept, you move to the **party picker**.

Only one battle can be open per floor. If you start a battle on the same floor in another browser tab, it abandons the first one (the first tab's battle ends without a result).

A battle that was already open when you turned `battle.enabled` or `progression.enabled` off can still be finished and its result is still awarded. The switches only stop new battles from starting.

## Party picker

Choose 1 to 4 heroes to send into battle. The picker shows:
- **Heroes on this floor** — heroes bound to your active agents or working on this project
- **Party size** — you must include at least one hero
- **Temporary levels** — anonymous subagents (not bound to a hero) can join with a temporary level from their own token usage (if `progression.anonymousInBattle` is on, the default)
- **Knockouts** — heroes currently knocked out are shown but disabled

Select heroes by clicking their portrait or name. Their stats, level, and current HP appear on the left. When you've picked your team (1–4 members), click **Fight** to start the battle. The team's average level sets the enemy level (scaled by difficulty, below).

If the hero picker is taking a while, you can also press **Esc** to cancel and go back to ignoring the encounter.

## Battle screen

Once the battle starts, you're in a **turn-based combat scene**. Your party appears on the left, the enemy on the right, and the action plays out in turns.

### Your turn

When it's your hero's turn, four options appear:

| Command | Key | What it does |
|---|---|---|
| **Fight** | `A` | Use the hero's basic attack (low power, always hits). |
| **Skill** | `S` | Choose a special move from the hero's skill tree (higher power, costs focus, may miss or inflict status). |
| **Item** | `I` | Use a battle item (coffee = heal, energy drink = restore focus, rubber duck = cure status, pizza = heal the whole party). Items are shared with the party and run out. |
| **Swap** | `W` | Switch to a different hero in your party (still ends your turn). |
| **Run** | `R` | Flee the battle. Succeeds more often if your hero is faster than the enemy; failure wastes a turn but you can try again. |

Hold **Shift** and press a key to use it without opening menus (e.g., `Shift+A` to attack directly). The keyboard also works while a menu is open, so you can queue your next move.

**Focus** (blue bar under HP) is like mana — special moves cost focus, you regain it each turn, and some items restore it. HP is health; your hero faints at 0 HP and you must swap to another living member. If all party members faint, you lose the battle.

### Enemy turn

The enemy chooses an action (move, item, or flee) based on its AI (aggressive, tank, or tricky). Status effects may prevent it from acting. Damage numbers float up with type effectiveness and crit indicators.

### Statuses and effects

Three major status effects in battle:

| Status | Icon | Effect |
|---|---|---|
| **Stunned** | Zzz | Skip your next action (but the status clears). |
| **Merge conflict** | Crossed arrows | 33% chance to hurt yourself instead; lasts 2–3 turns. |
| **Burnout** | Flame | Lose 1/12 of max HP at the end of each of *your* turns; lasts 3–5 turns. |

Your hero can also gain **Buffed** (increased attack, 1.5x damage) or **Shielded** (halved incoming damage). These last a few turns.

### Types and matchups

Every hero and enemy has a **type** tied to their role/nature:

**Hero types:** Build, Test, Design, Secure, Review, Insight, Lead, Grit
**Enemy types:** Bug, Bureaucrat, Salesy, Rival, Feral

Your hero's skills inherit their type and can be **super-effective** (2x damage) or **weak** (0.5x damage) against an enemy's type. The game shows icons for these. Same-type attacks (STAB) also do 1.25x damage. Type advantages are woven into the matchups — for example, Build heroes do 2x damage to Bugs, but Bugs do 2x back to Build, so you can't dominate with type alone.

## Battle results

When the battle ends (you win, lose, flee, or timeout), a **results screen** appears. If you won:

- **XP awarded** to each party member (based on enemy level and difficulty; a quarter-level of XP by default)
- **Level-ups** — any hero that reached the next level glows and gains skill points
- **Skill points** — 1 per level by default, plus a bonus every 3 wins if enabled
- **Loot** — roughly 35% chance a battle item drops (hat, prop, or title for one party member)
- **Tally** — your win, loss, or flee count is recorded

Losing gives you nothing except the experience of trying. Fleeing (running away) is free but doesn't award XP.

## Soft knockouts and healing

When a hero's HP drops to 0, they **faint** and leave the battlefield — but they're not gone forever. If `battle.koMinutes` is greater than 0 (default: 5 minutes), they enter a **soft knockout** state:

- **Knocked-out icon** — a small sparkle (💫) or bandage (🩹) badge appears on their portrait in the office
- **No movement** — they stay at their desk or in the lounge, they're not carried away
- **Work continues** — a knocked-out hero's agent keeps working normally; the KO is cosmetic
- **Unavailable for battle** — you can't pick them for another battle until they recover
- **Auto-healing** — when time is up, they recover at full HP

To heal a knocked-out hero early, use one of the **healing stations** on your floor:
- **Coffee machine** (modern floors; every floor is guaranteed to have one)
- **Healing fountain** (guild floors)
- **Med-bay** (rift floors)

Click a healing station while the hero is in knockdown, and they wake up immediately.

If `battle.koMinutes` is 0, KOs are disabled — defeated heroes revive right away and can battle again.

## Skill trees and progression

After each level-up, your hero gains **skill points** to spend on their **skill tree**. Each hero class (Developer, QA, Architect, etc.) has a unique 3-branch tree with 12 nodes.

Open the **Heroes** panel (**H** key or Menu → Heroes) to see your heroes and their stats.

### Skills tab

On a hero's **Skills** tab:
- **Branches**: offense, defense, and tempo (left to right)
- **Tiers**: 1–4 (bottom to top); tier 1 unlocks at level 1, tier 2 at level 3, tier 3 at level 8, tier 4 at level 15
- **Points**: each node shows available ranks (1–5 depending on the tier) and a cost in skill points

**Spending points:** Click a skill node and a slider appears. Drag to increase your rank (more effect), then click **Confirm**. You can't spend points on a tier until you have rank 1 of its prerequisite (the tier below it in the same branch).

**Saving while the hero is working:** your hero keeps earning XP while you plan, and that does not block saving. Only another skill change (for example from a second tab) makes the save conflict; the sheet then offers **Reload** or **Overwrite**.

**Respec:** Click **Respec** to reset all your skills and get your points back (if `progression.allowRespec` is on, the default). This refunds everything with no penalty, so you can experiment.

**Admin pairing:** Skills are an admin-only action. If you're viewing a pairing code or don't have admin access, the Heroes panel shows your hero's stats but the Skills tab is read-only. Pair your browser (see [Pairing your browser](pairing.md)) to edit.

## Loot cosmetics

When you win a battle, you might earn **cosmetic loot** — appearance items that customize your hero without affecting stats or gameplay:

**Hats** — replaces or layers with the hero's default hat. Options: cap, police-cap, fedora, hardhat.
**Props** — handheld items. Options: mop, parcel, watering-can, clipboard.
**Titles** — cosmetic role titles shown above the hero. Options themed per enemy: "Bug Squasher" (from monsters), "Red-Tape Cutter" (from police), etc.

Each loot drop goes to one random hero in your winning party. Heroes can earn the same loot multiple times (stacking doesn't happen, but they can own it). You can equip a different hat, prop, or title whenever you want in the Heroes panel.

### Equipping loot

Open **Heroes → [hero name] → Appearance**:
- **Loot hat** — pick from owned hats, or leave it blank to use the default
- **Loot prop** — pick from owned props, or blank for default
- **Equipped title** — choose which title appears above the hero's head (if you own any)

Loot is stored on your hero, not your project, so it follows the hero if they ever switch projects. Ownership is purely cosmetic and is checked by the UI (no server enforcement for moves between projects yet).

## Demo mode

No runner or server? Click **Menu → Demo** (or visit `?demo=1` in the URL) to load the **demo office** with pre-built heroes and battles. In demo mode:

- You can fight **demo battles** against hard-coded enemies
- Heroes earn XP, level up, and gain skill points
- You can spend skills, equip loot, and change appearance
- **No persistence** — everything resets when you reload the page
- **No connection** — the demo runs entirely in your browser

Demo battles follow the same rules and use the same engine as real battles, so it's a perfect way to try the system without waiting for a full office setup.

## Settings reference

All progression and battle settings are under **Settings → Progression** and **Settings → Battle**:

### Progression settings

| Setting | Default | Range | What it does |
|---|---|---|---|
| **Enabled** | on | on/off | Credit XP from token usage to heroes. (When off, XP marks still advance but are not credited.) |
| **XP weights → Output** | 1.0 | 0–10 | XP per output token. |
| **XP weights → Input** | 0.2 | 0–10 | XP per input token. |
| **XP weights → Cache creation** | 0.1 | 0–10 | XP per cache-creation token. |
| **XP weights → Cache read** | 0 | 0–10 | XP per cache-read token. Off by default. |
| **Level base** | 1500 | 10–10,000,000 | Multiplier for the XP curve (higher = slower leveling). |
| **Level exponent** | 2 | 1–4 | Curve steepness (2 = quadratic, 1 = linear, 4 = very steep). |
| **Max level** | 50 | 2–100 | The highest level reachable. |
| **Skill points per level** | 1 | 0–5 | Bonus skill points earned for each level. |
| **Allow respec** | on | on/off | Let heroes reset and re-spend all their skill points. |
| **Anonymous in battle** | on | on/off | Subagents without a hero can join a party with a temporary level. |

### Battle settings

| Setting | Default | Range | What it does |
|---|---|---|---|
| **Enabled** | on | on/off | Encounter NPCs offer battles. (When off, no prompts appear.) |
| **Offer chance** | 0.5 | 0–1 | Probability (0–100%) that an encounter NPC challenges you. |
| **Auto-ignore seconds** | 20 | 5–300 | Seconds before "Battle / Ignore" auto-dismisses as ignore. |
| **Max party** | 4 | 1–4 | Heroes allowed per party. |
| **KO minutes** | 5 | 0–240 | Minutes a knocked-out hero rests. 0 = no KO. |
| **Difficulty** | 1.0 | 0.5–2 | Enemy level multiplier (1.0 = party average, 0.5 = half, 2 = double). |
| **Music** | on | on/off | Play battle music during combat. |
| **XP scale** | 0.5 | 0–10 | Win XP multiplier (0.5 = ~quarter level per win). |
| **Skill point every N wins** | 3 | 0–100 | Bonus skill point every N battles won. 0 = never. |
| **Loot chance** | 0.35 | 0–1 | Probability (0–100%) of earning loot on a win. |
| **Max turns** | 60 | 10–200 | Turns before the enemy loses interest (timeout, no XP/loot). |
| **Max per hour** | 30 | 1–120 | Rate limit: battles you can start per hour (server-side). |
| **Open battle TTL** | 30 | 1–240 | Minutes before an unresolved battle expires. |
| **Retention days** | 30 | 1–365 | Days old battles are kept before deletion. |
| **Items → Coffee** | 2 | 0–9 | Coffee potions per battle (heal 40% HP). |
| **Items → Energy drink** | 1 | 0–9 | Energy drinks per battle (restore 50% focus). |
| **Items → Rubber duck** | 1 | 0–9 | Rubber ducks per battle (cure status). |
| **Items → Pizza** | 0 | 0–9 | Pizza slices per battle (heal party 25% HP each). |

## Important: all cosmetic

**Real agent work is never affected by battles, knockouts, or loot.**

- Your agent's Claude Code session, quests, and tool calls run independently of battles. Battles are purely visual theatre.
- A knocked-out hero's agent keeps working — the KO is only a cosmetic icon and a 5-minute cooldown for the next battle.
- XP, levels, skill points, and loot change nothing about how your agent works. They're for decoration and fun.
- Battles can't interfere with real work: they run in a separate browser window/tab and have no side effects on your actual sessions.

If you want to disable battles completely, turn off `battle.enabled` in Settings. If you want to disable progression, turn off `progression.enabled`. Everything continues to work normally.

Next: [Office life](office-life.md).
