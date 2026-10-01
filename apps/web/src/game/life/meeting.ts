// M13 W2-1: the meeting script (docs/design/office-life.md section 3.2.5). Cosmetic only: it walks characters, sets
// poses/emotes and speaks lines; it never touches SeatAllocator.assign/release (goHome reads the seat only).
import type { ActorKey } from '../cast';
import type { Character } from '../actors/Character';
import type { Point } from '../procgen/types';
import { nearbySpot, ringSpots } from './spots';
import { LIFE_TIMING, type LifeCtx, type LifeRole, type LifeScript, type MeetingPlan, type StartMeeting } from './types';

type Phase = 'invite' | 'convene' | 'fetch' | 'meeting' | 'disperse' | 'done';
/** fetch sub-steps: host goes to the straggler, the two talk, both walk back. */
type FetchStep = 'go' | 'talk' | 'back';

const TILE = 16;
/** A walk that ended off-target is retried this often before the participant is dropped. */
const MAX_WALK_TRIES = 3;
const DAWDLE_RADIUS = 4;

interface Member {
  key: ActorKey;
  role: 'host' | 'invitee';
  /** The seat at the table. */
  spot: Point;
  /** Where the current walk is heading. */
  target: Point | null;
  arrived: boolean;
  tries: number;
  walkId: number;
}

const px = (p: Point): Point => ({ x: p.x * TILE + TILE / 2, y: p.y * TILE + TILE / 2 });
const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
const tileKey = (p: Point): string => `${p.x},${p.y}`;

class MeetingScript implements LifeScript {
  readonly id: string;
  readonly kind: 'kickoff' | 'standup';
  private phase: Phase = 'invite';
  private members = new Map<ActorKey, Member>();
  private straggler: ActorKey | null;
  /** The straggler's dawdle tile. */
  private dawdleAt: Point | null = null;
  private fetchStep: FetchStep = 'go';
  private reserved: Point[] = [];
  private readonly rand: () => number;
  private readonly tableX: number;
  private claimed = new Set<ActorKey>();
  private phaseAt: number;
  private fetchAt = 0;
  private talkAt = 0;
  private nextLineAt = 0;
  private meetingEndAt = 0;
  private cancelled = false;

  constructor(private ctx: LifeCtx, private plan: MeetingPlan, now: number, members: Member[]) {
    this.id = plan.id;
    this.kind = plan.kind;
    this.rand = ctx.rng(`${plan.seed}|meeting`);
    this.straggler = plan.stragglerKey;
    this.phaseAt = now;
    for (const m of members) this.members.set(m.key, m);
    const v = plan.venue;
    const room = ctx.host.map().rooms.find((r) => r.id === v.roomId);
    this.tableX = v.table
      ? (v.table.x + v.table.w / 2) * TILE
      : room
        ? (room.interior.x + room.interior.w / 2) * TILE
        : px(plan.venue.spots[0] ?? { x: 0, y: 0 }).x;
  }

  get keys(): readonly ActorKey[] {
    return [...this.members.keys()];
  }

  /** Claims, reservations and the invite beat. Returns false when the cast cannot be claimed. */
  begin(now: number): boolean {
    const claims = this.ctx.host.claims();
    for (const m of this.members.values()) {
      // A director that claimed the cast for us already holds it as `meeting`.
      const ok = claims.tryClaim(m.key, 'meeting', (k) => this.revoke(k, this.phaseAt)) || claims.holder(m.key) === 'meeting';
      if (!ok) {
        this.abort();
        return false;
      }
      this.claimed.add(m.key);
    }
    for (const p of this.plan.venue.spots) if (claims.reserveTile(p, 'meeting')) this.reserved.push(p);
    for (const m of this.members.values()) this.char(m.key)?.setDramaEmote('megaphone');
    const host = this.char(this.plan.hostKey);
    if (host) this.say(host, this.pick(this.plan.lines.invite));
    this.ctx.sfx({ id: 'meeting-gong', at: px(this.plan.venue.spots[0] ?? this.members.get(this.plan.hostKey)!.spot) });
    this.phaseAt = now;
    return true;
  }

