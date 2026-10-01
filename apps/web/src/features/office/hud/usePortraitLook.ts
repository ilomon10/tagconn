import { heroLookForStyle, type Agent, type Hero, type HeroLookStyle } from '@tagconn/shared';
import { useBoundHero, useRoleLookup, floorStyleFor } from '../../../lib/hooks';
import { hexToNumber } from '../../../game/textures';
import { useOfficeStore } from '../../../stores/officeStore';
import { useLayoutStore } from '../../../stores/layoutStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { anonymousAppearance } from '../../../game/heroPreview';
import type { PortraitLook } from './Portrait';

/**
 * What an agent's portrait wears: the bound hero's look for its floor's style, else the anonymous look
 * the scene draws (`anonymousAppearance`). The floor is the agent's own project's (on the Multiverse that
 * is the realm's style). `gm:<project>` is the scene's actor key for a floor-wide main agent (`cast.ts`).
 */
export function usePortraitLook(agent: Agent): { look: PortraitLook; hero: Hero | undefined } {
  const hero = useBoundHero(agent.id);
  const lookup = useRoleLookup();
  const project = useOfficeStore((s) => s.projects[agent.projectId]);
  const layouts = useLayoutStore((s) => s.layouts);
  const settings = useSettingsStore((s) => s.settings);
  const style: HeroLookStyle = floorStyleFor(project, layouts, settings);
  const role = lookup(agent.role);
  const single = settings.office.pmMode === 'single' && agent.isMain;
  const appearance =
    hero && settings.heroes.enabled
      ? heroLookForStyle(hero, style).appearance
      : anonymousAppearance(single ? `gm:${agent.projectId}` : `agent:${agent.id}`, role.role?.sprite ?? 0);
  return { look: { appearance, role: agent.role, roleColor: hexToNumber(role.color), style }, hero };
}
