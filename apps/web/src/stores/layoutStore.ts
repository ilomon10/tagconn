import { create } from 'zustand';
import { DEFAULT_LAYOUT, DEFAULT_LAYOUT_ID, type OfficeLayout, type Project } from '@tagconn/shared';
import type { OfficeSocket } from '../lib/socket';

/**
 * Global layout registry (M7). Layouts are not per-project: a project references one by id
 * (`Project.layoutId`), so this store just keeps every known `OfficeLayout` by id. See
 * docs/design/guild-hall.md D9 and `layoutForProject` below for the fallback chain.
 */

export interface LayoutState {
  layouts: Record<string, OfficeLayout>;
  setLayouts(list: OfficeLayout[]): void;
  upsertLayout(l: OfficeLayout): void;
  removeLayout(id: string): void;
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  layouts: {},
  setLayouts: (list) => set({ layouts: Object.fromEntries(list.map((l) => [l.id, l])) }),
  upsertLayout: (l) => set((s) => ({ layouts: { ...s.layouts, [l.id]: l } })),
  removeLayout: (id) =>
    set((s) => {
      if (!(id in s.layouts)) return {};
      const layouts = { ...s.layouts };
      delete layouts[id];
      return { layouts };
    }),
}));

/**
 * Which layout a floor should render, in fallback order: the project's own `layoutId`, then
 * `settings.office.defaultLayoutId`, then the builtin `'default'` layout, then the shared
 * `DEFAULT_LAYOUT` constant (so a floor is never left without a map, even before the first
 * snapshot arrives). Pure — safe to call from a selector or a Phaser scene alike.
 */
export function layoutForProject(
  layouts: Record<string, OfficeLayout>,
  project: Pick<Project, 'layoutId'> | undefined,
  defaultLayoutId: string,
): OfficeLayout {
  return layouts[project?.layoutId ?? ''] ?? layouts[defaultLayoutId] ?? layouts[DEFAULT_LAYOUT_ID] ?? DEFAULT_LAYOUT;
}

/**
 * Wires the two server-push layout events into this store. Layouts are global, so the server
 * broadcasts them to every client (not per floor) — see `core/realtime` on the server.
 *
 * NOT called automatically: `lib/connection.ts` owns wiring up all live socket listeners
 * (`wireLive()`), so it should call `registerLayoutEvents(getSocket())` once, alongside its other
 * `s.on(...)` registrations. It should also seed this store from `snapshot.layouts` in `resync()`.
 */
export function registerLayoutEvents(socket: OfficeSocket): void {
  socket.on('layout:upsert', (l) => useLayoutStore.getState().upsertLayout(l));
  socket.on('layout:remove', (id) => useLayoutStore.getState().removeLayout(id));
}
