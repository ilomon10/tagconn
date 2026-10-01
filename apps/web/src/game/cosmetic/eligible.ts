// M13 W1-11: eligibility helpers shared by drama, life and NPC reactions (docs/design/office-life.md section 3.4).
import type { Agent } from '@tagconn/shared';
import type { Character } from '../actors/Character';
import type { Point } from '../procgen/types';

/** Whether a character may take part in a cosmetic script: resting, or a quest agent that is active and idle.
 *  Walking is allowed (scripts walk their own cast). Drama's `stillOk`. */
export function isIdleEligible(
  c: Pick<Character, 'gone' | 'leaving' | 'lifecycleFrame' | 'boundAgentId'>,
  agent: Agent | undefined,
): boolean {
  if (c.gone || c.leaving) return false;
  if (c.lifecycleFrame.state === 'resting') return true;
  if (c.lifecycleFrame.state !== 'quest' || !c.boundAgentId) return false;
  return !!agent && agent.status === 'active' && agent.activity === 'idle';
}

/** Tiles of characters whose waiting/blocked bubble must stay clear (script spots keep WAITING_CLEARANCE_TILES away). */
export function waitingTiles(actors: Iterable<Character>): Point[] {
  const out: Point[] = [];
  for (const c of actors) if (!c.gone && c.isWaiting) out.push({ x: c.tile.x, y: c.tile.y });
  return out;
}
