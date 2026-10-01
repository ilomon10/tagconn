// M13 W2-5: brief cosmetic NPC reactions (docs/design/office-life.md 3.5.4). Idle cast characters flee / gather /
// chase for a few seconds, then walk home. Never touches SeatAllocator.assign/release; waiting characters never react.
import type { ActorKey } from '../cast';
import { isIdleEligible, waitingTiles } from '../cosmetic/eligible';
import { LIFE_TIMING } from '../life/types';
import { ringSpots } from '../life/spots';
import type { Point } from '../procgen/types';
import type { Character } from '../actors/Character';
import { fleeTarget, pickReactors } from './rules';
import { NPC_TIMING, type CreateReactions, type NpcActor, type NpcHost, type ReactionKind } from './types';

const tileKey = (p: Point): string => `${p.x},${p.y}`;

interface Reactor {
  key: ActorKey;
  npc: NpcActor;
  kind: ReactionKind;
  endAt: number;
  phase: 'active' | 'returning';
  returnAt: number;
  spot: Point | null;
  nextRepath: number;
}

export const createReactions: CreateReactions = (host: NpcHost, rng) => {
  const reactors = new Map<ActorKey, Reactor>();
  const spots = new Map<string, Point>(); // tiles reserved as 'reaction'

  const char = (key: ActorKey): Character | undefined => {
    const c = host.actors().get(key);
    return c && !c.gone ? c : undefined;
  };
  const agentOf = (c: Character) => (c.boundAgentId ? host.agents().find((a) => a.id === c.boundAgentId) : undefined);
  const eligible = (c: Character): boolean => isIdleEligible(c, agentOf(c));

  const occupiedTiles = (): Set<string> => {
    const out = new Set<string>();
    for (const c of host.actors().values()) if (!c.gone) out.add(tileKey(c.tile));
    return out;
  };

  const freeTile = (p: Point, waiting: readonly Point[], occupied: ReadonlySet<string>): boolean => {
    const m = host.map();
    if (m.walkable[p.y]?.[p.x] !== 0) return false;
    if (host.seats().occupant(p)) return false;
    if (host.claims().isTileReserved(p)) return false;
    if (occupied.has(tileKey(p))) return false;
    return !waiting.some((w) => Math.max(Math.abs(w.x - p.x), Math.abs(w.y - p.y)) <= 2);
  };

  const reserve = (p: Point): boolean => {
    if (!host.claims().reserveTile(p, 'reaction')) return false;
    spots.set(tileKey(p), p);
    return true;
  };
  const unreserve = (p: Point | null): void => {
    if (!p || !spots.delete(tileKey(p))) return;
    host.claims().releaseTile(p, 'reaction');
  };

  const walkTo = (c: Character, to: Point): boolean => {
    const path = host.finder().find(c.tile, to);
    if (!path) return false;
    c.walk(path, false);
    return true;
  };

  const goHome = (c: Character): boolean => {
    const seat = host.seats().get(c.key);
    if (!seat) return false;
    const path = host.finder().find(c.tile, seat);
    if (path) c.walk(path, seat.seated, () => drop(c.key));
    else {
      c.teleport(seat);
      c.setSeated(seat.seated);
    }
    return true;
  };

  /** Forget a reactor and release its claim and tile; the character is not moved. */
  function drop(key: ActorKey): void {
    const r = reactors.get(key);
    if (!r) return;
    reactors.delete(key);
    unreserve(r.spot);
    host.claims().release(key, 'reaction');
  }

  const clear = (c: Character): void => {
    c.clearDrama();
    c.setPose(null);
    c.face(null);
  };

  function begin(r: Reactor, c: Character, now: number, waiting: readonly Point[], occupied: ReadonlySet<string>): void {
    const npcTile = r.npc.char.tile;
    const rand = rng(`${host.floorKey()}:react:${r.npc.id}:${r.key}`);
    rand(); // the first draw is the duration
    if (r.kind === 'flee') {
      c.setDramaEmote('alarm');
      const to = fleeTarget(host.map(), c.tile, npcTile, rand, (p) => freeTile(p, waiting, occupied) && !spots.has(tileKey(p)));
      if (to && reserve(to)) {
        r.spot = to;
        walkTo(c, to);
      }
    } else if (r.kind === 'gather') {
      c.setDramaEmote(r.npc.kind === 'office-cat' ? 'heart' : 'laugh');
      c.face(r.npc.char.x);
      const m = host.map();
      const roomId = m.roomAt[npcTile.y]?.[npcTile.x];
      const free = (p: Point) => freeTile(p, waiting, occupied) && !spots.has(tileKey(p));
      const ring = roomId
        ? ringSpots(m, { x: npcTile.x, y: npcTile.y, w: 1, h: 1, roomId }, 8, free)
        : [{ x: npcTile.x - 1, y: npcTile.y }, { x: npcTile.x + 1, y: npcTile.y }, { x: npcTile.x, y: npcTile.y - 1 }, { x: npcTile.x, y: npcTile.y + 1 }].filter(free);
      const to = ring[0];
      if (to && reserve(to)) {
        r.spot = to;
        walkTo(c, to);
      }
    } else {
      c.setDramaEmote('alarm');
      r.nextRepath = now;
    }
  }

  function chase(r: Reactor, c: Character, now: number): void {
    if (now < r.nextRepath) return;
    r.nextRepath = now + NPC_TIMING.chaseRepath;
    const to = r.npc.char.tile;
    if (Math.max(Math.abs(c.tile.x - to.x), Math.abs(c.tile.y - to.y)) <= 1) return;
    const path = host.finder().find(c.tile, to);
    if (path && path.length > 2) c.walk(path.slice(0, -1), false); // stop one tile short
  }

  return {
    start(npc, kind, now) {
      const office = host.office();
      const settings = office?.npcs;
      if (!settings?.allowChaos || host.lowQuality() || host.reducedMotion() || !office?.ambientEffects) return 0;
      if (npc.char.gone || npc.char.leaving) return 0;
      const claims = host.claims();
      const cands = [];
      for (const [key, c] of host.actors()) {
        if (c.gone || c.walking || !eligible(c)) continue;
        const h = claims.holder(key);
        if (h !== undefined && h !== 'drama' && h !== 'activity') continue;
        cands.push({ key, x: c.tile.x, y: c.tile.y });
      }
      const waiting = waitingTiles(host.actors().values());
      const npcTile = npc.char.tile;
      const picked = pickReactors(cands, npcTile, waiting, settings.maxReactors, `${host.floorKey()}:react:${npc.id}`);
      const started: Reactor[] = [];
      for (const key of picked) {
        const c = char(key);
        if (!c) continue;
        // A lower priority holder (drama/activity) is revoked synchronously by tryClaim.
        if (!claims.tryClaim(key, 'reaction', (k) => revoke(k))) continue;
        const dur = NPC_TIMING.reactMin + rng(`${host.floorKey()}:react:${npc.id}:${key}`)() * NPC_TIMING.reactSpan;
        const r: Reactor = { key, npc, kind, endAt: now + dur, phase: 'active', returnAt: 0, spot: null, nextRepath: 0 };
        reactors.set(key, r);
        started.push(r);
      }
      const occupied = occupiedTiles();
      for (const r of started) {
        const c = char(r.key);
        if (c) begin(r, c, now, waiting, occupied);
      }
      return started.length;
    },

    step(now) {
      for (const r of [...reactors.values()]) {
        const c = char(r.key);
        if (!c) {
          drop(r.key);
          continue;
        }
        if (r.phase === 'active' && (r.npc.char.gone || r.npc.char.leaving)) {
          // The NPC this one reacts to is gone: stop chasing / gathering and walk home.
          clear(c);
          drop(r.key);
          if (!c.leaving) goHome(c);
          continue;
        }
        if (r.phase === 'returning') {
          if (!c.walking || now - r.returnAt >= LIFE_TIMING.return) drop(r.key);
          continue;
        }
        if (!eligible(c)) {
          // Real state wins: leave it alone when walking, otherwise send it back to its seat.
          clear(c);
          const wasWalking = c.walking;
          drop(r.key);
          if (!wasWalking && !c.leaving) goHome(c);
          continue;
        }
        if (now >= r.endAt) {
          clear(c);
          r.phase = 'returning';
          r.returnAt = now;
          unreserve(r.spot);
          r.spot = null;
          if (!goHome(c)) drop(r.key);
          continue;
        }
        if (r.kind === 'chase') chase(r, c, now);
      }
    },

    cancelAll(sendHome) {
      for (const r of [...reactors.values()]) {
        const c = char(r.key);
        drop(r.key);
        if (!c) continue;
        clear(c);
        if (sendHome && !c.leaving) goHome(c);
      }
    },

    cancelFor(npc) {
      for (const r of [...reactors.values()]) {
        if (r.npc !== npc) continue;
        const c = char(r.key);
        drop(r.key);
        if (!c) continue;
        clear(c);
        if (!c.leaving) goHome(c);
      }
    },

    activeKeys() {
      return new Set(reactors.keys());
    },
  };

  /** A meeting took `key` (its claim is already gone): drop it without moving it. */
  function revoke(key: ActorKey): void {
    const r = reactors.get(key);
    if (!r) return;
    reactors.delete(key);
    unreserve(r.spot);
    const c = char(key);
    if (c) clear(c);
  }
};
