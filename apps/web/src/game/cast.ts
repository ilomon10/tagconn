import { MAIN_ROLE, type Agent, type Hero, type Session, type Settings } from '@tagconn/shared';

/**
 * Cast resolver (M8 8b + 8c), pure TS only (no Phaser, no React, no store imports): inputs in, cast
 * out. Turns the raw domain state (agents, heroes, sessions, settings) into "which actors are drawn
 * on this floor right now, in what order, and who is the Guild Master". See
 * docs/design/living-office.md section 4.1 (cast rules) and section 5 (one PM per floor).
 *
 * Scope boundary — read this before wiring it into the scene:
 * - This module decides which `ActorKey`s are present on a given call, nothing more. The actor
 *   *lifecycle* (ON_QUEST / RESTING / LEAVING / RETURNING, `office.idleLeaveSec` timers, a rebind
 *   cancelling a pending leave — design section 4.2) is stateful, needs Phaser tweens, and lives in
 *   the scene (`OfficeScene` / `Character`, task W7a). The scene drives those states purely from
 *   whether a key is present or absent across successive `resolveCast` calls over time: this
 *   resolver's only job is to make that key stable (same hero id -> same key) so the scene can tell
 *   "the same character came back" from "a new character spawned".
 * - The Multiverse's per-realm fair-share cap (design section 6.3) is computed by the caller
 *   (W6/W7a: `multiverse/plan.ts` splits `office.multiverseMaxCharacters` across realms). This
 *   resolver only enforces whichever single `maxCharacters` number it is given for *this* call.
 *   Call `resolveCast` once per rendered floor: once for a normal project floor (`office.maxCharacters`),
 *   or once per Multiverse realm (that realm's fair-share cap, with only that realm's agents/heroes/sessions).
 *
 * Public API for W7a (scene) and W7b (React bridge / roster):
 * - Types: `ActorKey`, `CastMember`, `CastInput`, `Cast`.
 * - Function: `resolveCast(input: CastInput): Cast`.
 * - Constant: `HERO_BIND_GRACE_MS`, the 750 ms `agent:upsert` -> `hero:upsert` race window (section 4.1).
 *
 * Calling convention: keep `Cast.primary` (merged per project) across calls and pass it back in as
 * `CastInput.prevPrimary` on the next call — that is what makes the Guild Master hysteresis
 * (section 5) actually hysteretic. A project absent from `primary` this call (no live main agent) is
 * up to the caller to drop or keep; this resolver never reads its own past output.
 */

/** Grace window between an `agent:upsert` and the matching `hero:upsert` (section 4.1). */
export const HERO_BIND_GRACE_MS = 750;

/** `hero:<hero id>` when the actor is bound to a named hero, `agent:<agent id>` when anonymous, or
 *  `gm:<project id>` for the single floor-wide Guild Master actor (section 5). */
export type ActorKey = `hero:${string}` | `agent:${string}` | `gm:${string}`;

export interface CastMember {
  key: ActorKey;
  /** The live agent driving this actor. For a Guild Master this is the current primary session's main agent. */
  agent: Agent;
  /** Look + name; null = anonymous hash look (today's pre-M8 look, drawn from the agent id). */
  hero: Hero | null;
  kind: 'guild-master' | 'member';
  /** `pmMode: 'single'` only, on the Guild Master: other live main sessions on this floor. Omitted
   *  (not present, not an empty object) when there are none. */
  sessionsChip?: { count: number; attention: boolean; agentIds: string[] };
}

export interface CastInput {
  agents: Agent[];
  heroes: Hero[];
  sessions: Session[];
  office: Pick<Settings['office'], 'pmMode' | 'pmSwitchCooldownSec'>;
  /** `settings.heroes.enabled`. False = every actor is anonymous (pre-M8 look); none of the
   *  hero-hiding rules below apply, since there is no hero to wait for or reuse. */
  heroesEnabled: boolean;
  /** Previous primary main agent id per project (hysteresis), owned by the caller across calls. */
  prevPrimary: ReadonlyMap<string, string>;
  now: number;
  /** Cap on drawn actors for *this* call: `office.maxCharacters` for a floor, or a Multiverse
   *  realm's fair-share cap (section 6.3, computed by the caller). */
  maxCharacters: number;
}

export interface Cast {
  /** Drawn actors, already ordered and capped (Guild Masters first, then agents that need you, then
   *  by `startedAt`; section 4.1's last bullet). */
  members: CastMember[];
  /** Recomputed primary main agent id per project that has a live one this call. Feed back in as
   *  `prevPrimary` on the next call. */
  primary: Map<string, string>;
  /** Agent ids known but not drawn this call: idle unbound agents, agents still inside the bind
   *  grace window, non-primary main sessions collapsed into a chip, and agents pushed past the cap.
   *  Roster-only ("off canvas"). */
  hidden: string[];
}

