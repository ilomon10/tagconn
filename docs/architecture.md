# Architecture

## Data flow
```
HOST                                                   DOCKER COMPOSE (127.0.0.1 only)
claude (any project dir)
  └─ hooks → ~/.config/tagconn/office-hook.sh ──POST /api/hooks──▶ server :4317
                                                                     │ Fastify + socket.io + SQLite
~/.claude/agents   ◀── role sync (rw bind mount) ────────────────────┤
~/.claude/projects ─── transcripts (ro bind mount) ─────────────────▶┤
                                                                     │ socket.io namespace /office
browser ◀── web :4318 (nginx: static + proxy /api, /socket.io) ◀─────┘
runner (v2, host) ◀── socket.io client ──▶ server; spawns `claude -p --output-format stream-json`
```

## Hook → office state
Real payloads are in `apps/server/test/fixtures/subagent-session.json`. Key facts:
- Every event has `session_id`, `cwd`, `hook_event_name`, `transcript_path`.
- Events fired **inside a subagent** carry `agent_id` + `agent_type`. Without them, the event belongs to the main session.
- `PreToolUse` with `tool_name: "Agent"` carries `tool_input.description`, `tool_input.subagent_type`, and `tool_use_id`.
  The matching `PostToolUse` returns `tool_response.agentId`, which links the call to the subagent.
- `SubagentStart` / `SubagentStop` bracket a subagent's life. `SubagentStop.last_assistant_message` holds the result (and the handoff block).
- `Stop.background_tasks` lists subagents still running.

| Hook event | Office effect |
|---|---|
| SessionStart | project floor (by cwd) + session + PM character at pm-office |
| UserPromptSubmit | PM "thinking" |
| PreToolUse | character activity/zone/bubble from the activity rules (settings.activity.rules) |
| PreToolUse Agent | task card created (status doing), PM "delegating" |
| SubagentStart | new character spawns at entrance, walks to its role zone |
| SubagentStop | character "done", waves, walks out; task done/failed from the handoff block |
| Notification | character "waiting" (permission or input needed) → optional browser notification |
| Stop / SessionEnd | PM waits / everyone leaves |

## Identity
- Project id = `slug(basename(cwd))-<sha1(cwd)[0..6]>`: one floor per project directory.
- Main agent id = `main:<session_id>`, role `pm`. Subagent id = Claude's `agent_id`; role = `settings.agents.typeToRole[agent_type]` or the role of the same name.

## Server modules (apps/server/src/modules)
ingest · projects · sessions · agents (state machine + idle sweeper) · activity (rule mapping) · tasks · events ·
snapshot · settings · roles (CRUD + sync to ~/.claude/agents) · health · transcripts (stretch) · runner-bridge (v2).
Core: config (layered), db (Drizzle/better-sqlite3, WAL), event-bus, di (awilix), realtime (socket.io), http.

## Web (apps/web/src)
`lib/socket.ts` (typed client) → `stores/officeStore.ts` (zustand) → React panels (`features/*`) and the
Phaser game (`game/*`), which uses a procedurally generated map with zones, generated character textures,
a half-tile navigation grid with true clearance and macro A* pathfinding, micro line-of-sight and string-pulled
smooth sub-tile movement, a dual-grid render pass for wall caps and floor shadows (behind `office.dualGrid`), and
2.5D depth rendering with y-sorted furniture sprites and character views.

**Game depth rendering** (`game/depth/`): y-sorted tall furniture sprites from code-drawn per-style atlases; four-direction
character views with walk cycles; see-through fade when items hide the selected character (`SeeThroughController`); and
a floor-rendering pipeline that composits the base tiles, furniture, characters and effects in depth order. Controlled by
`office.depth.*` settings. Key modules: `spritePlan.ts` (sprite table), `pack.ts` (atlas packing), `furnitureAtlas.ts`
(code-drawn atlases), `renderFloor.ts` (compositing), `seeThrough.ts` and `SeeThroughController`.

**Camera** (`game/camera/`): character following with configurable deadzone and motion lag (`follow.ts`); snap zoom to
integer levels at 1× and above (`snap.ts`); optional perspective post-shader for depth cues (`PerspectivePipeline`).
Controlled by `office.camera.*` settings.

**Post-effects** (`game/postfx/PerspectivePipeline.ts`): subtle perspective shader that compresses far rows and adds
distance haze; configurable intensity (0–1). WebGL only; kept under 0.3 for accurate pointer hits.

**Game lighting** (`game/lighting/`): host-clock sun cycle with smooth dawn/dusk ramps; dynamic lightmap with
visibility polygons, room/wall/point/window lights, and character/furniture cast shadows; height map for shadow lengths
from wall elevation (`heightmap.ts`); wall shadow casting on the floor from the sun's current angle (pure planning modules:
`sun.ts`, `occluders.ts`, `visibility.ts`, `plan.ts`, `shadows.ts`; Phaser `LightmapLayer` and `ShadowLayer` only draw);
per-frame baking on sun-step or light changes; canvas fallback to flat tinted overlay. Controlled by `office.lighting.*` settings.

**Furniture harmony** (`game/procgen/harmony.ts`, `recipes.ts`): functional furniture groups (chairs face desks,
sofas come with tables, bookcases stand against walls) with slot identity, facing (N/E/S/W), group affinity and candidate
scoring. A per-room `MAX_GROUP_INSTANCES` limit prevents repeats. Shapes have directional insets (`KIND_SHAPE` with `insetFor`)
so characters can stand closer to desks. `placeGroup` / `tryAnchor` honor pinned items and consumed slots.

**Procgen and nav** (`game/procgen/generate.ts`, `game/nav/shapes.ts`): per-kind collision insets, denser furniture recipes,
half-tile sizes, painter audit for fractional sizes. `rotateShape`, `insetFor`, `KIND_HEIGHT` for shadows/visibility.

**Depth rendering table** (render order, z-index):
- Base tilemap: −10
- `ShadowLayer`: −5
- Furniture sprites and characters: at south edge of their footprint − 0.5 (y-sorted)
- Characters: at their feet y-position
- Effects: variable
- `LightmapLayer`: 90,000
- `LightLayer`: 95,000

`?demo=1` runs a scripted simulation without a server.

## Settings layering
`SettingsSchema` defaults → `config/office.yaml` (`OFFICE_CONFIG`) → env `OFFICE_<SECTION>__<KEY_SNAKE>` (+ `OFFICE_HOOK_TOKEN`)
→ runtime overrides in SQLite (GUI / `PATCH /api/settings`). Changes broadcast `settings:changed`, and modules hot-apply them.
`RESTART_REQUIRED_SETTINGS` lists keys that only apply after a restart.
