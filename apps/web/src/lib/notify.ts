import type { Agent, AgentStatus, Role } from '@tagconn/shared';
import { useOfficeStore } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission === 'default' ? Notification.requestPermission() : Notification.permission;
}

const label = (a: Agent, roles: Role[]) => roles.find((r) => r.name === a.role)?.title ?? a.role;

const messages: Partial<Record<AgentStatus, (a: Agent, who: string) => string>> = {
  waiting: (a, who) => `${who} is waiting for you${a.bubble ? `: ${a.bubble}` : ''}`,
  blocked: (a, who) => `${who} is blocked${a.bubble ? `: ${a.bubble}` : ''}`,
  done: (a, who) => `${who} finished${a.description ? `: ${a.description}` : ''}`,
};

/** Watches agent status transitions and raises browser notifications per settings.notifications. */
export function startNotificationWatcher(): () => void {
  return useOfficeStore.subscribe((state, prev) => {
    if (state.agents === prev.agents || !notificationsSupported() || Notification.permission !== 'granted') return;
    const { notifications } = useSettingsStore.getState().settings;
    const roles = useSettingsStore.getState().roles;
    const enabled: Record<AgentStatus, boolean> = {
      active: false,
      waiting: notifications.onWaiting,
      blocked: notifications.onBlocked,
      done: notifications.onDone,
    };
    for (const a of Object.values(state.agents)) {
      const before = prev.agents[a.id];
      if (before?.status === a.status || !enabled[a.status]) continue;
      const make = messages[a.status];
      if (!make) continue;
      const project = state.projects[a.projectId]?.name;
      try {
        new Notification(project ? `tagconn · ${project}` : 'tagconn', { body: make(a, label(a, roles)), tag: `${a.id}:${a.status}` });
      } catch {
        // Some browsers (e.g. Android Chrome) only allow notifications from a service worker.
      }
    }
  });
}
