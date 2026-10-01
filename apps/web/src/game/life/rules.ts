import type { Agent } from '@tagconn/shared';
import { dramaRng } from '../drama';
import type { FurnitureKind, GeneratedMap, PlacedFurniture, Point } from '../procgen/types';
import type { LifeActivity, LifeContent, ThemeDefinition } from '../themes/types';

export interface Kickoff {
  sessionId: string;
  hostAgentId: string;
  inviteeAgentIds: string[];
  at: number;
}

/** A subagent that started up to this long before the host turned `delegating` still counts. */
const LEAD_MS = 2000;

interface Window {
  at: number;
  until: number;
  done: boolean;
  /** The host was `delegating` at the last observe (a window reopens only after it stopped and started again). */
  delegating: boolean;
}

export class KickoffTracker {
  private windows = new Map<string, Window>();

  /** A main agent turning `delegating` opens a window [at - 2 s, at + windowSec]; subagents of that session whose
   *  startedAt falls inside are counted; at >= 2 the kickoff is returned ONCE and the window closes. Windows expire. */
  observe(agents: readonly Agent[], nowMs: number, windowSec: number): Kickoff[] {
    const out: Kickoff[] = [];
    const mains = agents.filter((a) => a.isMain);
    const liveIds = new Set(mains.map((a) => a.id));
    for (const id of [...this.windows.keys()]) if (!liveIds.has(id)) this.windows.delete(id);

    for (const host of mains) {
      const delegating = host.status === 'active' && host.activity === 'delegating';
      let w = this.windows.get(host.id);
      if (delegating && (!w || (!w.delegating && (w.done || nowMs > w.until)))) {
        w = { at: nowMs, until: nowMs + windowSec * 1000, done: false, delegating: true };
        this.windows.set(host.id, w);
      }
      if (!w) continue;
      w.delegating = delegating;
      if (w.done) continue;
      if (nowMs > w.until) {
        if (!delegating) this.windows.delete(host.id);
        continue;
      }
      const invitees = agents
        .filter((a) => !a.isMain && a.sessionId === host.sessionId && a.startedAt >= w.at - LEAD_MS && a.startedAt <= w.until)
        .map((a) => a.id)
        .sort();
      if (invitees.length >= 2) {
        w.done = true;
        out.push({ sessionId: host.sessionId, hostAgentId: host.id, inviteeAgentIds: invitees, at: w.at });
      }
    }
    return out.sort((a, b) => a.at - b.at || (a.hostAgentId < b.hostAgentId ? -1 : 1));
  }

  clear(): void {
    this.windows.clear();
  }
}

export function standupDue(lastAtMs: number, nowMs: number, everySec: number, idleCount: number, minCast: number): boolean {
  return nowMs - lastAtMs >= everySec * 1000 && idleCount >= minCast;
}

const TABLE_KINDS: readonly FurnitureKind[] = ['table', 'reading-table', 'board-game-table'];
const center = (f: { x: number; y: number; w: number; h: number }): Point => ({ x: f.x + (f.w - 1) / 2, y: f.y + (f.h - 1) / 2 });
const manhattan = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** meeting-room with the largest table → largest table/reading-table/board-game-table anywhere → lounge (table or null).
 *  `allowed` limits rooms (Multiverse realm). Ties by distance to `near`, then room id. */
export function pickVenue(
  map: Pick<GeneratedMap, 'rooms' | 'furniture'>,
  allowed: ReadonlySet<string> | null,
  near: Point,
): { roomId: string; table: PlacedFurniture | null } | null {
  const ok = (roomId: string): boolean => !allowed || allowed.has(roomId);
  const tables = map.furniture.filter((f) => TABLE_KINDS.includes(f.kind) && ok(f.roomId));
  const best = (list: PlacedFurniture[]): PlacedFurniture | null => {
    const sorted = [...list].sort(
      (a, b) =>
        b.w * b.h - a.w * a.h ||
        manhattan(center(a), near) - manhattan(center(b), near) ||
        cmp(a.roomId, b.roomId) ||
        a.y - b.y ||
        a.x - b.x,
    );
    return sorted[0] ?? null;
  };
  const meetingIds = new Set(map.rooms.filter((r) => r.type === 'meeting-room').map((r) => r.id));
  const t = best(tables.filter((f) => meetingIds.has(f.roomId))) ?? best(tables);
  if (t) return { roomId: t.roomId, table: t };
  const lounges = map.rooms
    .filter((r) => r.type === 'lounge' && ok(r.id))
    .sort(
      (a, b) =>
        manhattan(center(a.interior), near) - manhattan(center(b.interior), near) || cmp(a.id, b.id),
    );
  const lounge = lounges[0];
  return lounge ? { roomId: lounge.id, table: null } : null;
}

/** One seeded invitee who dawdles; null with < 2 invitees. */
export function pickStraggler(inviteeKeys: readonly string[], seed: string): string | null {
  if (inviteeKeys.length < 2) return null;
  const sorted = [...inviteeKeys].sort(cmp);
  return sorted[Math.floor(dramaRng(`${seed}|straggler`)() * sorted.length)]!;
}

/** Weighted seeded pick among activities whose requires is [] or intersects `available`, with cast[0] <= freeCast. */
export function pickActivity(
  list: readonly LifeActivity[],
  available: ReadonlySet<FurnitureKind>,
  freeCast: number,
  seed: string,
): LifeActivity | null {
  const ok = list
    .filter((a) => a.weight > 0 && a.cast[0] <= freeCast && (a.requires.length === 0 || a.requires.some((k) => available.has(k))))
    .sort((a, b) => cmp(a.id, b.id));
  if (!ok.length) return null;
  const total = ok.reduce((s, a) => s + a.weight, 0);
  let r = dramaRng(`${seed}|activity`)() * total;
  for (const a of ok) {
    r -= a.weight;
    if (r < 0) return a;
  }
  return ok[ok.length - 1]!;
}

/** Nearest item (Manhattan from `from` to the footprint centre) of `kinds` in `allowed` rooms, skipping `taken` ("x,y"). */
export function pickProp(
  furniture: readonly PlacedFurniture[],
  kinds: readonly FurnitureKind[],
  from: Point,
  allowed: ReadonlySet<string> | null,
  taken: ReadonlySet<string>,
): PlacedFurniture | null {
  let best: PlacedFurniture | null = null;
  let bestD = Infinity;
  for (const f of furniture) {
    if (!kinds.includes(f.kind) || (allowed && !allowed.has(f.roomId)) || taken.has(`${f.x},${f.y}`)) continue;
    const d = manhattan(center(f), from);
    if (d < bestD || (d === bestD && best && (f.y < best.y || (f.y === best.y && f.x < best.x)))) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

/** everySec * 1000 * (0.5..1.5), seeded by floor and bucket. */
export function nextLifeDelayMs(floorKey: string, bucket: number, everySec: number): number {
  return everySec * 1000 * (0.5 + dramaRng(`${floorKey}|life|${bucket}`)());
}

export const EMPTY_LIFE: LifeContent = {
  activities: [],
  kickoff: { invite: [], fetch: [], dawdle: [], talk: [], close: [] },
  standup: { invite: [], fetch: [], dawdle: [], talk: [], close: [] },
};

export function lifeFor(theme: Pick<ThemeDefinition, 'life'>): LifeContent {
  return theme.life ?? EMPTY_LIFE;
}
