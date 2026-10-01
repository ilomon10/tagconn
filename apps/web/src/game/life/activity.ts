// M13 W2-2: the idle-activity script (docs/design/office-life.md 3.2.6): gather at a prop, play a pose with seeded
// lines, go home. Cosmetic only: it never touches SeatAllocator, and real agent state wins (break-off).
import type { ActorKey } from '../cast';
import type { Character } from '../actors/Character';
import type { Point } from '../procgen/types';
import { LIFE_TIMING, type ActivityPlan, type LifeCtx, type LifeScript, type StartActivity } from './types';

type Phase = 'gather' | 'play' | 'return';

interface Member {
  key: ActorKey;
  spot: Point | null;
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

class ActivityScript implements LifeScript {
  readonly id: string;
  readonly kind = 'activity' as const;
  private members: Member[];
  private phase: Phase = 'gather';
  private phaseAt: number;
  private nextLineAt = 0;
  private started = false;
  private lastNow: number;
  private reserved: Point[];
  private rand: () => number;
  private finished = false;

  constructor(private ctx: LifeCtx, private plan: ActivityPlan, members: Member[], reserved: Point[], now: number) {
    this.id = plan.id;
    this.members = members;
    this.reserved = reserved;
    this.phaseAt = now;
    this.lastNow = now;
    this.rand = ctx.rng(plan.seed);
  }

  get keys(): readonly ActorKey[] {
    return this.members.map((m) => m.key);
  }

  private get walks(): boolean {
    return this.plan.activity.requires.length > 0;
  }

  private claims() {
    return this.ctx.host.claims();
  }

  private clearVisuals(c: Character | undefined) {
    if (!c) return;
    c.setPose(null);
    c.face(null);
    c.clearDrama();
  }

  private releaseTiles() {
    for (const p of this.reserved) this.claims().releaseTile(p, 'activity');
    this.reserved = [];
  }

  private freeSpot(m: Member) {
    if (!m.spot) return;
    const i = this.reserved.findIndex((p) => same(p, m.spot!));
    if (i >= 0) {
      this.claims().releaseTile(this.reserved[i]!, 'activity');
      this.reserved.splice(i, 1);
    }
  }

  /** Takes `m` out of the script; walking characters are left alone, the rest go home. */
  private drop(m: Member, goHome: boolean, force = false) {
    this.members = this.members.filter((x) => x !== m);
    this.freeSpot(m);
    const c = this.ctx.char(m.key);
    this.clearVisuals(c);
    if (c && goHome && (force || !c.walking)) this.ctx.goHome(c);
    this.claims().release(m.key, 'activity');
  }

  private breakOff() {
    for (const m of [...this.members]) {
      const c = this.ctx.char(m.key);
      if (!c || !this.ctx.eligible(m.key, 'idle')) this.drop(m, true);
    }
    if (this.phase !== 'return' && this.members.length < this.plan.activity.cast[0]) this.toReturn(this.lastNow);
  }

  private arrived(m: Member): boolean {
    const c = this.ctx.char(m.key);
    if (!c || c.walking) return false;
    return !m.spot || same(c.tile, m.spot);
  }

  private startWalks() {
    const finder = this.ctx.host.finder();
    for (const m of [...this.members]) {
      const c = this.ctx.char(m.key);
      if (!c || !m.spot) continue;
      const path = finder.find(c.tile, m.spot);
      if (!path) this.drop(m, true);
      else c.walk(path, this.ctx.isSitTile(m.spot));
    }
  }

  private toPlay(now: number) {
    this.phase = 'play';
    this.phaseAt = now;
    this.nextLineAt = now;
    this.releaseTiles();
    const act = this.plan.activity;
    const prop = this.plan.prop;
    const faceX = prop ? (prop.x + prop.w / 2) * 16 : null;
    for (const m of this.members) {
      const c = this.ctx.char(m.key);
      if (!c) continue;
      c.setPose(act.pose);
      c.setDramaEmote(act.emote ?? null);
      c.face(faceX);
    }
  }

  private toReturn(now: number) {
    this.phase = 'return';
    this.phaseAt = now;
    this.releaseTiles();
    for (const m of this.members) {
      const c = this.ctx.char(m.key);
      this.clearVisuals(c);
      if (c) this.ctx.goHome(c);
    }
  }

