# Sound and audio

Starting in v0.7.0, tagconn generates sound effects and ambient music in real-time using WebAudio synthesis. Everything is procedurally created in code — there are no audio files.

## Sound is off by default

To respect your silence, **sound is turned off by default** (`office.sound: false`). When it's off, no audio plays in any browser. The Menu button (☰) in the top bar has a **Sound** row where you can turn sound on per browser.

## Sound categories

All sounds fall into one of five categories, each toggle-able independently in the menu:

| Category | Sounds | Defaults |
|---|---|---|
| **Master** | Controls everything (the server default) | off |
| **SFX** | Meeting gongs, NPC sounds (barks, meows, whistles), jingles | on |
| **Footsteps** | Walking and typing sounds | on |
| **Ambient** | Background beds (office hum, crickets, tavern chatter, rift drones) | on |
| **Alerts** | Alert box sounds (asks, failures, quest done) | on |

**Master** is the server-wide default; each browser can override it from the menu. If master is off, nothing plays anywhere.

## Per-browser audio preferences

Click the **🔊** (sound on) or **🔇** (sound off) button in the menu:

- The toggle switches mute on/off for this browser only
- Drag the **Volume** slider to adjust loudness (0–100%, default 60%)
- Click **Use server default** to forget your preferences and follow the server's `office.sound` setting again

Your choice is saved **in this browser only** (localStorage) and survives a page reload — no pairing needed.

## Interface and transition sounds

The interface gives short game-style feedback, all soft and under 0.15 s:

| When | Sound |
|---|---|
| Open or close the menu, a panel or a dialog (Settings, Heroes, Receptionist, Hall Planner, agent details) | open / close sweep |
| A character becomes selected (scene click, party bar, `[` / `]`, alert "Show me") | select blip; clearing the selection plays a lower "back" blip |
| Any other button (zoom, Fit, menu rows) | click |
| Switches, checkboxes, radio choices | toggle; tabs get a tab tick |
| Hovering a party portrait or menu row with a mouse | very quiet tick |
| Settings **Save** | rising confirm on success, low buzz on failure |
| Switching floors or entering and leaving the Multiverse | soft whoosh or shimmer as the transition starts |
| Day turning to night (or back) on the current floor | two-note chime |

UI sounds follow the **SFX** switch, so turning SFX off (Settings, Office, Audio) or muting from the menu silences all of them. The day/night chime is an SFX sound. Nothing plays before your first click or key press, and a hidden tab is silent. Developers can set `data-sfx="none"` on a control to skip its click sound or `data-sfx="<sound id>"` to pick another.

## Battle sounds and music

During a battle (see [Battles and progression](battles.md)), the following sounds play:

| What | Sound | Controlled by |
|---|---|---|
| **Battle music** | Looped procedural theme, style-matched (modern synth, tavern fiddle, rift drones) | `battle.music` setting (on by default) |
| **Damage hits** | Sharp attack hits with pitch variation by damage | SFX category |
| **Item use** | Healing or buff jingles (type-specific) | SFX category |
| **Move effects** | Status infliction buzzes, status clears, buffs, shields | SFX category |
| **Faints and transitions** | Descending tone for a hero faint, whoosh for battle end | SFX category |
| **Encounter prompt** | Short alert jingle when the NPC appears | Alerts category |

Battle music plays when a battle scene opens (if `battle.music` is on) and fades out when the battle ends. All other battle sounds follow the **SFX** audio category and are silent if you mute SFX or the master audio.

## Ambient sound

Each floor generates a subtle background bed based on its visual style and time of day:

- **Modern day** — soft office hum with occasional keyboard ticks
- **Modern night** — quieter, with cricket chirps
- **Guild day** — tavern murmur and fireplace crackle
- **Guild night** — heavier atmosphere, fire
- **Rift** — deep detuned tones and slow drones (space/void vibe)

Ambient sound is spatial: it's louder at the center of your view and fades toward the edges, so you feel immersed in the scene.

## Spatial audio

Sound effects play from the world location they occur at (e.g., a footstep plays louder near that character). The closer to the center of your camera view, the louder. As you pan away, they fade. This gives depth to the office.

The **listener** is the center of your camera view. If audio is locked (e.g., no audio context), spatial effects don't happen, but mono sounds (alerts, UI clicks) still play.

## Audio settings

All audio settings are under **Settings → Office → Audio**:

| Setting | Default | What it does |
|---|---|---|
| `volume` | 0.6 | Master volume (0–1, or 0–100% in the menu). Each browser can override this. |
| `sfx` | on | Sound effects (meeting gongs, NPC sounds, jingles). |
| `ambient` | on | Background beds (office hum, crickets, tavern chatter, etc.). |
| `alerts` | on | Alert box jingles. |
| `footsteps` | on | Walking and typing sounds. |

And the master switch: `office.sound` (default off — no sound plays anywhere until turned on in the menu or the setting is changed to `true`).

## Unlocking audio

On most browsers, WebAudio requires user interaction before it can play. The first time you click, tap, or type on the page, audio unlocks. Once unlocked, everything works. If you never interact (just reading), audio stays silent even if you toggle the switch — but switching on in the menu counts as interaction and unlocks it.

## Reducing audio load

If audio synthesis is causing lag (rare), turn off categories you don't need:

- Turn off `ambient` to reduce CPU load (synthesis runs all the time otherwise)
- Turn off `footsteps` for a quieter experience
- Set `volume` lower to reduce DSP work
- The audio engine caps at 8 concurrent voices, so burst alert sounds can queue

## Accessibility

All audio is supplementary — the office works fully without sound. Ambient effects and footsteps respect your system's **reduced motion** preference, so they silence or pause if you have that on. Alerts use both icons and text, so you can see them even if sound is off.

Next: [Display & shaders](display.md).
