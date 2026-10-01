// M13 W2-3: the life director (docs/design/office-life.md 3.2.4). A plain class OfficeScene owns: it detects kickoffs,
// schedules stand-ups and idle activities, and steps the scripts. The script factories are injected, so the director
// never imports meeting.ts / activity.ts. It never touches the SeatAllocator; the scripts claim characters themselves
// (`CosmeticClaims`) and the director only picks who may be asked.
import type { Agent, Settings } from "@tagconn/shared";
import type { ActorKey } from "../cast";
import type { Character } from "../actors/Character";
import { isIdleEligible, waitingTiles } from "../cosmetic/eligible";
import { dramaBucket, dramaRng } from "../drama";
import type {
  FurnitureKind,
  GeneratedMap,
  GeneratedRoom,
  PlacedFurniture,
  Point,
} from "../procgen/types";
import { sfxBus } from "../sfxBus";
import {
  KickoffTracker,
  lifeFor,
  nextLifeDelayMs,
  pickActivity,
  pickProp,
  pickStraggler,
  pickVenue,
  standupDue,
  type Kickoff,
} from "./rules";
import { nearWaiting, propSpots, ringSpots, sitTiles } from "./spots";
import {
  LIFE_TIMING,
  type ActivityPlan,
  type LifeCtx,
  type LifeHost,
  type LifeRole,
  type LifeScript,
  type MeetingPlan,
  type StartActivity,
  type StartMeeting,
  type Venue,
} from "./types";

export interface LifeFactories {
  startMeeting: StartMeeting;
  startActivity: StartActivity;
}

interface Entry {
  script: LifeScript;
  kind: "meeting" | "activity";
  /** Multiverse realm index; null on a normal floor. */
  realm: number | null;
  /** "x,y" of the prop an activity uses (so two scripts never pick the same one). */
  propKey: string | null;
  /** Walks to a prop/table: gated by reduced motion. */
  walks: boolean;
  cancelled: boolean;
}

const tileKey = (p: Point) => `${p.x},${p.y}`;
const manhattan = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const FLOOR = "floor";

export class LifeDirector {
  private agentsById = new Map<string, Agent>();
  private tracker = new KickoffTracker();
  private entries: Entry[] = [];
  private lastStandupAt = new Map<string, number>();
  private resetAt = Date.now();
  private nextActivityAt: number | null = null;
  private stepAcc = 0;
  private seq = 0;
  private attempt = 0;
  private sitMap: GeneratedMap | null = null;
  private sits: ReadonlySet<string> = new Set();

  private readonly ctx: LifeCtx;

  constructor(
    private host: LifeHost,
    private f: LifeFactories,
  ) {
    this.ctx = this.makeCtx();
  }

