// M12 G1: the drama director (docs/design/game-office.md section 2.3). A plain class OfficeScene owns: it
// schedules idle antics, steers the cast, and refreshes work-strain overlays. It never touches the
// SeatAllocator (drama walks are cosmetic; a cancelled antic simply walks home) and never imports OfficeScene.
import type { Agent, Settings } from '@tagconn/shared';
import type { ActorKey } from '../cast';
import { CosmeticClaims } from '../cosmetic/claims';
import { isIdleEligible } from '../cosmetic/eligible';
import type { CosmeticClaimsApi } from '../cosmetic/types';
import type { Character } from '../actors/Character';
import {
  isAgentOnARoll,
  observeAgents,
  dramaBucket,
  dramaFor,
  dramaRng,
  nextDramaDelayMs,
  pickAntic,
  pickCast,
  pickExchange,
  strainFor,
  strainLine,
  type DramaCandidate,
} from '../drama';
import { gatherSpots } from '../dramaSpots';
import type { PathFinder } from '../pathfinding';
import type { FurnitureKind, GeneratedMap, PlacedFurniture, Point } from '../procgen/types';
import type { SeatAllocator } from '../seats';
import type { StrainKind, ThemeDefinition } from '../themes';

export interface DramaHost {
  map(): GeneratedMap;
  finder(): PathFinder;
  seats(): SeatAllocator;
  actors(): ReadonlyMap<ActorKey, Character>;
  /** state.agents of this floor (the director indexes them by id each afterCast). */
  agents(): readonly Agent[];
  /** The theme the actor is drawn in (the realm's on the Multiverse, else the floor's). */
  themeFor(c: Character): ThemeDefinition;
  office(): Settings['office'] | undefined;
  floorKey(): string;
  reducedMotion(): boolean;
  /** The scene's shared claims registry (M13); a private one is used when absent. */
  claims?(): CosmeticClaimsApi;
}

const STEP_MS = 500;
const STRAIN_MS = 1000;
/** A cast that has not all arrived after this long gives up and walks home. */
const GATHER_TIMEOUT_MS = 6000;
/** Drama bubbles live this long (seconds); the reply follows the first line by `REPLY_DELAY_MS`. */
const LINE_SECONDS = 3;
const STRAIN_LINE_SECONDS = 4;
const REPLY_DELAY_MS = 1800;
const RETURN_TIMEOUT_MS = 20_000;
/** Antic length (ms), seeded within this range. */
const PLAY_MIN_MS = 6000;
const PLAY_SPAN_MS = 4000;

type Phase = 'gathering' | 'playing' | 'returning';

interface DramaScene {
  roomId: string;
  keys: ActorKey[];
  phase: Phase;
  phaseAt: number;
  emote: Parameters<Character['setDramaEmote']>[0];
  lines: readonly string[];
  playMs: number;
  replied: boolean;
  arrived: Set<ActorKey>;
  /** Tiles reserved for this scene's gather spots. */
  spots: Point[];
}

const tileKey = (p: Point) => `${p.x},${p.y}`;

export class DramaDirector {
  private agentsById = new Map<string, Agent>();
  private attempt = 0;
  private scenes: DramaScene[] = [];
  private reserved = new Set<string>();
  private busy = new Set<ActorKey>();
  private ownClaims = new CosmeticClaims();
  private prevStrain = new Map<ActorKey, StrainKind | null>();
  private nextAt: number | null = null;
  private stepAcc = 0;
  private strainAt = 0;
  private propsMap: GeneratedMap | null = null;
  private roomProps = new Map<string, Set<FurnitureKind>>();

  constructor(private host: DramaHost) {}

  private claims(): CosmeticClaimsApi {
    return this.host.claims?.() ?? this.ownClaims;
  }

  /** buildWorld / floor change: drop every scene and every timer. Characters only lose their drama emote and bubble
   *  (they are about to be teleported, reseated or destroyed; the scene sends resting actors to their new spots). */
  reset(): void {
    for (const c of this.host.actors().values()) c.clearDrama();
    this.dropState();
  }

  private dropState(): void {
    const claims = this.claims();
    for (const s of this.scenes) {
      for (const k of s.keys) claims.release(k, 'drama');
      this.releaseSpots(s);
    }
    this.attempt = 0;
    this.scenes = [];
    this.reserved.clear();
    this.busy.clear();
    this.prevStrain.clear();
    this.nextAt = null;
    this.stepAcc = 0;
    this.strainAt = 0;
    this.propsMap = null;
    this.roomProps.clear();
  }

