import { defaultSettings, type Project, type Role, type Settings, type SettingsPatch } from '@tagconn/shared';
import { useOfficeStore } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { emitWithAck } from './socket';
import { isDemo } from './connection';
import { applySettingsPatch } from './settingsPatch';
import { DEFAULT_ROLES } from './defaultRoles';
import { api } from './api';

/** User-initiated writes. Live mode goes over the socket; demo mode edits the local store. */

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const store = useSettingsStore.getState();
  const next = isDemo() ? applySettingsPatch(store.settings, patch) : await emitWithAck('settings:update', patch);
  useSettingsStore.getState().setSettings(next);
  return next;
}

export async function resetSettings(): Promise<Settings> {
  const next = isDemo() ? defaultSettings() : await emitWithAck('settings:reset');
  useSettingsStore.getState().setSettings(next);
  return next;
}

export async function saveRole(role: Role): Promise<Role> {
  const saved = isDemo() ? role : await emitWithAck('roles:save', role);
  useSettingsStore.getState().upsertRole(saved);
  return saved;
}

export async function deleteRole(name: string): Promise<void> {
  if (!isDemo()) await emitWithAck('roles:delete', name);
  useSettingsStore.getState().deleteRole(name);
}

export async function patchProject(id: string, patch: { name?: string; archived?: boolean }): Promise<Project> {
  const prev = useOfficeStore.getState().projects[id];
  if (!prev) throw new Error(`Unknown floor "${id}"`);
  const next = isDemo() ? { ...prev, ...patch } : await api.patchProject(id, patch);
  useOfficeStore.getState().upsertProject(next);
  return next;
}

export async function syncRoles(): Promise<{ written: string[]; removed: string[] }> {
  if (!isDemo()) return emitWithAck('roles:sync');
  const roles = useSettingsStore.getState().roles;
  const written = roles.filter((r) => r.enabled && r.syncToClaude).map((r) => `~/.claude/agents/${r.name}.md (demo, not written)`);
  const known = new Set(DEFAULT_ROLES.map((r) => r.name));
  const removed = [...known].filter((n) => !roles.some((r) => r.name === n)).map((n) => `~/.claude/agents/${n}.md (demo)`);
  return { written, removed };
}