  private makeCtx(): LifeCtx {
    return {
      host: this.host,
      char: (key) => this.char(key),
      eligible: (key, role) => this.eligible(key, role),
      goHome: (c) => this.goHome(c),
      say: (c, line, sec) => {
        if (this.host.office()?.showBubbles) c.sayDrama(line, sec);
      },
      sfx: (e) => sfxBus.emit(e),
      rng: (seed) => dramaRng(seed),
      isFree: (p) => this.isFree(p),
      isSitTile: (p) => this.isSitTile(p),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /** buildWorld / floor change: drop every script at once (no walking), forget timers. */
  reset(): void {
    for (const e of this.entries) e.script.abort();
    this.entries = [];
    this.tracker.clear();
    this.lastStandupAt.clear();
    this.resetAt = Date.now();
    this.nextActivityAt = null;
    this.stepAcc = 0;
    this.attempt = 0;
  }

  destroy(): void {
    this.reset();
    this.agentsById.clear();
    this.sitMap = null;
    this.sits = new Set();
  }

  scripts(): readonly LifeScript[] {
    return this.entries.map((e) => e.script);
  }

  /** End of setOfficeState: re-index agents, open kickoffs, cancel scripts whose flags went off. */
  afterCast(nowMs: number): void {
    const agents = this.host.agents();
    this.agentsById.clear();
    for (const a of agents) this.agentsById.set(a.id, a);
    const life = this.life();
    for (const k of this.tracker.observe(
      agents,
      nowMs,
      life?.kickoffWindowSec ?? 30,
    )) {
      if (life && this.meetingsAllowed()) this.startKickoff(k, nowMs);
    }
    this.checkScripts(Date.now());
  }

  /** Every frame; does real work on a 500 ms throttle. */
  update(_time: number, delta: number): void {
    this.stepAcc += delta;
    if (this.stepAcc < LIFE_TIMING.step) return;
    this.stepAcc = 0;
    const now = Date.now();
    this.checkScripts(now);
    for (const e of [...this.entries]) {
      if (e.script.step(now) === "done")
        this.entries = this.entries.filter((x) => x !== e);
    }
    this.schedule(now);
  }

  // ---------------------------------------------------------------- flags

  private life(): Settings["office"]["life"] | null {
    return this.host.office()?.life ?? null;
  }

  /** Activities need life on and ambient effects on. */
  private lifeAllowed(): boolean {
    const o = this.host.office();
    return !!o && o.life.enabled && o.ambientEffects;
  }

  /** Meetings also stop under reduced motion. */
  private meetingsAllowed(): boolean {
    return this.lifeAllowed() && !this.host.reducedMotion();
  }

  private capacityLeft(): boolean {
    const life = this.life();
    if (!life) return false;
    return (
      this.entries.length < (this.host.lowQuality() ? 1 : life.maxConcurrent)
    );
  }

  private meetingIn(realm: number | null): boolean {
    return this.entries.some((e) => e.kind === "meeting" && e.realm === realm);
  }

  /** Flags off (or reduced motion on, for walking scripts) mid-script: everyone goes home. */
  private checkScripts(now: number): void {
    const allowed = this.lifeAllowed();
    const reduced = this.host.reducedMotion();
    for (const e of this.entries) {
      if (e.cancelled) continue;
      if (!allowed || (reduced && e.walks)) {
        e.cancelled = true;
        e.script.cancel(now);
      }
    }
  }

  // ---------------------------------------------------------------- ctx

  private char(key: ActorKey): Character | undefined {
    const c = this.host.actors().get(key);
    return c && !c.gone ? c : undefined;
  }

  private agentOf(c: Character): Agent | undefined {
    return c.boundAgentId ? this.agentsById.get(c.boundAgentId) : undefined;
  }

  /** Section 3.2.2. Claims are the scripts' business; this only answers "is the character in a state to take part". */
  private eligible(key: ActorKey, role: LifeRole): boolean {
    if (key.startsWith("npc:")) return false;
    const c = this.char(key);
    if (!c || c.leaving || c.isWaiting) return false;
    const agent = this.agentOf(c);
    if (role === "idle") return isIdleEligible(c, agent);
    if (c.lifecycleFrame.state === "resting") return role === "host"; // a stand-up host may be resting
    if (
      c.lifecycleFrame.state !== "quest" ||
      !agent ||
      agent.status !== "active"
    )
      return false;
    // A kickoff pulls freshly spawned subagents, which are almost always mid-tool already: any active one may join.
    if (role === "invitee") return true;
    return (
      agent.activity === "idle" ||
      agent.activity === "thinking" ||
      agent.activity === "delegating"
    );
  }

  private goHome(c: Character): void {
    const seat = this.host.seats().get(c.key);
    if (!seat) return;
    const path = this.host.finder().find(c.tile, seat);
    if (path) c.walk(path, seat.seated);
    else {
      c.teleport(seat);
      c.setSeated(seat.seated);
    }
  }

  private isFree(p: Point): boolean {
    const map = this.host.map();
    if (map.walkable[p.y]?.[p.x] !== 0) return false;
    if (
      this.host.seats().occupant(p) !== undefined ||
      this.host.claims().isTileReserved(p)
    )
      return false;
    const actors = this.host.actors().values();
    for (const c of actors) {
      const t = c.tile;
      if (!c.gone && t.x === p.x && t.y === p.y) return false;
    }
    return !nearWaiting(p, waitingTiles(this.host.actors().values()));
  }

  private isSitTile(p: Point): boolean {
    const map = this.host.map();
    if (this.sitMap !== map) {
      this.sitMap = map;
      this.sits = sitTiles(map);
    }
    return this.sits.has(tileKey(p));
  }

  // ---------------------------------------------------------------- picking

  private realmRooms(c: Character): ReadonlySet<string> | null {
    return this.host.realmRooms(c);
  }

  /** Idle-eligible, unclaimed, standing still: who a stand-up or an activity may ask. */
  private idlePool(): Character[] {
    const claims = this.host.claims();
    const out: Character[] = [];
    for (const [key, c] of this.host.actors()) {
      if (c.walking || !claims.isFree(key) || !this.eligible(key, "idle"))
        continue;
      out.push(c);
    }
    return out.sort((a, b) => cmp(a.key, b.key));
  }

  private roomOf(c: Character): string | null {
    const t = c.tile;
    return this.host.map().roomAt[t.y]?.[t.x] ?? null;
  }

  /** Spots for a meeting: the table's ring, or tiles around the room centre when there is no table. */
  private venueSpots(
    v: { roomId: string; table: PlacedFurniture | null },
    count: number,
  ): Point[] {
    const map = this.host.map();
    const isFree = (p: Point) => this.isFree(p);
    if (v.table) return ringSpots(map, v.table, count, isFree);
    const room = map.rooms.find((r: GeneratedRoom) => r.id === v.roomId);
    if (!room) return [];
    const mid = {
      x: room.interior.x + (room.interior.w - 1) / 2,
      y: room.interior.y + (room.interior.h - 1) / 2,
    };
    const tiles: Point[] = [];
    for (let y = room.interior.y; y < room.interior.y + room.interior.h; y++) {
      for (
        let x = room.interior.x;
        x < room.interior.x + room.interior.w;
        x++
      ) {
        const p = { x, y };
        if (map.roomAt[y]?.[x] === v.roomId && isFree(p)) tiles.push(p);
      }
    }
    tiles.sort(
      (a, b) => manhattan(a, mid) - manhattan(b, mid) || a.y - b.y || a.x - b.x,
    );
    return tiles.slice(0, count);
  }

  // ---------------------------------------------------------------- meetings

  private startKickoff(k: Kickoff, now: number): void {
    const life = this.life()!;
    const hostKey = this.host.keyForAgent(k.hostAgentId);
    const hostChar = hostKey ? this.char(hostKey) : undefined;
    if (!hostKey || !hostChar || !this.eligible(hostKey, "host")) return;
    const realm = hostChar.realmIndex;
    if (
      this.meetingIn(realm) ||
      !this.capacityLeft() ||
      this.host.claims().holder(hostKey) === "meeting"
    )
      return;
    const claims = this.host.claims();
    const invitees: ActorKey[] = [];
    for (const id of k.inviteeAgentIds) {
      const key = this.host.keyForAgent(id);
      const c = key ? this.char(key) : undefined;
      // Anyone may be pulled out of anything, but not out of another meeting or into another realm.
      if (
        !key ||
        !c ||
        key === hostKey ||
        c.realmIndex !== realm ||
        claims.holder(key) === "meeting" ||
        !this.eligible(key, "invitee")
      )
        continue;
      invitees.push(key);
      if (invitees.length >= life.maxMeetingSize - 1) break;
    }
    if (invitees.length < 2) return;
    this.startMeeting(
      "kickoff",
      hostChar,
      invitees,
      now,
      `${k.hostAgentId}|${k.at}`,
    );
  }

  /** Builds the plan (venue, spots, straggler) and hands it to the factory. Invitees beyond the free spots are dropped. */
  private startMeeting(
    kind: "kickoff" | "standup",
    hostChar: Character,
    invitees: ActorKey[],
    now: number,
    seedKey: string,
  ): boolean {
    const life = this.life()!;
    const venue = pickVenue(
      this.host.map(),
      this.realmRooms(hostChar),
      hostChar.tile,
    );
    if (!venue) return false;
    const spots = this.venueSpots(venue, invitees.length + 1);
    const min = kind === "kickoff" ? 3 : 2;
    if (spots.length < min) return false;
    const kept = invitees.slice(0, spots.length - 1);
    const seed = `${this.host.floorKey()}|${kind}|${seedKey}`;
    const content = lifeFor(this.host.themeFor(hostChar));
    const plan: MeetingPlan = {
      id: `${kind}-${++this.seq}`,
      kind,
      hostKey: hostChar.key,
      inviteeKeys: kept,
      stragglerKey: pickStraggler(kept, seed) as ActorKey | null,
      venue: {
        roomId: venue.roomId,
        table: venue.table,
        spots,
      } satisfies Venue,
      lines: kind === "kickoff" ? content.kickoff : content.standup,
      meetingMs: life.meetingSec * 1000,
      seed,
    };
    const script = this.f.startMeeting(this.ctx, plan, now);
    if (!script) return false;
    this.entries.push({
      script,
      kind: "meeting",
      realm: hostChar.realmIndex,
      propKey: null,
      walks: true,
      cancelled: false,
    });
    return true;
  }

  private tryStandups(now: number): void {
    const life = this.life()!;
    if (!this.meetingsAllowed()) return;
    const groups = new Map<number | null, Character[]>();
    for (const c of this.idlePool()) {
      const g = groups.get(c.realmIndex) ?? [];
      g.push(c);
      groups.set(c.realmIndex, g);
    }
    for (const [realm, pool] of [...groups].sort(
      (a, b) => (a[0] ?? -1) - (b[0] ?? -1),
    )) {
      if (!this.capacityLeft()) return;
      const rk = realm === null ? FLOOR : String(realm);
      if (this.meetingIn(realm)) continue;
      const last = this.lastStandupAt.get(rk) ?? this.resetAt;
      if (
        !standupDue(
          last,
          now,
          life.standupEverySec,
          pool.length,
          life.standupMinCast,
        )
      )
        continue;
      const hostChar = pool.find((c) => c.key.startsWith("gm:")) ?? pool[0]!;
      const others = pool
        .filter((c) => c !== hostChar)
        .sort(
          (a, b) =>
            manhattan(a.tile, hostChar.tile) -
              manhattan(b.tile, hostChar.tile) || cmp(a.key, b.key),
        )
        .slice(0, life.maxMeetingSize - 1)
        .map((c) => c.key);
      if (
        others.length &&
        this.startMeeting("standup", hostChar, others, now, `${now}`)
      )
        this.lastStandupAt.set(rk, now);
    }
  }

  // ---------------------------------------------------------------- activities

  private schedule(now: number): void {
    const life = this.life();
    if (!life || !this.lifeAllowed()) {
      this.nextActivityAt = null;
      return;
    }
    this.tryStandups(now);
    const bucket = dramaBucket(now, life.idleActivityEverySec);
    if (this.nextActivityAt === null) {
      this.nextActivityAt =
        now +
        nextLifeDelayMs(
          this.host.floorKey(),
          bucket,
          life.idleActivityEverySec,
        );
      return;
    }
    if (now < this.nextActivityAt) return;
    this.nextActivityAt =
      now +
      nextLifeDelayMs(this.host.floorKey(), bucket, life.idleActivityEverySec);
    if (!this.capacityLeft()) return;
    this.tryActivity(now, bucket);
  }

  private tryActivity(now: number, bucket: number): void {
    const pool = this.idlePool();
    if (!pool.length) return;
    const n = this.attempt++;
    const seed = `${this.host.floorKey()}|${bucket}|${n}`;
    const first = pool[Math.floor(dramaRng(`${seed}|cand`)() * pool.length)]!;
    const realm = first.realmIndex;
    const room = this.roomOf(first);
    const partners = pool
      .filter(
        (c) => c !== first && c.realmIndex === realm && this.roomOf(c) === room,
      )
      .sort(
        (a, b) =>
          manhattan(a.tile, first.tile) - manhattan(b.tile, first.tile) ||
          cmp(a.key, b.key),
      );
    const content = lifeFor(this.host.themeFor(first));
    const allowed = this.realmRooms(first);
    const taken = new Set(
      this.entries.flatMap((e) => (e.propKey ? [e.propKey] : [])),
    );
    // Reduced motion: only in-place activities (requires []), which never look at the available kinds.
    const available = new Set<FurnitureKind>();
    if (!this.host.reducedMotion()) {
      for (const f of this.host.map().furniture) {
        if ((!allowed || allowed.has(f.roomId)) && !taken.has(tileKey(f)))
          available.add(f.kind);
      }
    }
    const activity = pickActivity(
      content.activities,
      available,
      1 + partners.length,
      seed,
    );
    if (!activity) return;
    const rng = dramaRng(`${seed}|plan`);
    const maxCast = Math.min(activity.cast[1], 1 + partners.length);
    let size =
      activity.cast[0] + Math.floor(rng() * (maxCast - activity.cast[0] + 1));
    let keys: ActorKey[];
    let spots: Point[];
    let prop: PlacedFurniture | null = null;
    if (activity.requires.length === 0) {
      keys = [first, ...partners.slice(0, size - 1)].map((c) => c.key);
      spots = keys.map((k) => this.char(k)!.tile);
    } else {
      prop = pickProp(
        this.host.map().furniture,
        activity.requires,
        first.tile,
        allowed,
        taken,
      );
      if (!prop) return;
      spots = propSpots(this.host.map(), prop, size, (p) => this.isFree(p));
      size = Math.min(size, spots.length);
      if (size < activity.cast[0]) return;
      spots = spots.slice(0, size);
      keys = [first, ...partners.slice(0, size - 1)].map((c) => c.key);
    }
    const [lo, hi] = activity.durationSec;
    const plan: ActivityPlan = {
      id: `activity-${++this.seq}`,
      activity,
      keys,
      prop,
      spots,
      durationMs: Math.round((lo + rng() * (hi - lo)) * 1000),
      seed,
    };
    const script = this.f.startActivity(this.ctx, plan, now);
    if (!script) return;
    this.entries.push({
      script,
      kind: "activity",
      realm,
      propKey: prop ? tileKey(prop) : null,
      walks: activity.requires.length > 0,
      cancelled: false,
    });
  }
}