  /** End of setOfficeState: re-index agents, feed StreakTracker, cancel scenes whose cast became ineligible, refresh strain now. */
  afterCast(nowMs: number): void {
    const agents = this.host.agents();
    this.agentsById.clear();
    for (const a of agents) this.agentsById.set(a.id, a);
    observeAgents(agents, nowMs);
    this.checkScenes(Date.now());
    this.refreshStrain();
  }

  /** Every frame; does real work on a 500 ms throttle (strain refresh, scene steps, scheduling). */
  update(_time: number, delta: number): void {
    this.stepAcc += delta;
    if (this.stepAcc < STEP_MS) return;
    this.stepAcc = 0;
    const now = Date.now();
    if (now - this.strainAt >= STRAIN_MS) this.refreshStrain();
    this.checkScenes(now);
    this.stepScenes(now);
    this.schedule(now);
  }

  destroy(): void {
    this.dropState();
    this.agentsById.clear();
  }

  // ---------------------------------------------------------------- flags

  private cfg() {
    const office = this.host.office();
    return office ? { office, drama: office.drama } : null;
  }

  /** Antics run only with drama on, ambient effects on and a floor of characters. */
  private anticsAllowed(): boolean {
    const c = this.cfg();
    return !!c && c.drama.enabled && c.office.ambientEffects;
  }

  // ---------------------------------------------------------------- strain

  private refreshStrain(): void {
    this.strainAt = Date.now();
    const c = this.cfg();
    const now = Date.now();
    const animated = !!c && c.office.ambientEffects && !this.host.reducedMotion();
    for (const key of this.prevStrain.keys()) if (!this.host.actors().has(key)) this.prevStrain.delete(key);
    for (const [key, ch] of this.host.actors()) {
      const agent = ch.boundAgentId ? this.agentsById.get(ch.boundAgentId) : undefined;
      if (!c || !c.drama.enabled || ch.lifecycleFrame.state !== 'quest' || ch.leaving || ch.gone || !agent) {
        ch.setStrain(null, false);
        this.prevStrain.delete(key);
        continue;
      }
      const kind = strainFor(agent, now, c.drama, isAgentOnARoll(agent.id, now, c.drama));
      ch.setStrain(kind, animated);
      const seen = this.prevStrain.has(key);
      const prev = this.prevStrain.get(key) ?? null;
      this.prevStrain.set(key, kind);
      // Say one line on a null -> kind transition (never the first observation: a rebuild must not re-announce).
      if (seen && prev === null && kind !== null && c.office.showBubbles) {
        const line = strainLine(dramaFor(this.host.themeFor(ch)), kind, `${agent.id}|${kind}`);
        if (line) ch.sayDrama(line, STRAIN_LINE_SECONDS);
      }
    }
  }

  // ---------------------------------------------------------------- eligibility

  private char(key: ActorKey): Character | undefined {
    const c = this.host.actors().get(key);
    return c && !c.gone ? c : undefined;
  }

  /** Whether `c` may still be part of a running scene (walking is allowed: the scene walks it itself). */
  private stillOk(c: Character | undefined): c is Character {
    return !!c && isIdleEligible(c, c.boundAgentId ? this.agentsById.get(c.boundAgentId) : undefined);
  }

  private roomOf(c: Character): string | null {
    const t = c.tile;
    return this.host.map().roomAt[t.y]?.[t.x] ?? null;
  }

  private candidates(): DramaCandidate[] {
    const out: DramaCandidate[] = [];
    for (const [key, c] of this.host.actors()) {
      if (this.busy.has(key) || !this.claims().isFree(key) || c.walking || !this.stillOk(c)) continue;
      const roomId = this.roomOf(c);
      if (roomId === null) continue;
      const t = c.tile;
      out.push({ key, roomId, x: t.x, y: t.y });
    }
    return out;
  }

  // ---------------------------------------------------------------- scenes

  private checkScenes(now: number): void {
    const allowed = this.anticsAllowed();
    const reduced = this.host.reducedMotion();
    for (const s of [...this.scenes]) {
      if (s.phase === 'returning') continue;
      // Flags off (or reduced motion turned on mid-walk): everyone just goes home.
      if (!allowed || (reduced && s.phase === 'gathering' && s.keys.some((k) => this.char(k)?.walking))) {
        this.cancel(s, new Set(), now);
        continue;
      }
      const leave = new Set<ActorKey>();
      for (const key of s.keys) {
        const c = this.char(key);
        // Ineligible, or walking while the scene is playing (something else moved it): leave it alone.
        if (!this.stillOk(c) || (s.phase === 'playing' && c.walking)) leave.add(key);
      }
      if (leave.size) this.cancel(s, leave, now);
    }
  }

