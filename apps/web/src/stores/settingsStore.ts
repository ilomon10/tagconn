import { create } from 'zustand';
import { defaultSettings, type Role, type Settings } from '@tagconn/shared';
import { DEFAULT_ROLES } from '../lib/defaultRoles';

export interface SettingsState {
  settings: Settings;
  roles: Role[];
  /** True once real values arrived from the server (or demo mode seeded them). */
  settingsLoaded: boolean;
  rolesLoaded: boolean;
  setSettings(s: Settings): void;
  setRoles(r: Role[]): void;
  upsertRole(r: Role): void;
  deleteRole(name: string): void;
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  settings: defaultSettings(),
  roles: DEFAULT_ROLES,
  settingsLoaded: false,
  rolesLoaded: false,
  setSettings: (settings) => set({ settings, settingsLoaded: true }),
  setRoles: (roles) => set({ roles, rolesLoaded: true }),
  upsertRole: (role) =>
    set((s) => {
      const i = s.roles.findIndex((r) => r.name === role.name);
      const roles = [...s.roles];
      if (i === -1) roles.push(role);
      else roles[i] = role;
      return { roles };
    }),
  deleteRole: (name) => set((s) => ({ roles: s.roles.filter((r) => r.name !== name) })),
}));

export function roleOf(roles: Role[], name: string): Role | undefined {
  return roles.find((r) => r.name === name);
}