  step(now: number): 'running' | 'done' {
    if (this.isDone()) return 'done';
    if (!this.cancelled && (this.ctx.host.reducedMotion() || this.ctx.host.office()?.ambientEffects === false)) this.cancel(now);
    this.breakOff(now);
    switch (this.phase) {
      case 'invite':
        if (now - this.phaseAt >= LIFE_TIMING.inviteEmote) this.startConvene(now);
        break;
      case 'convene':
        this.stepConvene(now);
        break;
      case 'fetch':
        this.stepFetch(now);
        break;
      case 'meeting':
        this.stepMeeting(now);
        break;
      case 'disperse':
        this.stepDisperse(now);
        break;
    }
    return this.isDone() ? 'done' : 'running';
  }

  private isDone(): boolean {
    return this.phase === 'done';
  }

  revoke(key: ActorKey, _now: number): void {
    const m = this.members.get(key);
    if (!m) return;
    this.members.delete(key);
    this.claimed.delete(key);
    this.dropTile(m.spot);
    const c = this.char(key);
    if (c) this.clearLook(c);
    if (this.straggler === key) this.straggler = null;
  }

  cancel(now: number): void {
    this.cancelled = true;
    if (this.phase !== 'disperse' && this.phase !== 'done') this.disperse(now, false);
  }

  abort(): void {
    for (const m of this.members.values()) {
      const c = this.char(m.key);
      if (c) this.clearLook(c);
    }
    this.members.clear();
    this.releaseAll();
    this.phase = 'done';
  }

  // ---------------------------------------------------------------- phases

  private startConvene(now: number): void {
    this.phase = 'convene';
    this.phaseAt = now;
    for (const m of this.members.values()) {
      const c = this.char(m.key);
      if (!c) continue;
      c.setDramaEmote(null);
      if (m.key === this.straggler) {
        // Dawdles near where it stands, deep in a phone call.
        const spot = nearbySpot(this.ctx.host.map(), c.tile, DAWDLE_RADIUS, this.rand, (p) => this.ctx.isFree(p));
        this.dawdleAt = spot;
        c.setPose('phone');
        c.setDramaEmote('phone');
        if (spot) this.walkTo(m, c, spot);
        else m.arrived = true;
      } else {
        this.walkTo(m, c, m.spot);
      }
    }
  }

  private stepConvene(now: number): void {
    this.retryStalled();
    const timedOut = now - this.phaseAt >= LIFE_TIMING.convene;
    const waiting = [...this.members.values()].filter((m) => m.key !== this.straggler && !this.atSpot(m));
    if (waiting.length && !timedOut) return;
    // Whoever did not make it by the timeout is sent home; the meeting goes on without them.
    for (const m of waiting) this.release(m.key, true);
    if (this.straggler && this.members.has(this.straggler) && this.members.size >= 2) this.startFetch(now);
    else this.startMeeting(now);
  }

  private startFetch(now: number): void {
    const host = this.members.get(this.plan.hostKey);
    const st = this.straggler ? this.members.get(this.straggler) : undefined;
    const hc = host && this.char(host.key);
    const sc = st && this.char(st.key);
    if (!host || !st || !hc || !sc) {
      this.startMeeting(now);
      return;
    }
    this.phase = 'fetch';
    this.fetchStep = 'go';
    this.fetchAt = now;
    this.phaseAt = now;
    hc.setDramaEmote('alarm');
    const map = this.ctx.host.map();
    const roomId = map.roomAt[sc.tile.y]?.[sc.tile.x] ?? this.plan.venue.roomId;
    const next = ringSpots(map, { x: sc.tile.x, y: sc.tile.y, w: 1, h: 1, roomId }, 1, (p) => this.ctx.isFree(p))[0];
    if (next) this.walkTo(host, hc, next);
    else {
      // No free neighbour: walk up to the straggler's tile and stop one short.
      const path = this.ctx.host.finder().find(hc.tile, sc.tile);
      const short = path && path.length > 1 ? path.slice(0, -1) : null;
      if (short) this.walkPath(host, hc, short[short.length - 1]!, short);
      else host.arrived = true;
    }
  }

