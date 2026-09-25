import { useEffect, useMemo, useState } from 'react';
import type { Role } from '@tagconn/shared';
import { resolveTitle } from '../game/lookResolver';
import { getTheme } from '../game/themes';
import { onFloor, useOfficeStore } from '../stores/officeStore';
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
  /** The current style's name for this role (e.g. guild's "Archmage" for `architect`); falls back
   * to the plain `title` for a custom role the theme doesn't know about. */
  themedTitle: string;
}

/** Pure composition of a plain `RoleInfo` with a theme's title map — kept separate from the hook
 * below so it's testable without a React render (`useThemedRoleLookup` just wires the two stores in). */
export function themedRoleInfo(theme: Pick<{ roleTitles: Record<string, string> }, 'roleTitles'>, info: RoleInfo, roleName: string | undefined): ThemedRoleInfo {
  return { ...info, themedTitle: roleName ? resolveTitle(theme, roleName, info.title) : info.title };
}

/** Like `useRoleLookup`, but the primary label is the THEMED title (guild titles when
 * `office.style` is `guild`) — see `Roster.tsx`, which shows it as the primary label with the plain
 * role title as small secondary text. */
export function useThemedRoleLookup(): (name: string | undefined) => ThemedRoleInfo {
  const lookup = useRoleLookup();
  const style = useSettingsStore((s) => s.settings.office.style);
  return useMemo(() => {
    const theme = getTheme(style);
    return (name) => themedRoleInfo(theme, lookup(name), name);
  }, [lookup, style]);
}
