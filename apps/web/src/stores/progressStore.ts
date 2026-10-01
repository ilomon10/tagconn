import { create } from 'zustand';
import type { HeroProgress } from '@tagconn/shared';
import type { OfficeSocket } from '../lib/socket';

/**
 * Hero progression registry (M14, docs/design/battles.md 3.2). Keyed by hero id and broadcast to every client like
 * heroes. Same hardening as `heroStore`: a null-prototype map and `Object.hasOwn` lookups, so a hostile id such as
 * "constructor" or "__proto__" finds nothing.
 */

function emptyMap(): Record<string, HeroProgress> {
  return Object.create(null) as Record<string, HeroProgress>;
}

/** Plain object spread would re-inherit `Object.prototype`; `Object.assign` into a null-prototype map does not. */
function cloneMap(base: Record<string, HeroProgress>): Record<string, HeroProgress> {
  return Object.assign(emptyMap(), base);
}

export const getProgress = (map: Record<string, HeroProgress>, id: string): HeroProgress | undefined => (Object.hasOwn(map, id) ? map[id] : undefined);

export interface ProgressState {
  progress: Record<string, HeroProgress>;
  setAll(list: readonly HeroProgress[]): void;
  upsert(p: HeroProgress): void;
  remove(heroId: string): void;
}

export const useProgressStore = create<ProgressState>()((set) => ({
  progress: emptyMap(),
  setAll: (list) => {
    const progress = emptyMap();
    for (const p of list) progress[p.heroId] = p;
    set({ progress });
  },
  upsert: (p) =>
    set((s) => {
      const progress = cloneMap(s.progress);
      progress[p.heroId] = p;
      return { progress };
    }),
  remove: (heroId) =>
    set((s) => {
      if (!Object.hasOwn(s.progress, heroId)) return {};
      const progress = cloneMap(s.progress);
      delete progress[heroId];
      return { progress };
    }),
}));

/**
 * Wires the server-push progression events into this store. NOT called automatically: `lib/connection.ts` (P1) calls
 * it once next to `registerHeroEvents`, and seeds the store from `snapshot.progress`.
 */
export function registerProgressEvents(socket: OfficeSocket): void {
  socket.on('hero:progress', (p) => useProgressStore.getState().upsert(p));
  socket.on('hero:remove', (id) => useProgressStore.getState().remove(id));
}
