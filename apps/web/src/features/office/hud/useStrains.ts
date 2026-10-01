import { useMemo } from 'react';
import type { Agent } from '@tagconn/shared';
import { isAgentOnARoll, observeAgents, strainFor, type DramaSettings } from '../../../game/drama';
import type { StrainKind } from '../../../game/themes/types';

/** Strain per agent id for this tick. Derived once for the whole bar so the chips stay pure (and memoizable). */
export function useStrains(agents: Agent[], now: number, drama: DramaSettings): ReadonlyMap<string, StrainKind | null> {
  return useMemo(() => {
    observeAgents(agents, now);
    return new Map(agents.map((a) => [a.id, strainFor(a, now, drama, isAgentOnARoll(a.id, now, drama))]));
  }, [agents, now, drama]);
}