  step(now: number): 'running' | 'done' {
    this.lastNow = now;
    if (this.finished) return 'done';
    this.breakOff();
    if (!this.members.length) return this.finish();

    if (this.phase === 'gather') {
      if (!this.started) {
        this.started = true;
        if (this.walks) this.startWalks();
        if (!this.members.length) return this.finish();
      }
      const timedOut = now - this.phaseAt >= LIFE_TIMING.convene;
      if (timedOut) {
        for (const m of [...this.members]) if (!this.arrived(m)) this.drop(m, true, true);
        if (this.members.length < this.plan.activity.cast[0]) this.toReturn(now);
        else if (this.members.length) this.toPlay(now);
      } else if (this.members.every((m) => this.arrived(m))) this.toPlay(now);
    } else if (this.phase === 'play') {
      if (now >= this.nextLineAt) {
        const lines = this.plan.activity.lines;
        const m = this.members[Math.floor(this.rand() * this.members.length)];
        const c = m && this.ctx.char(m.key);
        const line = lines[Math.floor(this.rand() * lines.length)];
        if (c && line) this.ctx.say(c, line, LIFE_TIMING.lineSec);
        this.nextLineAt = now + LIFE_TIMING.lineEvery;
      }
      if (now - this.phaseAt >= this.plan.durationMs) this.toReturn(now);
    } else {
      const timedOut = now - this.phaseAt >= LIFE_TIMING.return;
      for (const m of [...this.members]) {
        const c = this.ctx.char(m.key);
        // goHome ran on the previous step (or on entry): done once the walk is over.
        if (timedOut || !c || (!c.walking && now > this.phaseAt)) {
          this.members = this.members.filter((x) => x !== m);
          this.claims().release(m.key, 'activity');
        }
      }
      if (!this.members.length) return this.finish();
    }
    return 'running';
  }

  private finish(): 'done' {
    this.finished = true;
    this.releaseTiles();
    return 'done';
  }

  revoke(key: ActorKey, _now: number): void {
    const m = this.members.find((x) => x.key === key);
    if (!m) return;
    this.members = this.members.filter((x) => x !== m);
    this.freeSpot(m);
    this.clearVisuals(this.ctx.char(key));
    if (this.phase !== 'return' && this.members.length < this.plan.activity.cast[0]) this.toReturn(this.lastNow);
  }

  cancel(now: number): void {
    if (this.phase !== 'return') this.toReturn(now);
  }

  abort(): void {
    for (const m of this.members) {
      this.clearVisuals(this.ctx.char(m.key));
      this.claims().release(m.key, 'activity');
    }
    this.members = [];
    this.finished = true;
    this.releaseTiles();
  }
}

export const startActivity: StartActivity = (ctx, plan, now) => {
  const act = plan.activity;
  const walks = act.requires.length > 0;
  if (!plan.keys.length || plan.keys.length < act.cast[0]) return null;
  if (walks) {
    // Walking scripts are gated by reduced motion and ambient effects; in-place ones are not.
    if (ctx.host.reducedMotion() || ctx.host.office()?.ambientEffects === false) return null;
    if (plan.spots.length < plan.keys.length) return null;
  }
  for (const k of plan.keys) if (!ctx.char(k) || !ctx.eligible(k, 'idle')) return null;

  const claims = ctx.host.claims();
  let script: ActivityScript | null = null;
  const claimed: ActorKey[] = [];
  for (const k of plan.keys) {
    if (!claims.tryClaim(k, 'activity', (key) => script?.revoke(key, now))) {
      for (const c of claimed) claims.release(c, 'activity');
      return null;
    }
    claimed.push(k);
  }
  const reserved: Point[] = [];
  const members: Member[] = plan.keys.map((key, i) => ({ key, spot: walks ? (plan.spots[i] ?? null) : null }));
  for (const m of members) {
    if (!m.spot) continue;
    if (claims.reserveTile(m.spot, 'activity')) reserved.push(m.spot);
    else {
      for (const p of reserved) claims.releaseTile(p, 'activity');
      for (const c of claimed) claims.release(c, 'activity');
      return null;
    }
  }
  script = new ActivityScript(ctx, plan, members, reserved, now);
  return script;
};
