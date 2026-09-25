import type { Agent, OfficeEvent, OfficeSnapshot, Project, Session, Task } from './domain.js';
import type { LayoutAssign, OfficeLayout, OfficeLayoutInput } from './layout.js';
import type { Role } from './roles.js';
import type { Settings, SettingsPatch } from './settings.js';

/** socket.io namespace used by the web client. */
export const OFFICE_NAMESPACE = '/office';

export type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;

export interface ServerToClientEvents {
  snapshot: (s: OfficeSnapshot) => void;
  'project:upsert': (p: Project) => void;
  'session:upsert': (s: Session) => void;
  'agent:upsert': (a: Agent) => void;
  'agent:remove': (id: string) => void;
  'task:upsert': (t: Task) => void;
  'event:new': (e: OfficeEvent) => void;
  'settings:changed': (s: Settings) => void;
  'roles:changed': (r: Role[]) => void;
  /** A layout was created or replaced (M7). Broadcast to every client (layouts are global). */
  'layout:upsert': (l: OfficeLayout) => void;
  /** A layout was deleted; projects that used it are re-broadcast via `project:upsert`. */
  'layout:remove': (id: string) => void;
}

export interface ClientToServerEvents {
  /** Subscribe to one project floor, or '*' for all. Replies with a snapshot. */
  'office:subscribe': (projectId: string, ack: Ack<OfficeSnapshot>) => void;
  'settings:get': (ack: Ack<Settings>) => void;
  'settings:update': (patch: SettingsPatch, ack: Ack<Settings>) => void;
  'settings:reset': (ack: Ack<Settings>) => void;
  'roles:list': (ack: Ack<Role[]>) => void;
  'roles:save': (role: Role, ack: Ack<Role>) => void;
  'roles:delete': (name: string, ack: Ack<true>) => void;
  'roles:sync': (ack: Ack<{ written: string[]; removed: string[] }>) => void;
  /** M7 layouts. Errors: unknown id, builtin (read-only), or validation (`error` lists the issues). */
  'layouts:list': (ack: Ack<OfficeLayout[]>) => void;
  'layouts:get': (id: string, ack: Ack<OfficeLayout>) => void;
  /** Create (no id) or replace (id). Rejected when `validateLayout` reports errors. */
  'layouts:save': (layout: OfficeLayoutInput, ack: Ack<OfficeLayout>) => void;
  'layouts:delete': (id: string, ack: Ack<true>) => void;
  /** Set or clear (null) a project's layout; replies with the updated project. */
  'layouts:assign': (req: LayoutAssign, ack: Ack<Project>) => void;
}

/** Room names. */
export const rooms = {
  all: 'project:*',
  project: (id: string) => `project:${id}`,
};