  /** Clears drama state; sends everyone except `leaveAlone` (that is not walking) home. */
  private cancel(s: DramaScene, leaveAlone: ReadonlySet<ActorKey>, now: number): void {
    s.phase = 'returning';
    s.phaseAt = now;
    this.releaseSpots(s);
    for (const key of s.keys) {
      const c = this.char(key);
      if (!c) continue;
      c.clearDrama();
      // Walking = something else (an updateCast walk) just sent it elsewhere: leave it. Leaving: nothing to do.
      if ((leaveAlone.has(key) && c.walking) || c.leaving) {
        this.busy.delete(key);
        s.arrived.delete(key);
        continue;
      }
      this.goHome(c);
    }
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

  private releaseSpots(s: DramaScene): void {
    for (const p of s.spots) {
      this.reserved.delete(tileKey(p));
      this.claims().releaseTile(p, 'drama');
    }
    s.spots = [];
  }

  private finish(s: DramaScene): void {
    this.releaseSpots(s);
    this.scenes = this.scenes.filter((x) => x !== s);
    // A key released by `cancel` may already belong to a newer scene: only free the keys no other scene owns.
    for (const k of s.keys) {
      if (this.scenes.some((x) => x.keys.includes(k))) continue;
      this.busy.delete(k);
      this.claims().release(k, 'drama');
    }
  }

  /** A higher priority script took `key` (its claim is already gone): drop it from its scene without moving it, and
   *  send the rest of a pair scene home. */
  private revoke(key: ActorKey): void {
    const s = this.scenes.find((x) => x.keys.includes(key));
    if (!s) return;
    s.keys = s.keys.filter((k) => k !== key);
    s.arrived.delete(key);
    this.busy.delete(key);
    this.char(key)?.clearDrama();
    if (s.keys.length === 0) this.finish(s);
    else if (s.phase !== 'returning') this.cancel(s, new Set(), Date.now());
  }

  private stepScenes(now: number): void {
    const office = this.host.office();
    for (const s of [...this.scenes]) {
      if (s.phase === 'gathering') {
        const chars = s.keys.map((k) => this.char(k));
        const everyoneThere = s.keys.every((k, i) => s.arrived.has(k) || !chars[i]?.walking);
        if (everyoneThere) this.startPlay(s, now);
        else if (now - s.phaseAt > GATHER_TIMEOUT_MS) this.cancel(s, new Set(), now);
      } else if (s.phase === 'playing') {
        if (!s.replied && s.lines.length > 1 && now - s.phaseAt >= REPLY_DELAY_MS) {
          s.replied = true;
          if (office?.showBubbles) this.char(s.keys[1]!)?.sayDrama(s.lines[1]!, LINE_SECONDS);
        }
        if (now - s.phaseAt >= s.playMs) this.endPlay(s, now);
      } else {
        const done = s.keys.every((k) => !this.busy.has(k) || !this.char(k)?.walking);
        if (done || now - s.phaseAt > RETURN_TIMEOUT_MS) this.finish(s);
      }
    }
  }

  private startPlay(s: DramaScene, now: number): void {
    s.phase = 'playing';
    s.phaseAt = now;
    this.releaseSpots(s);
    const showBubbles = !!this.host.office()?.showBubbles;
    s.keys.forEach((k, i) => {
      const c = this.char(k);
      if (!c) return;
      c.setDramaEmote(s.emote);
      if (i === 0 && showBubbles && s.lines[0]) c.sayDrama(s.lines[0], LINE_SECONDS);
    });
  }

  private endPlay(s: DramaScene, now: number): void {
    s.phase = 'returning';
    s.phaseAt = now;
    for (const k of s.keys) {
      const c = this.char(k);
      if (!c) continue;
      c.clearDrama();
      this.goHome(c);
    }
  }

  // ---------------------------------------------------------------- scheduling

  private propsOf(roomId: string): ReadonlySet<FurnitureKind> {
    const map = this.host.map();
    if (this.propsMap !== map) {
      this.propsMap = map;
      this.roomProps.clear();
      for (const f of map.furniture) {
        let set = this.roomProps.get(f.roomId);
        if (!set) this.roomProps.set(f.roomId, (set = new Set()));
        set.add(f.kind);
      }
    }
    return this.roomProps.get(roomId) ?? new Set();
  }

  private schedule(now: number): void {
    const c = this.cfg();
    if (!c || !this.anticsAllowed()) {
      this.nextAt = null;
      return;
    }
    const { idleChatSec } = c.drama;
    const bucket = dramaBucket(now, idleChatSec);
    if (this.nextAt === null) {
      this.nextAt = now + nextDramaDelayMs(this.host.floorKey(), bucket, idleChatSec);
      return;
    }
    if (now < this.nextAt) return;
    this.nextAt = now + nextDramaDelayMs(this.host.floorKey(), bucket, idleChatSec);
    if (this.scenes.length >= Math.max(1, Math.floor(c.office.maxBubbles / 2))) return;
    this.tryStart(now, bucket);
  }

  private tryStart(now: number, bucket: number): void {
    const busyRooms = new Set(this.scenes.map((s) => s.roomId));
    // The attempt counter keeps two attempts in the same bucket from picking the same antic.
    const n = this.attempt++;
    const cast = pickCast(this.candidates(), busyRooms, `${this.host.floorKey()}|${bucket}|${n}`);
    if (!cast) return;
    let keys = cast.keys.slice() as ActorKey[];
    const first = this.char(keys[0]!);
    if (!first) return;
    const props = this.propsOf(cast.roomId);
    const content = dramaFor(this.host.themeFor(first));
    let antic = pickAntic(content, props, keys.length as 1 | 2, `${keys.join('+')}|${bucket}|${n}`);
    if (!antic && keys.length === 2) {
      keys = [keys[0]!];
      antic = pickAntic(content, props, 1, `${keys[0]}|${bucket}|${n}`);
    }
    if (!antic) return;
    const exchange = pickExchange(antic, `${keys.join('+')}|${bucket}|${n}`);
    const scene: DramaScene = {
      roomId: cast.roomId,
      keys,
      phase: 'gathering',
      phaseAt: now,
      emote: antic.emote ?? null,
      lines: exchange,
      playMs: PLAY_MIN_MS + Math.floor(dramaRng(`${keys.join('+')}|${bucket}|${n}|len`)() * PLAY_SPAN_MS),
      replied: false,
      arrived: new Set(),
      spots: [],
    };
    const claims = this.claims();
    const claimed: ActorKey[] = [];
    for (const k of keys) {
      if (!claims.tryClaim(k, 'drama', (rk) => this.revoke(rk))) {
        for (const ck of claimed) claims.release(ck, 'drama');
        return;
      }
      claimed.push(k);
    }
    this.scenes.push(scene);
    for (const k of keys) this.busy.add(k);
    this.gather(scene, antic.props, first);
  }

  /** Sends the cast to the first prop kind present in the room; no prop, no spot, no path or reduced motion = act in place. */
  private gather(s: DramaScene, propKinds: readonly FurnitureKind[], first: Character): void {
    const map = this.host.map();
    const inPlace = () => s.keys.forEach((k) => s.arrived.add(k));
    if (this.host.reducedMotion() || propKinds.length === 0) return inPlace();
    const kind = propKinds.find((p) => map.furniture.some((f) => f.roomId === s.roomId && f.kind === p));
    if (!kind) return inPlace();
    const items = map.furniture.filter((f) => f.roomId === s.roomId && f.kind === kind);
    const ft = first.tile;
    const dist = (f: PlacedFurniture) => Math.abs(f.x + (f.w - 1) / 2 - ft.x) + Math.abs(f.y + (f.h - 1) / 2 - ft.y);
    const prop = items.sort((a, b) => dist(a) - dist(b) || a.y - b.y || a.x - b.x)[0]!;
    const seats = this.host.seats();
    const standing = new Set<string>();
    for (const c of this.host.actors().values()) standing.add(tileKey(c.tile));
    const isFree = (p: Point) => seats.occupant(p) === undefined && !this.reserved.has(tileKey(p)) && !this.claims().isTileReserved(p) && !standing.has(tileKey(p));
    const spots = gatherSpots(map, prop, s.keys.length as 1 | 2, isFree);
    const finder = this.host.finder();
    s.keys.forEach((k, i) => {
      const c = this.char(k);
      const spot = spots[i];
      const path = c && spot ? finder.find(c.tile, spot) : null;
      if (!c || !spot || !path) {
        s.arrived.add(k);
        return;
      }
      this.reserved.add(tileKey(spot));
      this.claims().reserveTile(spot, 'drama');
      s.spots.push(spot);
      c.walk(path, false, () => {
        if (this.scenes.includes(s) && s.phase === 'gathering') s.arrived.add(k);
      });
    });
  }
}
