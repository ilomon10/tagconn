import { useRef } from 'react';
import type { Agent } from '@tagconn/shared';
import { resolveCast } from '../../game/cast';
import { ALL_FLOORS, useOfficeStore } from '../../stores/officeStore';
import { useHeroStore } from '../../stores/heroStore';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * Which of `agents` are "off canvas" right now — idle and unbound, still inside the hero-bind grace
 * window, collapsed into a Guild Master's session chip, or pushed past the character cap (M8 8b/8c,
 * `game/cast.ts`'s `resolveCast`). Kept out of the scene: the HUD only
 * needs the resulting *set* of hidden ids, not the scene's stateful walk/rest/leave timers, and this
 * way the badge stays accurate even before W7a wires the scene itself up to `resolveCast`.
 *
 * `prevPrimary` (the Guild Master hysteresis, section 5) is kept across renders via a ref, seeded
 * each call with any pins from `pinnedPrimary` — the same "keep it across calls" convention
 * `cast.ts` documents for its scene caller.
 */
export function useHiddenAgentIds(agents: Agent[], now: number): ReadonlySet<string> {
  const heroes = useHeroStore((s) => s.heroes);
  const sessions = useOfficeStore((s) => s.sessions);
  const pinnedPrimary = useOfficeStore((s) => s.pinnedPrimary);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const office = useSettingsStore((s) => s.settings.office);
  const heroesEnabled = useSettingsStore((s) => s.settings.heroes.enabled);
  const prevPrimary = useRef<Map<string, string>>(new Map());

  const seeded = new Map(prevPrimary.current);
  for (const [projectId, agentId] of Object.entries(pinnedPrimary)) seeded.set(projectId, agentId);

  const cast = resolveCast({
    agents,
    heroes: Object.values(heroes),
    sessions: Object.values(sessions),
    office: { pmMode: office.pmMode, pmSwitchCooldownSec: office.pmSwitchCooldownSec },
    heroesEnabled,
    prevPrimary: seeded,
    now,
    // The Multiverse aggregates every realm into one list here (design section 6.3 splits the cap
    // per realm for the *scene*; the HUD approximates with the floor-wide cap for its own count).
    maxCharacters: selected === ALL_FLOORS ? office.multiverseMaxCharacters : office.maxCharacters,
  });
  prevPrimary.current = cast.primary;
  return new Set(cast.hidden);
}
