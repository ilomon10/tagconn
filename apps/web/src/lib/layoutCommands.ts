import type { OfficeLayout, OfficeLayoutInput, Project } from '@tagconn/shared';
import { useOfficeStore } from '../stores/officeStore';
import { useLayoutStore } from '../stores/layoutStore';
import { isDemo } from './connection';
import { layoutSocket } from './socket';
import { api } from './api';

/**
 * User-initiated layout writes (the Hall Planner). Mirrors `lib/commands.ts`: live mode goes over
 * the socket (or REST for the project's `layoutId`), demo mode edits the local stores directly —
 * see docs/design/guild-hall.md section 5 "Persistence" and section 8's demo-mode note.
 */

function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'layout'
  );
}

/** Demo-mode id generator: mirrors the server's `slug(name) + 4 hex chars` (guild-hall.md section 2). */
function genLocalLayoutId(name: string): string {
  const hex = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${slug(name)}-${hex}`;
}

/** Refresh the layout registry (e.g. on opening the editor, in case the initial snapshot missed one). */
export async function refreshLayouts(): Promise<OfficeLayout[]> {
  const list = isDemo() ? Object.values(useLayoutStore.getState().layouts) : await api.layouts();
  useLayoutStore.getState().setLayouts(list);
  return list;
}

/**
 * Classifies a failed `saveLayout()` by matching the server's message text. Both transports
 * (REST 409 and the `layouts:save` socket ack) only carry a message, no status code — see
 * `layouts.service.ts` and `layouts.socket.ts`'s `layoutAck` — so this is necessarily string-based.
 * Demo mode never throws these (see `saveLayout` below), so this only matters in live mode.
 */
export type SaveLayoutFailure =
  | { kind: 'max-stored'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'other'; message: string };

export function classifySaveLayoutError(err: unknown): SaveLayoutFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('office.maxStoredLayouts')) return { kind: 'max-stored', message };
  if (message.includes('was changed since you loaded it') || message.includes('no longer exists')) return { kind: 'conflict', message };
  return { kind: 'other', message };
}

/**
 * Create (no `input.id`) or replace (existing id) a layout. Rejects builtins server-side (409).
 * `input.baseUpdatedAt`, when set, asks the server to 409 (`classifySaveLayoutError` -> 'conflict')
 * if the layout was changed or deleted since it was loaded (optimistic concurrency, M7 hardening);
 * demo mode has only one client, so it ignores the field entirely.
 */
export async function saveLayout(input: OfficeLayoutInput): Promise<OfficeLayout> {
  if (isDemo()) {
    const now = Date.now();
    const { baseUpdatedAt: _baseUpdatedAt, ...rest } = input; // demo has one client — nothing to conflict with
    const existing = rest.id ? useLayoutStore.getState().layouts[rest.id] : undefined;
    if (existing?.builtin) throw new Error(`"${existing.name}" is a builtin layout — duplicate it to edit.`);
    const saved: OfficeLayout = {
      ...rest,
      id: rest.id ?? genLocalLayoutId(rest.name),
      background: rest.background ?? 'hall',
      corridorWidth: rest.corridorWidth ?? 2,
      builtin: false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    useLayoutStore.getState().upsertLayout(saved);
    return saved;
  }
  const saved = await layoutSocket.save(input);
  useLayoutStore.getState().upsertLayout(saved);
  return saved;
}

/** Deletes a layout. In live mode, projects using it are re-broadcast with `layoutId` cleared. */
export async function deleteLayout(id: string): Promise<void> {
  if (isDemo()) {
    const existing = useLayoutStore.getState().layouts[id];
    if (existing?.builtin) throw new Error(`"${existing.name}" is a builtin layout and cannot be deleted.`);
    useLayoutStore.getState().removeLayout(id);
    const projects = useOfficeStore.getState().projects;
    for (const p of Object.values(projects)) {
      if (p.layoutId === id) useOfficeStore.getState().upsertProject({ ...p, layoutId: undefined });
    }
    return;
  }
  await layoutSocket.delete(id);
  useLayoutStore.getState().removeLayout(id);
}

/** Assigns (or clears, with `null`) a floor's layout — `PATCH /api/projects/:id { layoutId }`. */
export async function assignLayout(projectId: string, layoutId: string | null): Promise<Project> {
  const prev = useOfficeStore.getState().projects[projectId];
  if (!prev) throw new Error(`Unknown floor "${projectId}"`);
  if (layoutId != null && !useLayoutStore.getState().layouts[layoutId]) throw new Error(`Unknown layout "${layoutId}"`);
  const next = isDemo() ? { ...prev, layoutId: layoutId ?? undefined } : await layoutSocket.assign({ projectId, layoutId });
  useOfficeStore.getState().upsertProject(next);
  return next;
}
