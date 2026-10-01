// M13 W2-4: the NPC script runner (docs/design/office-life.md 3.5.3). Walks one NPC through its EncounterDef steps.
// Cosmetic only: never touches the SeatAllocator; targets keep WAITING_CLEARANCE_TILES from waiting characters.
import { WAITING_CLEARANCE_TILES } from '../cosmetic/types';
import { isIdleEligible } from '../cosmetic/eligible';
import { propSpots, ringSpots } from '../life/spots';
import type { GeneratedRoom, Point } from '../procgen/types';
import { npcSkin } from './rules';
import { NPC_TIMING, type CreateScriptRunner, type NpcActor, type NpcScriptCtx, type NpcStep, type NpcTarget } from './types';

const TILE = 16;
const px = (p: Point): Point => ({ x: p.x * TILE + 8, y: p.y * TILE + 14 });
const cheb = (a: Point, b: Point): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
/** Per-step scratch; replaced whenever the step index changes. */
interface StepState { index: number; [k: string]: unknown }

export const createScriptRunner: CreateScriptRunner = (ctx: NpcScriptCtx) => {
  const { host } = ctx;

  /** A free-tile predicate; the occupied-tile set is built once per call, not once per tile. */
  const freeFn = (waiting: readonly Point[]): ((p: Point) => boolean) => {
    const map = host.map();
    const occupied = new Set<string>();
    for (const c of host.actors().values()) if (!c.gone) occupied.add(`${c.tile.x},${c.tile.y}`);
    return (p) => {
      if (map.walkable[p.y]?.[p.x] !== 0) return false;
      if (waiting.some((w) => cheb(w, p) <= WAITING_CLEARANCE_TILES)) return false;
      if (host.claims().isTileReserved(p)) return false;
      return !occupied.has(`${p.x},${p.y}`);
    };
  };

  const pickFrom = (list: readonly Point[], rand: () => number): Point | null => (list.length ? list[Math.floor(rand() * list.length)]! : null);

  const roomTile = (room: GeneratedRoom, rand: () => number, free: (p: Point) => boolean): Point | null => pickFrom(room.tiles.filter(free), rand);

  const corridorTile = (rand: () => number, free: (p: Point) => boolean): Point | null => {
    const map = host.map();
    const out: Point[] = [];
    for (let y = 0; y < map.rows; y++) for (let x = 0; x < map.cols; x++) if (map.roomAt[y]?.[x] == null && free({ x, y })) out.push({ x, y });
    return pickFrom(out, rand);
  };

  const anyRoomTile = (rand: () => number, free: (p: Point) => boolean): Point | null => {
    const rooms = host.map().rooms;
    const start = Math.floor(rand() * rooms.length);
    for (let i = 0; i < rooms.length; i++) {
      const t = roomTile(rooms[(start + i) % rooms.length]!, rand, free);
      if (t) return t;
    }
    return null;
  };

  const crowdTile = (npc: NpcActor, rand: () => number, free: (p: Point) => boolean): Point | null => {
    const map = host.map();
    const agents = new Map(host.agents().map((a) => [a.id, a]));
    const byRoom = new Map<string, Point[]>();
    for (const c of host.actors().values()) {
      if (!isIdleEligible(c, c.boundAgentId ? agents.get(c.boundAgentId) : undefined)) continue;
      const room = map.roomAt[c.tile.y]?.[c.tile.x];
      if (!room) continue;
      byRoom.set(room, [...(byRoom.get(room) ?? []), c.tile]);
    }
    let best: string | null = null;
    for (const [room, tiles] of byRoom) if (!best || tiles.length > byRoom.get(best)!.length || (tiles.length === byRoom.get(best)!.length && room < best)) best = room;
    if (best) {
      const near = byRoom.get(best)![0]!;
      const cands = (map.rooms.find((r) => r.id === best)?.tiles ?? []).filter(free).sort((a, b) => cheb(a, near) - cheb(b, near) || a.y - b.y || a.x - b.x);
      const t = cands.slice(0, 4)[Math.floor(rand() * Math.min(4, cands.length))];
      if (t) return t;
    }
    return anyRoomTile(rand, free);
  };

  const entranceTile = (free: (p: Point) => boolean): Point | null => {
    const map = host.map();
    const desk = map.furniture.find((f) => f.kind === 'reception-desk');
    const near = desk ? ringSpots(map, desk, 4, free)[0] : undefined;
    if (near) return near;
    const s = map.spawn;
    const ring = [{ x: s.x, y: s.y + 1 }, { x: s.x + 1, y: s.y }, { x: s.x - 1, y: s.y }, { x: s.x, y: s.y - 1 }, { x: s.x + 1, y: s.y + 1 }, { x: s.x - 1, y: s.y + 1 }];
    return ring.find(free) ?? (free(s) ? s : null);
  };

  const resolve = (npc: NpcActor, target: NpcTarget, seed: string): Point | null => {
    const map = host.map();
    const waiting = ctx.waitingTiles();
    const free = freeFn(waiting);
    const rand = ctx.rng(seed);
    if (target === 'corridor') return corridorTile(rand, free);
    if (target === 'entrance') return entranceTile(free);
    if (target === 'crowd') return crowdTile(npc, rand, free);
    if ('furniture' in target) {
      const from = npc.char.tile;
      const items = map.furniture
        .filter((f) => target.furniture.includes(f.kind))
        .sort((a, b) => cheb(a, from) - cheb(b, from) || a.y - b.y || a.x - b.x);
      for (const item of items) {
        const spot = propSpots(map, item, 1, free)[0];
        if (spot) return spot;
      }
      return null;
    }
    const rooms = map.rooms.filter((r) => target.rooms.includes(r.type));
    const start = rooms.length ? Math.floor(rand() * rooms.length) : 0;
    for (let i = 0; i < rooms.length; i++) {
      const t = roomTile(rooms[(start + i) % rooms.length]!, rand, free);
      if (t) return t;
    }
    return null;
  };

  /** Starts a walk (replacing any current one); `st.arrived` flips on arrival. False when there is no route. */
  const startWalk = (npc: NpcActor, st: StepState, to: Point): boolean => {
    const path = host.finder().find(npc.char.tile, to);
    if (!path) return false;
    st.arrived = false;
    npc.char.setPose(null);
    npc.char.walk(path, false, () => { st.arrived = true; });
    return true;
  };

  const exitStep = (npc: NpcActor, st: StepState, now: number): 'running' | 'done' => {
    const { char } = npc;
    if (char.gone) return 'done';
    if (!st.started) {
      st.started = true;
      npc.stepAt = now;
      char.setPose(null);
      char.face(null);
      const path = host.finder().find(char.tile, host.map().spawn);
      char.leave(path);
      ctx.emit(npc, 'left', now);
    } else if (now - npc.stepAt > NPC_TIMING.stepTimeout && !char.leaving) {
      char.leave(null);
    }
    return char.gone ? 'done' : 'running';
  };

  /** Runs the current step; true when it finished and the next should start. */
  const runStep = (npc: NpcActor, step: NpcStep, st: StepState, now: number): boolean => {
    const { char } = npc;
    const seed = `${npc.key}:${npc.stepIndex}`;
    const timedOut = now - npc.stepAt > NPC_TIMING.stepTimeout;
    const skin = npcSkin(host.theme(), npc.kind);
    switch (step.do) {
      case 'enter': {
        const at = px(host.map().spawn);
        ctx.emit(npc, 'appeared', now);
        ctx.sfx({ id: 'door-bell', at });
        ctx.sfx({ id: `npc-jingle-${skin.jingle}`, at });
        return true;
      }
      case 'goto': {
        if (!st.started) {
          st.started = true;
          const to = resolve(npc, step.target, seed);
          if (!to || !startWalk(npc, st, to)) return true;
        }
        if (npc.held) return false;
        return st.arrived === true || timedOut;
      }
      case 'wander': {
        const n = (st.n as number | undefined) ?? 0;
        if (st.leg === undefined || st.arrived === true) {
          if (n >= step.rooms) return true;
          st.n = n + 1;
          st.leg = true;
          const waiting = ctx.waitingTiles();
          const to = anyRoomTile(ctx.rng(`${seed}:${n}`), freeFn(waiting));
          if (!to || !startWalk(npc, st, to)) return true;
          npc.stepAt = now;
          return false;
        }
        if (npc.held) return false;
        if (timedOut) { st.arrived = true; npc.stepAt = now; }
        return false;
      }
      case 'sweep': {
        const n = (st.n as number | undefined) ?? 0;
        if (st.pauseUntil !== undefined) {
          if (npc.held || now < (st.pauseUntil as number)) return false;
          st.pauseUntil = undefined;
          char.setPose(null);
          if (n >= step.tiles) return true;
          st.leg = undefined;
        }
        if (st.leg === undefined) {
          const waiting = ctx.waitingTiles();
          const to = corridorTile(ctx.rng(`${seed}:${n}`), freeFn(waiting));
          st.leg = true;
          if (!to || !startWalk(npc, st, to)) return true;
          npc.stepAt = now;
          return false;
        }
        if (npc.held) return false;
        if (st.arrived === true || timedOut) {
          st.n = n + 1;
          st.arrived = false;
          char.setPose('sweep');
          ctx.sfx({ id: 'mop', at: { x: char.x, y: char.y } });
          st.pauseUntil = now + NPC_TIMING.sweepPause;
        }
        return false;
      }
      case 'bit': {
        if (!st.started) {
          st.started = true;
          npc.stepAt = now;
          const rand = ctx.rng(seed);
          const [lo, hi] = step.sec;
          const sec = lo + rand() * Math.max(0, hi - lo);
          st.durMs = sec * 1000;
          let nearest: { x: number } | null = null;
          let best = Infinity;
          for (const c of host.actors().values()) {
            if (c.gone) continue;
            const d = Math.hypot(c.x - char.x, c.y - char.y);
            if (d < best) { best = d; nearest = c; }
          }
          char.face(nearest ? nearest.x : null);
          if (step.line && skin.lines.length) ctx.say(char, skin.lines[Math.floor(rand() * skin.lines.length)]!, sec);
          const id = step.sfx ?? skin.sound;
          if (id) ctx.sfx({ id, at: { x: char.x, y: char.y } });
          ctx.emit(npc, 'bit', now);
          if (step.react) ctx.react(npc, step.react, now);
        }
        char.setPose(npc.held ? 'chat' : step.pose);
        if (npc.held) return false;
        if (now - npc.stepAt >= (st.durMs as number)) {
          char.setPose(null);
          char.face(null);
          return true;
        }
        return false;
      }
      case 'exit':
        return false;
    }
  };

  return {
    step(npc, now) {
      const sc = npc.scratch;
      if (npc.char.gone) return 'done';
      const prev = (sc.last as number | undefined) ?? now;
      sc.last = now;
      if (sc.t0 === undefined) sc.t0 = now;
      const steps = npc.def.steps;
      const exiting = (): boolean => npc.stepIndex >= steps.length || steps[npc.stepIndex]?.do === 'exit';
      // Held (M14): no timeout progress, except once the exit has begun.
      if (npc.held && !exiting()) { sc.t0 = (sc.t0 as number) + (now - prev); npc.stepAt += now - prev; }
      if (!exiting() && now - (sc.t0 as number) > NPC_TIMING.scriptMax) {
        const at = steps.findIndex((s) => s.do === 'exit');
        npc.stepIndex = at === -1 ? steps.length : at;
        sc.state = undefined;
      }
      for (let guard = 0; guard < steps.length + 2; guard++) {
        let st = sc.state as StepState | undefined;
        if (!st || st.index !== npc.stepIndex) {
          st = { index: npc.stepIndex };
          sc.state = st;
          npc.stepAt = now;
        }
        const step = steps[npc.stepIndex];
        if (!step || step.do === 'exit') return exitStep(npc, st, now);
        if (!runStep(npc, step, st, now)) return 'running';
        npc.stepIndex++;
      }
      return 'running';
    },
  };
};