  private stepFetch(now: number): void {
    const host = this.members.get(this.plan.hostKey);
    const st = this.straggler ? this.members.get(this.straggler) : undefined;
    const hc = host && this.char(host.key);
    if (!host || !hc) return;
    const timedOut = now - this.fetchAt >= LIFE_TIMING.fetch;
    if (timedOut && st && this.fetchStep !== 'back') {
      // The straggler never came round: let it go and carry on without it.
      this.release(st.key, true);
      this.straggler = null;
    }
    if (!this.straggler || !this.members.has(this.straggler)) {
      if (this.fetchStep !== 'back') {
        this.fetchStep = 'back';
        hc.setDramaEmote(null);
        hc.face(null);
        this.walkTo(host, hc, host.spot);
      }
      this.retryStalled();
      if (this.atSpot(host)) this.startMeeting(now);
      return;
    }
    const sc = this.char(st!.key);
    if (!sc) return;
    if (this.fetchStep === 'go') {
      this.retryStalled();
      if (!host.arrived && !(this.adjacent(hc.tile, sc.tile) && !hc.walking)) return;
      this.fetchStep = 'talk';
      this.talkAt = now;
      hc.face(sc.x);
      sc.face(hc.x);
      this.say(hc, this.pick(this.plan.lines.fetch));
      return;
    }
    if (this.fetchStep === 'talk') {
      if (now - this.talkAt < LIFE_TIMING.replyDelay) return;
      this.fetchStep = 'back';
      this.say(sc, this.pick(this.plan.lines.dawdle));
      for (const [m, c] of [[host, hc], [st!, sc]] as const) {
        c.face(null);
        c.setPose(null);
        c.setDramaEmote(m === st ? 'laugh' : null);
        this.walkTo(m, c, m.spot);
      }
      return;
    }
    this.retryStalled();
    if (this.atSpot(host) && this.atSpot(st!)) this.startMeeting(now);
  }

  private startMeeting(now: number): void {
    this.phase = 'meeting';
    this.phaseAt = now;
    this.releaseTiles();
    for (const m of this.members.values()) {
      const c = this.char(m.key);
      if (!c) continue;
      c.setDramaEmote(null);
      c.setPose(this.ctx.isSitTile(m.spot) ? 'sit' : 'chat');
      c.face(this.tableX);
    }
    this.nextLineAt = now + LIFE_TIMING.lineEvery / 2;
    this.meetingEndAt = now + this.plan.meetingMs;
  }

  private stepMeeting(now: number): void {
    if (now >= this.meetingEndAt) {
      this.disperse(now, true);
      return;
    }
    if (now < this.nextLineAt) return;
    this.nextLineAt = now + LIFE_TIMING.lineEvery;
    const keys = [...this.members.keys()];
    const c = this.char(keys[Math.floor(this.rand() * keys.length)]!);
    if (c) this.say(c, this.pick(this.plan.lines.talk));
  }

  private disperse(now: number, close: boolean): void {
    const host = this.char(this.plan.hostKey);
    if (close && host && this.members.has(this.plan.hostKey)) this.say(host, this.pick(this.plan.lines.close));
    this.phase = 'disperse';
    this.phaseAt = now;
    this.releaseTiles();
    for (const m of this.members.values()) {
      const c = this.char(m.key);
      if (!c) continue;
      this.clearLook(c, close);
      this.ctx.goHome(c);
    }
  }

  private stepDisperse(now: number): void {
    const timedOut = now - this.phaseAt >= LIFE_TIMING.return;
    // The first step after goHome may still see the walk just started; a character that is walking is not home yet.
    for (const m of [...this.members.values()]) {
      const c = this.char(m.key);
      if (!c || !c.walking || timedOut) this.drop(m.key);
    }
    if (this.members.size === 0) {
      this.releaseAll();
      this.phase = 'done';
    }
  }

  // ---------------------------------------------------------------- break-off

  /** A participant that is no longer eligible leaves at once; a lost host or a lone participant ends the meeting. */
  private breakOff(now: number): void {
    if (this.phase === 'disperse' || this.phase === 'done') return;
    for (const m of [...this.members.values()]) {
      const c = this.char(m.key);
      const role: LifeRole = m.role === 'host' ? 'host' : this.kind === 'kickoff' ? 'invitee' : 'idle';
      if (!c || !this.ctx.eligible(m.key, role)) this.release(m.key, !!c);
    }
    if (!this.members.has(this.plan.hostKey) || this.members.size < 2) this.disperse(now, false);
  }

