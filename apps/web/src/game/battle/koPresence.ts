import { isKnockedOut, type Agent, type HeroProgress } from '@tagconn/shared';

export type KoBadge = 'dizzy' | 'bandage';

export interface KoInput {
  heroId: string | null;
  lifecycle: 'quest' | 'resting' | 'leaving';
  agent?: Pick<Agent, 'status' | 'activity'>;
}

/** The slice of Character that KoPresence touches: only the badge (never walk/teleport/seat). */
export interface KoTarget extends Omit<KoInput, 'agent'> {
  setKoBadge(kind: KoBadge | null): void;
}

/** K1 truth table: not KO'd (or expired) -> null; a hero on a quest that is active and not idle (working, waiting)
 *  -> bandage; resting / idle -> dizzy. */
export function koBadgeFor(input: KoInput, progress: HeroProgress | undefined, now: number): KoBadge | null {
  if (!input.heroId || !isKnockedOut(progress, now)) return null;
  const a = input.agent;
  return input.lifecycle === 'quest' && a && (a.status === 'waiting' || a.status === 'blocked' || (a.status === 'active' && a.activity !== 'idle')) ? 'bandage' : 'dizzy';
}

export class KoPresence {
  private last = new WeakMap<object, KoBadge | null>();

  /** `progress` is looked up by heroId; `setKoBadge` runs only when a target's badge changed. */
  apply(
    chars: Iterable<KoTarget>,
    progress: (heroId: string) => HeroProgress | undefined,
    agentOf: (c: KoTarget) => KoInput['agent'],
    now: number,
  ): void {
    for (const c of chars) {
      // The agent is looked up only for a hero whose progress is KO'd.
      const p = c.heroId ? progress(c.heroId) : undefined;
      const kind = c.heroId && isKnockedOut(p, now) ? koBadgeFor({ heroId: c.heroId, lifecycle: c.lifecycle, agent: agentOf(c) }, p, now) : null;
      if (this.last.get(c) === kind && this.last.has(c)) continue;
      this.last.set(c, kind);
      c.setKoBadge(kind);
    }
  }
}