const needsYou = (a: Agent): boolean => a.status === 'waiting' || a.status === 'blocked';

/**
 * Section 5 primary selection: waiting/blocked candidates preempt everyone else (most recently
 * updated among them wins), otherwise the most recently updated candidate wins. Hysteresis keeps the
 * previous primary unless it is gone, the challenger needs you and it does not, or the challenger is
 * more than `pmSwitchCooldownSec` ahead of it.
 */
function selectPrimary(candidates: readonly Agent[], prevId: string | undefined, pmSwitchCooldownSec: number, now: number): Agent {
  const waiting = candidates.filter(needsYou);
  const pool = waiting.length > 0 ? waiting : candidates;
  // Most recently updated first; tie-broken by id so the result never depends on input order.
  const best = [...pool].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))[0]!;
  const prev = prevId !== undefined ? candidates.find((a) => a.id === prevId) : undefined;
  void now; // reserved: `now` is not needed by the rule as written, kept for a stable call signature.
  if (!prev) return best;
  if (prev.id === best.id) return prev;
  if (needsYou(best) && !needsYou(prev)) return best;
  if (best.updatedAt - prev.updatedAt > pmSwitchCooldownSec * 1000) return best;
  return prev;
}

export function resolveCast(input: CastInput): Cast {
  const { agents, heroes, sessions, office, heroesEnabled, prevPrimary, now, maxCharacters } = input;

  const heroByAgentId = new Map<string, Hero>();
  if (heroesEnabled) for (const h of heroes) if (h.boundAgentId !== null) heroByAgentId.set(h.boundAgentId, h);
  const heroFor = (agentId: string): Hero | null => heroByAgentId.get(agentId) ?? null;

  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const sessionEnded = (a: Agent): boolean => sessionById.get(a.sessionId)?.status === 'ended';

  const byProject = new Map<string, Agent[]>();
  for (const a of agents) {
    const list = byProject.get(a.projectId);
    if (list) list.push(a);
    else byProject.set(a.projectId, [a]);
  }

  const hidden = new Set<string>();
  const primary = new Map<string, string>();
  const candidates: CastMember[] = [];

  for (const [projectId, projectAgents] of byProject) {
    const mains = projectAgents.filter((a) => a.isMain && a.status !== 'done' && !sessionEnded(a));
    const nonMains = projectAgents.filter((a) => !a.isMain);

    if (office.pmMode === 'single') {
      if (mains.length > 0) {
        const chosen = selectPrimary(mains, prevPrimary.get(projectId), office.pmSwitchCooldownSec, now);
        primary.set(projectId, chosen.id);
        const gmHero = heroesEnabled ? (heroes.find((h) => h.projectId === projectId && h.role === MAIN_ROLE && h.slot === 0) ?? null) : null;
        const others = mains.filter((a) => a.id !== chosen.id);
        const member: CastMember = { key: `gm:${projectId}`, agent: chosen, hero: gmHero, kind: 'guild-master' };
        if (others.length > 0) {
          member.sessionsChip = {
            count: others.length,
            attention: others.some(needsYou),
            agentIds: others.map((o) => o.id).sort(),
          };
          for (const o of others) hidden.add(o.id);
        }
        candidates.push(member);
      }
    } else {
      // per-session: every live main agent is its own member with its own bound hero, no GM merge.
      for (const m of mains) candidates.push({ key: heroFor(m.id) ? `hero:${heroFor(m.id)!.id}` : `agent:${m.id}`, agent: m, hero: heroFor(m.id), kind: 'member' });
    }

    for (const a of nonMains) {
      const hero = heroFor(a.id);
      if (heroesEnabled && !hero) {
        if (a.activity === 'idle') {
          hidden.add(a.id);
          continue;
        }
        if (now - a.startedAt < HERO_BIND_GRACE_MS) {
          hidden.add(a.id);
          continue;
        }
      }
      candidates.push({ key: hero ? `hero:${hero.id}` : `agent:${a.id}`, agent: a, hero, kind: 'member' });
    }
  }

  // Ordering + cap (section 4.1 last bullet): Guild Masters first, then agents that need you, then
  // by `startedAt` (oldest first); tie-broken by key for a fully deterministic result regardless of
  // input array order.
  const tier = (m: CastMember): number => (m.kind === 'guild-master' ? 0 : needsYou(m.agent) ? 1 : 2);
  const ordered = [...candidates].sort(
    (a, b) => tier(a) - tier(b) || a.agent.startedAt - b.agent.startedAt || a.key.localeCompare(b.key),
  );
  const cap = Math.max(0, maxCharacters);
  const members = ordered.slice(0, cap);
  for (const m of ordered.slice(cap)) hidden.add(m.agent.id);

  return { members, primary, hidden: [...hidden].sort() };
}
