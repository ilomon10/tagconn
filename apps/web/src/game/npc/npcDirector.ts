// M13 W2-6: the NPC director (docs/design/office-life.md 3.5.5). A plain class OfficeScene owns: it schedules routine
// staff and random encounters, spawns them as Characters through `host.spawnNpc`, and ticks them with the script runner
// and the reaction controller. Cosmetic only: it never touches the SeatAllocator or the cosmetic claims itself.
import type { NpcKind } from '@tagconn/shared';
import { plateOptions } from '../actors/namePlate';
import type { ActorKey } from '../cast';
import type { Character } from '../actors/Character';
import { waitingTiles } from '../cosmetic/eligible';
import { dramaRng } from '../drama';
import { sfxBus } from '../sfxBus';
import { ENCOUNTERS } from './encounters';
import { BurstMeter, janitorDue, nextEncounterDelayMs, npcSkin, pickEncounter } from './rules';
import {
  NPC_TIMING,
  type CreateReactions,
  type CreateScriptRunner,
  type EncounterDef,
  type EncounterEvent,
  type NpcActor,
  type NpcHost,
  type NpcStep,
  type NpcScriptCtx,
  type NpcScriptRunner,
  type ReactionController,
} from './types';

export interface NpcDirectorFactories {
  createScriptRunner: CreateScriptRunner;
  createReactions: CreateReactions;
}

/** Reduced motion: appear at the door, stay one bit's duration (same events), leave. No walking, no reactions. */
export function staticVisit(def: EncounterDef): EncounterDef {
  const bit = def.steps.find((s): s is Extract<NpcStep, { do: 'bit' }> => s.do === 'bit');
  const { react: _react, ...still } = bit ?? { do: 'bit' as const, pose: 'chat' as const, sec: [4, 6] as const };
  return { ...def, static: true, steps: [{ do: 'enter' }, still, { do: 'exit' }] };
}

export class NpcDirector {
  private actors = new Map<ActorKey, NpcActor>();
  private chars = new Map<ActorKey, Character>();
  private runner: NpcScriptRunner;
  private reactions: ReactionController;
  private burst = new BurstMeter();
  private seq = 0;
  private attempt = 0;
  private nextAt: number | null = null;
  private lastJanitorAt: number | null = null;
  private stepAcc = 0;
  private dim = 1;

  constructor(private host: NpcHost, f: NpcDirectorFactories) {
    const ctx: NpcScriptCtx = {
      host,
      rng: dramaRng,
      say: (c, line, sec) => {
        if (this.host.office()?.showBubbles) c.sayDrama(line, sec);
      },
      sfx: (e) => sfxBus.emit(e),
      waitingTiles: () => waitingTiles(this.host.actors().values()),
      react: (npc, kind, now) => {
        const o = this.host.office();
        if (o?.npcs.allowChaos && !this.host.lowQuality()) this.reactions.start(npc, kind, now);
      },
      emit: (npc, phase, now) => this.emitEvent(npc, phase, now),
    };
    this.runner = f.createScriptRunner(ctx);
    this.reactions = f.createReactions(host, dramaRng);
  }

  /** Every NPC Character (the scene draws plates and hit scales for them). */
  npcs(): ReadonlyMap<ActorKey, Character> {
    return this.chars;
  }

  /** buildWorld / applySkin: destroys every NPC; reactors go home when `sendHome`, else are dropped in place. */
  reset(opts?: { sendHome?: boolean }): void {
    this.reactions.cancelAll(!!opts?.sendHome);
    this.removeAll();
    this.burst.clear();
    this.attempt = 0;
    this.nextAt = null;
    this.stepAcc = 0;
  }

  destroy(): void {
    this.reactions.cancelAll(false);
    this.removeAll();
    this.burst.clear();
  }

  /** End of setOfficeState: feeds the burst meter. */
  afterCast(nowMs: number): void {
    this.burst.observe(this.host.agents(), nowMs);
  }

  /** Every frame; the NPC characters tick each frame, the logic on a 500 ms throttle. */
  update(time: number, delta: number, speed: number): void {
    for (const c of this.chars.values()) c.update(time, delta, speed);
    this.stepAcc += delta;
    if (this.stepAcc < NPC_TIMING.step) return;
    this.stepAcc = 0;
    this.tick(Date.now());
  }

  setDim(alpha: number): void {
    this.dim = alpha;
    for (const c of this.chars.values()) c.setDim(alpha);
  }

  // ---------------------------------------------------------------- M14 hooks

  /** Pauses the NPC's script (it idles in place). False when unknown or already leaving. */
  hold(id: string): boolean {
    const npc = this.find(id);
    if (!npc || npc.char.leaving || npc.char.gone) return false;
    npc.held = true;
    return true;
  }

  release(id: string): void {
    const npc = this.find(id);
    if (npc) npc.held = false;
  }

