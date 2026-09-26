# Display & shaders

## Styles

Every floor is drawn in one of two visual styles (`office.style` — a per-layout `style` in the Hall
Planner overrides the server default for that one floor):

- **`modern`** — the original pixel office: desks, monitors, break room.
- **`guild`** (default) — a medieval guild hall: stone halls, torches, banners, rune circles.

The Multiverse floor always uses its own **`rift`** style regardless of the setting above — a
starfield/void backdrop blending each visible project's own style per realm.

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

## New in this release: screen effects & edge vignette (v0.4.0, unreleased)

### Screen effect (per browser)

A **Screen** button in the top bar puts a "monitor" look over the whole office. Press it (or the `V`
key) to switch the effect on or off; the small arrow next to it picks the look:

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
