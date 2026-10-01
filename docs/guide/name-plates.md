# Name plates

Starting in v0.7.0, each character has an RPG-style name plate floating above their head. The plate shows three lines of information and respects your zoom level, staying crisp and readable at any scale.

## What's on the plate

The plate displays:

1. **Name line** — the character's name (or their role name if unnamed), in the character's role color
2. **Title line** — a themed status title (e.g., "Analyst", "Adventurer", "Void Scout"), visible by default but controlled by `office.labels.showTitle`
3. **Task line** — the character's current task, below the title, shown on hover/selection, always, or never (controlled by `office.labels.showTask`)

For example: an analyst named "Alex" waiting on you might show:

```
    Alex
  Analyst
 Waiting on you
```

## Configuring plates

All plate settings are under **Settings → Office → Name plates**:

| Setting | Default | What it does |
|---|---|---|
| `showTitle` | on | Show the second line with the role title. |
| `showTask` | on hover | When to show the task line: **focus** (hover or select), **always**, or **never**. |
| `taskLines` | 2 | How many lines the task wraps to before it ends with "…". |
| `maxWidthChars` | 24 | How wide the plate is in character widths (longer names are cut, task wraps at this width). |
| `pixelFont` | on | Use a crisp, hand-drawn pixel font (WebGL only; falls back to system text in canvas mode or if glyphs are missing). |

## Plate appearance

- Plates are drawn above the character's head on a semi-transparent dark background (so they don't disappear over light areas).
- They scale with your camera zoom, using a code-generated pixel font for that clean retro look.
- The plate never covers a character's speech bubble; if both would overlap, the bubble moves above.
- Under **reduced motion** (your OS setting), plates stay static and don't pulse or animate.

## Canvas renderer fallback

If your browser uses canvas instead of WebGL (rare, on very old devices), or if the pixel font can't render a character (e.g., an emoji), tagconn falls back to system text. The plate still works, just with your browser's default font.

Next: [Office life](office-life.md).