  /** Jumps to the `exit` step (also releases a hold). */
  dismiss(id: string): void {
    const npc = this.find(id);
    if (npc) this.toExit(npc, Date.now());
  }

  // ---------------------------------------------------------------- loop

  private allowed(): boolean {
    const o = this.host.office();
    return !!o && o.npcs.enabled && o.ambientEffects && !this.host.isMultiverse();
  }

  private tick(now: number): void {
    const o = this.host.office();
    const allowed = this.allowed();
    if (!allowed) {
      for (const npc of this.actors.values()) if (!this.exiting(npc)) this.toExit(npc, now);
      this.nextAt = null;
    } else if (this.host.reducedMotion()) {
      // Reduced motion: walking visitors leave (the fade is skipped); static visits carry on.
      for (const npc of this.actors.values()) if (!npc.def.static && !this.exiting(npc)) this.toExit(npc, now);
    }
    if (o) {
      const opts = plateOptions(o.labels);
      for (const c of this.chars.values()) c.setPlateOptions(opts);
    }
    for (const npc of [...this.actors.values()]) {
      if (this.runner.step(npc, now) === 'done') this.remove(npc.key);
    }
    this.reactions.step(now);
    if (allowed && o) this.schedule(now, o.npcs);
  }

  private schedule(now: number, s: NonNullable<ReturnType<NpcHost['office']>>['npcs']): void {
    const cap = this.host.lowQuality() ? 1 : s.maxConcurrent;
    const active = this.activeKinds();
    const reduced = this.host.reducedMotion();
    if (!reduced && !active.has('janitor') && this.actors.size < cap) {
      const due = janitorDue(this.host.hour(), this.burst.burst(now), this.lastJanitorAt, now, s);
      if (due) {
        this.lastJanitorAt = now;
        this.spawn(ENCOUNTERS.janitor, now);
        return;
      }
    }
    if (this.nextAt === null) {
      this.nextAt = now + nextEncounterDelayMs(this.host.floorKey(), this.attempt++, s.encounterEverySec);
      return;
    }
    if (now < this.nextAt) return;
    this.nextAt = now + nextEncounterDelayMs(this.host.floorKey(), this.attempt++, s.encounterEverySec);
    if (this.actors.size >= cap) return;
    const def = pickEncounter(this.host.hour(), dramaRng(`${this.host.floorKey()}:npcpick:${this.attempt}`), s, active);
    if (def) this.spawn(def, now);
  }

  private spawn(picked: EncounterDef, now: number): void {
    const def = this.host.reducedMotion() ? staticVisit(picked) : picked;
    const o = this.host.office();
    if (!o) return;
    const theme = this.host.theme();
    const skin = npcSkin(theme, def.kind);
    const seq = this.seq++;
    const key: ActorKey = `npc:${def.kind}:${seq}`;
    const char = this.host.spawnNpc(key, this.host.map().spawn);
    char.setLook({ color: skin.color, name: skin.name, title: skin.title ?? '', sprite: 0 }, true);
    char.setCostume(skin.costume ?? {}, skin.color);
    char.setCreature(skin.creature ?? null);
    char.setActivity('idle', 'active');
    char.setPlateOptions(plateOptions(o.labels));
    char.setDim(this.dim);
    this.actors.set(key, { id: `${def.kind}-${seq}`, key, kind: def.kind, def, char, stepIndex: 0, stepAt: now, held: false, scratch: {} });
    this.chars.set(key, char);
  }

  // ---------------------------------------------------------------- helpers

  private find(id: string): NpcActor | undefined {
    for (const n of this.actors.values()) if (n.id === id) return n;
    return undefined;
  }

  private activeKinds(): Set<NpcKind> {
    return new Set([...this.actors.values()].map((n) => n.kind));
  }

  private exitIndex(npc: NpcActor): number {
    return npc.def.steps.map((s) => s.do).lastIndexOf('exit');
  }

  private exiting(npc: NpcActor): boolean {
    return npc.stepIndex >= this.exitIndex(npc);
  }

  private toExit(npc: NpcActor, now: number): void {
    const i = this.exitIndex(npc);
    if (i < 0) return;
    npc.held = false;
    if (npc.stepIndex >= i) return;
    npc.stepIndex = i;
    npc.stepAt = now;
    npc.scratch = {};
  }

  private emitEvent(npc: NpcActor, phase: EncounterEvent['phase'], now: number): void {
    this.host.emit({ id: npc.id, kind: npc.kind, style: this.host.theme().id, name: npcSkin(this.host.theme(), npc.kind).name, phase, at: now });
  }

  private remove(key: ActorKey): void {
    const npc = this.actors.get(key);
    if (npc) this.reactions.cancelFor(npc);
    this.chars.get(key)?.destroyAll();
    this.chars.delete(key);
    this.actors.delete(key);
  }

  private removeAll(): void {
    for (const key of [...this.actors.keys()]) this.remove(key);
  }
}
