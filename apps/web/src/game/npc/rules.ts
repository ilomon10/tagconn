// M13 W1-15: pure NPC rules (docs/design/office-life.md 3.5.2). Seeded and deterministic; no Phaser.
import type { Agent, NpcKind } from '@tagconn/shared';
import type { ActorKey } from '../cast';
import { WAITING_CLEARANCE_TILES } from '../cosmetic/types';
import { dramaHash, dramaRng } from '../drama';
import type { GeneratedMap, Point } from '../procgen/types';
import type { ThemeDefinition } from '../themes/types';
import { ENCOUNTERS } from './encounters';
import { NPC_TIMING, type EncounterDef, type NpcSettings } from './types';

export const BURST_TOOLS = 12;
export const BURST_WINDOW_MS = 60_000;
const HOUR_MS = 3_600_000;
const REACT_RADIUS_TILES = 6;
const FLEE_MIN_TILES = 4;

type NpcSkinOf = NonNullable<NonNullable<ThemeDefinition['npcs']>['skins'][NpcKind]>;

const cheb = (a: Point, b: Point): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Weighted seeded pick of weight * hours[hour] over kinds that are not disabled, not the janitor, not in `active`,
 *  and (when !settings.encounters) routine. null when the total is 0 or `!settings.enabled`. */
export function pickEncounter(hour: number, rand: () => number, settings: NpcSettings, active?: ReadonlySet<NpcKind>): EncounterDef | null {
  if (!settings.enabled) return null;
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const pool: { def: EncounterDef; w: number }[] = [];
  let total = 0;
  for (const def of Object.values(ENCOUNTERS)) {
    if (def.kind === 'janitor' || settings.disabledKinds.includes(def.kind) || active?.has(def.kind)) continue;
    if (!settings.encounters && !def.routine) continue;
    const w = def.weight * (def.hours[h] ?? 0);
    if (w <= 0) continue;
    pool.push({ def, w });
    total += w;
  }
  if (total <= 0) return null;
  let r = rand() * total;
  for (const p of pool) {
    r -= p.w;
    if (r < 0) return p.def;
  }
  return pool[pool.length - 1]?.def ?? null;
}

/** 'mop' once per evening hour (18-23) bucket, 'bins' on a burst; both respect janitorCooldown; null when off/disabled. */
export function janitorDue(hour: number, burst: boolean, lastAtMs: number | null, nowMs: number, settings: NpcSettings): 'mop' | 'bins' | null {
  if (!settings.enabled || !settings.janitor || settings.disabledKinds.includes('janitor')) return null;
  if (lastAtMs !== null && nowMs - lastAtMs < NPC_TIMING.janitorCooldown) return null;
  if (burst) return 'bins';
  if (hour >= 18 && hour <= 23 && (lastAtMs === null || Math.floor(lastAtMs / HOUR_MS) !== Math.floor(nowMs / HOUR_MS))) return 'mop';
  return null;
}

/** Burst = floor-wide toolCount rose by >= BURST_TOOLS within BURST_WINDOW_MS. */
export class BurstMeter {
  private last = new Map<string, number>();
  private samples: { t: number; n: number }[] = [];

  observe(agents: readonly Pick<Agent, 'id' | 'toolCount'>[], nowMs: number): void {
    const next = new Map<string, number>();
    let rise = 0;
    for (const a of agents) {
      const prev = this.last.get(a.id);
      if (prev !== undefined && a.toolCount > prev) rise += a.toolCount - prev;
      next.set(a.id, a.toolCount);
    }
    this.last = next;
    if (rise > 0) this.samples.push({ t: nowMs, n: rise });
    this.prune(nowMs);
  }

  burst(nowMs: number): boolean {
    this.prune(nowMs);
    let sum = 0;
    for (const s of this.samples) sum += s.n;
    return sum >= BURST_TOOLS;
  }

  clear(): void {
    this.last.clear();
    this.samples = [];
  }

  private prune(nowMs: number): void {
    this.samples = this.samples.filter((s) => nowMs - s.t <= BURST_WINDOW_MS);
  }
}

export interface ReactorCandidate { key: ActorKey; x: number; y: number }

/** Nearest first within 6 tiles of the NPC, never within WAITING_CLEARANCE_TILES of a waiting tile, at most `max`. */
export function pickReactors(cands: readonly ReactorCandidate[], npcTile: Point, waiting: readonly Point[], max: number, seed: string): ActorKey[] {
  const ok = cands
    .filter((c) => cheb(c, npcTile) <= REACT_RADIUS_TILES && !waiting.some((w) => cheb(c, w) <= WAITING_CLEARANCE_TILES))
    .map((c) => ({ key: c.key, d: Math.hypot(c.x - npcTile.x, c.y - npcTile.y), tie: dramaHash(`${seed}:${c.key}`) }));
  ok.sort((a, b) => a.d - b.d || a.tie - b.tie || cmp(a.key, b.key));
  return ok.slice(0, Math.max(0, max)).map((c) => c.key);
}

/** A free walkable tile >= 4 tiles from `threat`, preferring the same room, clear of waiting characters (via `isFree`). */
export function fleeTarget(
  map: Pick<GeneratedMap, 'walkable' | 'roomAt' | 'cols' | 'rows'>,
  from: Point,
  threat: Point,
  rand: () => number,
  isFree: (p: Point) => boolean,
): Point | null {
  const room = map.roomAt[from.y]?.[from.x] ?? null;
  const same: { p: Point; d: number }[] = [];
  const other: { p: Point; d: number }[] = [];
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) {
      if (map.walkable[y]?.[x] !== 0) continue;
      if (Math.hypot(x - threat.x, y - threat.y) < FLEE_MIN_TILES) continue;
      const p = { x, y };
      if (!isFree(p)) continue;
      const e = { p, d: Math.hypot(x - from.x, y - from.y) };
      ((map.roomAt[y]?.[x] ?? null) === room ? same : other).push(e);
    }
  }
  const list = same.length ? same : other;
  if (!list.length) return null;
  list.sort((a, b) => a.d - b.d || a.p.y - b.p.y || a.p.x - b.p.x);
  const top = list.slice(0, 6);
  return top[Math.min(top.length - 1, Math.floor(rand() * top.length))]?.p ?? null;
}

/** everySec * 1000 * (0.5 .. 1.5), seeded by (floorKey, bucket). */
export function nextEncounterDelayMs(floorKey: string, bucket: number, everySec: number): number {
  return everySec * 1000 * (0.5 + dramaRng(`${floorKey}:npc:${bucket}`)());
}

const humanize = (kind: string): string => kind.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** `theme.npcs?.skins[kind]`, else a neutral built-in skin. */
export function npcSkin(theme: Pick<ThemeDefinition, 'npcs'>, kind: NpcKind): NpcSkinOf {
  return theme.npcs?.skins[kind] ?? { name: humanize(kind), color: 0x8e8e9e, lines: [], jingle: 0 };
}
