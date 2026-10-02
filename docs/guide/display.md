# Display & shaders

## Name plates and labels

Each character has an RPG-style name plate floating above their head, showing their name, role title,
and current task. See [Name plates](name-plates.md) for full details on configuring what shows and
the pixel font.

## Styles

Every floor is drawn in one of two visual styles (`office.style` — a per-layout `style` in the Hall
Planner overrides the server default for that one floor):

- **`modern`** — the original pixel office: desks, monitors, break room.
- **`guild`** (default) — a medieval guild hall: stone halls, torches, banners, rune circles.

The Multiverse floor always uses its own **`rift`** style regardless of the setting above — a
starfield/void backdrop blending each visible project's own style per realm.

### Tile edges

Walls and floors now have real edges: wall caps get a 1 px outline with rounded corners, floors cast a shadow where they meet a wall, and a cliff line marks the edge between the floor and void. These edges are drawn from the dual-grid — a second grid of render points at tile corners, letting each style paint its own edge aesthetic. Turn `office.dualGrid` off to see the flat-tile look from before v0.9.0.

| Key | Default | Effect |
|---|---|---|
| `office.dualGrid` | `true` | Dual-grid tile edges: per-style wall caps, rounded corners, floor shadows and cliff lines. Off = flat per-tile paint (every tile drawn on its own, as before v0.9.0). Applies live on Save, in every style and in the Hall Planner preview; it changes the look only, never the layout or where anyone stands. |

## Shaders

`office.shaders.*` controls WebGL post-processing, applied live as you change it in Settings.
Everything here degrades cleanly: on a canvas-only renderer, or if any pipeline fails to compile,
tagconn logs it once and falls back to plain rendering for the rest of the session — the office
still works, just without the effects.

| Key | Default | Effect |
|---|---|---|
| `office.shaders.enabled` | `true` | Master switch. |
| `office.shaders.quality` | `auto` | `auto` picks `low` on a slow/small device based on measured frame time; `low`/`high` pin it. |
| `office.shaders.grading` | `true` | Per-style color grade (warm office, candlelit guild, aurora rift). |
| `office.shaders.bloom` | `0.45` | Glow around light sources — torches, braziers, monitors, windows, appliance indicator lights. `0` = off. |
| `office.shaders.lightGlow` | `true` | Whether bloom is computed from light sources at all (the light layer itself). |
| `office.shaders.vignette` | `0.4` | Darkness at the very screen edge. `0` = off. The middle of the screen always stays clean. |
| `office.shaders.scanlines` | `false` | Legacy CRT look, modern style only, used only when `screen` (below) is `off`. Prefer `screen: 'crt'`. |

Ambient particles (torch flicker, sparkles, motes) are a separate toggle, `office.ambientEffects`
(default `true`) — turning it off removes moving decor entirely rather than freezing it. Anything
that moves in the office — ambient effects and shader flicker/wobble alike — also automatically
respects your OS/browser's **reduced motion** preference (`prefers-reduced-motion: reduce`): it's
not a setting inside tagconn, tagconn just honors the one your system already has.

## Lighting and time of day

The office follows the host's clock. Light ramps smoothly through dawn, day, dusk and night. Every room has its own lights, and the light stops at walls. Windows cast sun shafts by day and moonlight at night. Furniture and characters cast shadows from the strongest light.

**Time of day (this browser only).** The ☰ menu has a **Time of day** row under the screen effect.

| Control | Effect |
|---|---|
| Follow the office clock (switch, on by default) | Use the host's time |
| Slider (when the switch is off) | Pick an hour from 0 to 24 in 15-minute steps; nobody else sees it |
| **Now** | Jump the slider to the current host time |
| **Default** | Clear the override and follow the host again |

The hint under the row shows the host's time zone. In Docker the host time zone comes from `TZ` in `.env`; without it the office runs on UTC.

**Settings** (`office.lighting.*`, in Settings or `config/office.yaml`):

