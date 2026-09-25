import { create } from 'zustand';
import { DEFAULT_LAYOUT, DEFAULT_LAYOUT_ID, OfficeLayoutSchema, type OfficeLayout, type Project } from '@tagconn/shared';
import type { OfficeSocket } from '../lib/socket';

/**
 * Global layout registry (M7). Layouts are not per-project: a project references one by id
 * (`Project.layoutId`), so this store just keeps every known `OfficeLayout` by id. See
 * docs/design/guild-hall.md D9 and `layoutForProject` below for the fallback chain.
 *
 * Security hardening: an id is server-generated (`<slug>-<8hex>`) and `LAYOUT_ID_RE` excludes
 * `__proto__`/`constructor`/`prototype`, but the map is still keyed by a string that ultimately came
 * from the network — a stale client, an old snapshot, or a future id scheme could carry one of those
 * names. Storing the map as a null-prototype object (not a `{}` literal, which always inherits
 * `Object.prototype`) means a lookup for e.g. `"constructor"` finds nothing instead of resolving to
 * `Object.prototype.constructor`. `Object.hasOwn` is used everywhere on top of that, belt-and-braces.
 */

function emptyLayoutMap(): Record<string, OfficeLayout> {
  return Object.create(null) as Record<string, OfficeLayout>;
}

/** Shallow-copies `base` into a fresh null-prototype map (plain object spread would re-inherit
 * `Object.prototype`, undoing the hardening above). */
function cloneLayoutMap(base: Record<string, OfficeLayout>): Record<string, OfficeLayout> {
  return Object.assign(emptyLayoutMap(), base);
}

const getOwn = (layouts: Record<string, OfficeLayout>, id: string): OfficeLayout | undefined =>
  Object.hasOwn(layouts, id) ? layouts[id] : undefined;

export interface LayoutState {
  layouts: Record<string, OfficeLayout>;
  setLayouts(list: OfficeLayout[]): void;
  upsertLayout(l: OfficeLayout): void;
  removeLayout(id: string): void;
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  layouts: emptyLayoutMap(),
  setLayouts: (list) => {
    const layouts = emptyLayoutMap();
    for (const l of list) layouts[l.id] = l;
    set({ layouts });
  },
  upsertLayout: (l) =>
    set((s) => {
      const layouts = cloneLayoutMap(s.layouts);
      layouts[l.id] = l;
      return { layouts };
    }),
  removeLayout: (id) =>
    set((s) => {
      if (!Object.hasOwn(s.layouts, id)) return {};
      const layouts = cloneLayoutMap(s.layouts);
      delete layouts[id];
      return { layouts };
    }),
}));

/** A cheap-enough structural re-check (full zod parse) before trusting a resolved layout: a
 * malformed or half-written entry falls back to `DEFAULT_LAYOUT` instead of reaching the renderer. */
function asValidLayout(l: OfficeLayout | undefined): OfficeLayout | undefined {
  return l && OfficeLayoutSchema.safeParse(l).success ? l : undefined;
}

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
  for (const id of [project?.layoutId, defaultLayoutId, DEFAULT_LAYOUT_ID]) {
    if (!id) continue;
    const found = asValidLayout(getOwn(layouts, id));
    if (found) return found;
  }
  return DEFAULT_LAYOUT;
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
