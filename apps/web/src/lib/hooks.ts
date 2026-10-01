import { useEffect, useMemo, useState } from 'react';
import { heroLookForStyle, type Hero, type OfficeLayout, type Project, type Role, type Settings } from '@tagconn/shared';
import { titleFor } from '../game/lookResolver';
import type { ThemeDefinition } from '../game/themes/types';
import { getTheme } from '../game/themes';
import { onFloor, useOfficeStore } from '../stores/officeStore';
import { useHeroStore } from '../stores/heroStore';
import { layoutForProject, useLayoutStore } from '../stores/layoutStore';
import { useSettingsStore } from '../stores/settingsStore';
import { FALLBACK_COLOR } from './defaultRoles';

/** Re-renders every `ms` with the current time. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Agents on the selected floor, main sessions first then by start time. */
export function useFloorAgents() {
  const agents = useOfficeStore((s) => s.agents);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  return useMemo(
    () =>
      Object.values(agents)
        .filter((a) => onFloor(selected, a.projectId))
        .sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.startedAt - b.startedAt),
    [agents, selected],
  );
}

export function useFloorTasks() {
  const tasks = useOfficeStore((s) => s.tasks);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  return useMemo(() => Object.values(tasks).filter((t) => onFloor(selected, t.projectId)), [tasks, selected]);
}

export interface RoleInfo {
  title: string;
  color: string;
  role?: Role;
}

export function useRoleLookup(): (name: string | undefined) => RoleInfo {
  const roles = useSettingsStore((s) => s.roles);
  return useMemo(() => {
    const map = new Map(roles.map((r) => [r.name, r]));
    return (name) => {
      const role = name ? map.get(name) : undefined;
      return { title: role?.title ?? name ?? 'unknown', color: role?.color ?? FALLBACK_COLOR, role };
    };
  }, [roles]);
}

export interface ThemedRoleInfo extends RoleInfo {
  /** The title to show for this role on this floor: the hero's own title, else a role title the user
   * edited, else the floor style's name for the role (guild's "Archmage" for `architect`), else the
   * plain `title` (see `titleFor`). */
  themedTitle: string;
}

/** Pure composition of a plain `RoleInfo` with a theme's title map — kept separate from the hook
 * below so it's testable without a React render (`useThemedRoleLookup` just wires the stores in). */
export function themedRoleInfo(
  theme: Pick<ThemeDefinition, 'roleTitles'>,
  info: RoleInfo,
  roleName: string | undefined,
  heroTitle?: string | null,
): ThemedRoleInfo {
  return { ...info, themedTitle: roleName ? titleFor(theme, roleName, info.role?.title, heroTitle) : (heroTitle ?? info.title) };
}

/** Which agent/hero a title is for: its project picks the floor style, a bound hero may override the title. */
export interface TitleContext {
  /** The agent's project. Defaults to the selected floor; on the Multiverse that is the agent's own floor. */
  projectId?: string;
  hero?: Pick<Hero, 'appearance' | 'title' | 'styles'> | null;
}

/** Office style of a project's floor (its layout's `style`, else the global default). */
export function floorStyleFor(project: Pick<Project, 'layoutId'> | undefined, layouts: Record<string, OfficeLayout>, settings: Pick<Settings, 'office'>): Settings['office']['style'] {
  return layoutForProject(layouts, project, settings.office.defaultLayoutId).style ?? settings.office.style;
}

/** Like `useRoleLookup`, but the primary label is the THEMED title for the agent's own floor style
 * (not the global `office.style`): guild floors say "Guild Master", modern floors "Project Manager".
 * Shown as the primary label in `Roster`/`AgentDrawer`, with the plain role title as secondary text. */
export function useThemedRoleLookup(): (name: string | undefined, ctx?: TitleContext) => ThemedRoleInfo {
  const lookup = useRoleLookup();
  const projects = useOfficeStore((s) => s.projects);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const layouts = useLayoutStore((s) => s.layouts);
  const settings = useSettingsStore((s) => s.settings);
  return useMemo(() => {
    return (name, ctx) => {
      const projectId = ctx?.projectId ?? selected;
      const style = floorStyleFor(projects[projectId], layouts, settings);
      const heroTitle = ctx?.hero ? heroLookForStyle(ctx.hero, style).title : null;
      return themedRoleInfo(getTheme(style), lookup(name), name, heroTitle);
    };
  }, [lookup, projects, selected, layouts, settings]);
}

/** The hero currently bound to `agentId`, if any (heroes are broadcast to every client, so a scan is cheap). */
export function useBoundHero(agentId: string | undefined): Hero | undefined {
  return useHeroStore((s) => (agentId ? Object.values(s.heroes).find((h) => h.boundAgentId === agentId) : undefined));
}