| Key | Default | Effect |
|---|---|---|
| `cycle` | `host-clock` | `host-clock` follows the server's local time; `fixed` stays at `fixedHour`; `accelerated` runs a whole day every `cycleMinutes` |
| `fixedHour` | `14` | Hour for `fixed` (decimal, 14.5 = 14:30), and the start hour of `accelerated` |
| `cycleMinutes` | `24` | Real minutes per day in `accelerated` |
| `dawnHour` / `duskHour` | `6.5` / `18.5` | Centre of sunrise (0–11) and sunset (13–24) |
| `twilightHours` | `1.5` | Length of each dawn and dusk ramp |
| `nightAmbient` | `0.35` | Brightness at deep night (0 = pitch black, 1 = no night) |
| `lightScale` | `1` | Multiplies the reach of every light |
| `shadows` | `cast` | `off`, `blob` (the ellipse under characters only), or `cast` (furniture and character shadows from the dominant light) |
| `lightmap` | `true` | The wall-clipped lightmap; off shows the flat overlay of earlier versions |
| `resolution` | `half` | Lightmap resolution; `quarter` is used automatically on low quality |
| `sunStepMinutes` | `15` | Game minutes between light and shadow re-bakes |
| `windowShafts` | `true` | Sun shafts and moonlight in front of windows |

`office.theme` still works: `day` pins 13:00, `night` pins 01:00, and `auto` follows the cycle above. The browser override wins over both.

**Quality and fallback.** Low shader quality uses a quarter-resolution lightmap, fewer light bands, no shafts and blob shadows. The canvas renderer, or `lightmap: false`, shows a flat overlay whose darkness follows the sun. Reduced motion turns off light flicker.

## New in this release: screen effects & edge vignette (v0.4.0, unreleased)

### Screen effect (per browser)

**Screen effect** in the menu puts a "monitor" look over the whole office. Switch it on or off there
(or with the `V` key); the CRT / LCD / VHS buttons under it pick the look:

| Effect | Look |
|---|---|
| CRT | Curved tube with a dark bezel, scanlines, an RGB mask and a faint flicker. |
| LCD | Flat panel with a subpixel grid and a rounded bezel. |
| VHS | Tape tracking wobble, colour bleed, grain and a rolling noise line. |

- Your choice is saved **in this browser only** (no pairing needed) and survives a reload. "Use server
  default" in the menu forgets it and follows the server setting again.
- `V` is ignored while you type in a field or while a dialog or the Hall Planner is open. The button
  is disabled when shaders are turned off (`office.shaders.enabled: false`).
- The server default for every browser that hasn't chosen: `office.shaders.screen`
  (`off` | `crt` | `lcd` | `vhs`, default `off`) and `office.shaders.screenStrength` (0–1, default `0.6`).
  The old `scanlines: true` still means "CRT on the modern style" when `screen` is `off`.
- With reduced motion, the moving parts (flicker, VHS wobble) hold still.

### Edge vignette

The vignette only darkens a thin frame along the screen edges; the middle of the screen is never
touched. By default it's drawn in **pixel style**: 4 hard, blocky bands that step 25% → 50% → 75% →
100% of the vignette strength towards the edge, on the same pixel grid as the art (the blocks grow
when you zoom in).

| Key | Default | Meaning |
|---|---|---|
| `office.shaders.vignette` | `0.4` | Darkness at the very edge. `0` = off. |
| `office.shaders.vignetteSize` | `0.12` | How far the frame reaches in, as a fraction of the shorter screen side (0.03–0.4). |
| `office.shaders.vignetteStyle` | `pixel` | `pixel`: hard stepped bands. `smooth`: a soft fade along the edges. |
| `office.shaders.vignetteSteps` | `4` | Number of bands for the pixel style (2–8). |
| `office.shaders.vignettePixel` | `4` | Block size, in art pixels (1–16). |

All of these are in **Settings → Office → Visual effects** and apply as soon as you press Save (no restart).

Next: [Configuration](configuration.md).
