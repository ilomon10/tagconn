/**
 * The actor lifecycle state machine (M8 8c, docs/design/living-office.md section 4.2), extracted as
 * a pure reducer so it is testable without Phaser. `OfficeScene` computes, once per `ActorKey` per
 * `setOfficeState` pass, what this actor *should* be doing this frame (`desired`) and feeds the
 * previous frame's result back in; the scene alone decides the Phaser side effects (walk/fade/alpha)
 * that a state change implies.
 *
 * States (see the diagram in the design doc):
 * - `quest`: on quest, drawn at full alpha, follows its agent's zone.
 * - `resting`: idle in the lounge — either its key left the cast (agent removed/stale/hidden), or
 *   its bound agent finished (`done`) and it has a persistent identity (hero/GM) worth keeping
 *   around instead of walking straight out.
 * - `leaving`: walking out to fade, either because `idleLeaveSec` elapsed while resting or because
 *   an anonymous (non-persistent) actor's agent is simply gone.
 *
 * A "rebind" is just `desired` going back to `quest` while the previous state was `resting` or
 * `leaving` — the reducer returns straight to `quest` with no special case, which is what cancels a
 * pending leave and reuses the same actor instead of spawning a new one.
 */
export type ActorLifecycleState = 'quest' | 'resting' | 'leaving';

export interface LifecycleFrame {
  state: ActorLifecycleState;
  /** `time.now`-style ms timestamp this actor most recently entered `resting`; null otherwise. Used
   *  both for the `idleLeaveSec` countdown and to pick the longest-resting actor when over `maxCharacters`. */
  restingSince: number | null;
}

export interface LifecycleInput {
  /** What the caller wants this actor to be doing this frame, ignoring timers: `quest` while its key
   *  is present in the cast and its agent isn't `done`; `resting` while absent, or present-but-`done`
   *  for a persistent (hero/GM) actor; `leaving` for a non-persistent actor whose key is gone. */
  desired: ActorLifecycleState;
  prev: LifecycleFrame | undefined;
  now: number;
  /** `office.idleLeaveSec` in seconds; `<= 0` leaves at once instead of ever showing `resting`. */
  idleLeaveSec: number;
}

/** The starting frame for a brand-new actor (never call `nextLifecycle` with this as `prev` unless
 *  you mean "just spawned"; pass `undefined` instead, which this module treats the same way). */
export const INITIAL_LIFECYCLE: LifecycleFrame = { state: 'quest', restingSince: null };

export function nextLifecycle(input: LifecycleInput): LifecycleFrame {
  const { desired, prev, now, idleLeaveSec } = input;

  if (desired === 'quest') return { state: 'quest', restingSince: null };

  if (desired === 'leaving') return { state: 'leaving', restingSince: prev?.restingSince ?? null };

  // desired === 'resting'
  if (!prev || prev.state !== 'resting') {
    // Freshly entering the lounge. `idleLeaveSec <= 0` means "never rest, leave at once".
    return idleLeaveSec <= 0 ? { state: 'leaving', restingSince: now } : { state: 'resting', restingSince: now };
  }
  const restingSince = prev.restingSince ?? now;
  const elapsedSec = (now - restingSince) / 1000;
  if (idleLeaveSec <= 0 || elapsedSec >= idleLeaveSec) return { state: 'leaving', restingSince };
  return prev;
}