  /** Remove a participant mid-script. Walking ones are left alone; the rest go home. */
  private release(key: ActorKey, goHome: boolean): void {
    const m = this.members.get(key);
    if (!m) return;
    const c = this.char(key);
    this.members.delete(key);
    this.dropTile(m.spot);
    if (this.straggler === key) this.straggler = null;
    if (this.dawdleAt && key === this.plan.stragglerKey) this.dawdleAt = null;
    if (c) {
      this.clearLook(c);
      if (goHome && !c.walking && !c.leaving && !c.gone) this.ctx.goHome(c);
    }
    if (this.claimed.delete(key)) this.ctx.host.claims().release(key, 'meeting');
  }

  /** Done with a participant at the end: release its claim only. */
  private drop(key: ActorKey): void {
    this.members.delete(key);
    if (this.claimed.delete(key)) this.ctx.host.claims().release(key, 'meeting');
  }

  // ---------------------------------------------------------------- helpers

  private char(key: ActorKey): Character | undefined {
    return this.ctx.char(key);
  }

  private pick(pool: readonly string[]): string {
    return pool.length ? pool[Math.floor(this.rand() * pool.length)]! : '';
  }

  private say(c: Character, line: string): void {
    if (line) this.ctx.say(c, line, LIFE_TIMING.lineSec);
  }

  private clearLook(c: Character, keepBubble = false): void {
    c.setDramaEmote(null);
    c.setPose(null);
    c.face(null);
    if (!keepBubble) c.clearDrama();
  }

  private adjacent(a: Point, b: Point): boolean {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1;
  }

  private atSpot(m: Member): boolean {
    const c = this.char(m.key);
    return !!c && !c.walking && (m.arrived || same(c.tile, m.spot)) && (!m.target || same(c.tile, m.target));
  }

  private walkTo(m: Member, c: Character, to: Point): void {
    const path = same(c.tile, to) ? [c.tile] : this.ctx.host.finder().find(c.tile, to);
    if (!path) {
      // Unreachable: stand where we are and count as arrived so the meeting is not stuck.
      m.target = null;
      m.arrived = true;
      m.tries = MAX_WALK_TRIES;
      return;
    }
    this.walkPath(m, c, to, path);
  }

  private walkPath(m: Member, c: Character, to: Point, path: Point[]): void {
    const id = ++m.walkId;
    m.target = to;
    m.arrived = false;
    c.face(null);
    const seated = this.phase !== 'disperse' && same(to, m.spot) && this.ctx.isSitTile(to);
    // walk() may call back at once (already there), so the state above is set first.
    c.walk(path, seated, () => {
      if (m.walkId === id) m.arrived = true;
    });
  }

  /** A walk that stopped short (another system took the character) is restarted a few times, then given up. */
  private retryStalled(): void {
    for (const m of this.members.values()) {
      const c = this.char(m.key);
      if (!c || c.walking || m.arrived || !m.target) continue;
      if (same(c.tile, m.target)) {
        m.arrived = true;
      } else if (m.tries < MAX_WALK_TRIES) {
        m.tries++;
        this.walkTo(m, c, m.target);
      } else {
        m.arrived = true;
        m.target = c.tile;
      }
    }
  }

  private dropTile(p: Point): void {
    const k = tileKey(p);
    const i = this.reserved.findIndex((r) => tileKey(r) === k);
    if (i < 0) return;
    this.reserved.splice(i, 1);
    this.ctx.host.claims().releaseTile(p, 'meeting');
  }

  private releaseTiles(): void {
    for (const p of this.reserved) this.ctx.host.claims().releaseTile(p, 'meeting');
    this.reserved = [];
  }

  private releaseAll(): void {
    this.releaseTiles();
    const claims = this.ctx.host.claims();
    for (const k of this.claimed) claims.release(k, 'meeting');
    this.claimed.clear();
  }
}

export const startMeeting: StartMeeting = (ctx, plan, now) => {
  if (ctx.host.reducedMotion() || ctx.host.office()?.ambientEffects === false) return null;
  const spots = plan.venue.spots;
  const members: Member[] = [];
  const add = (key: ActorKey, role: Member['role'], spot: Point | undefined) => {
    if (spot && ctx.char(key)) members.push({ key, role, spot, target: null, arrived: false, tries: 0, walkId: 0 });
  };
  add(plan.hostKey, 'host', spots[0]);
  plan.inviteeKeys.forEach((k, i) => add(k, 'invitee', spots[i + 1]));
  if (members.length < 2 || members[0]?.key !== plan.hostKey) return null;
  const script = new MeetingScript(ctx, plan, now, members);
  return script.begin(now) ? script : null;
};
