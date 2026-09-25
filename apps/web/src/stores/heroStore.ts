import { create } from 'zustand';
import type { Hero } from '@tagconn/shared';
import type { OfficeSocket } from '../lib/socket';

/**
 * Heroes registry (M8 8i). Heroes are keyed by id and broadcast to every client (like layouts), not
 * scoped to the subscribed floor, so a hero looks the same everywhere and survives floor switches.
 * See docs/design/living-office.md section 3 and `apps/web/src/stores/layoutStore.ts`.
 *
 * Security hardening: a hero id is server-generated (`HERO_ID_RE`: `h-` + 8 hex) and the schema
 * already excludes reserved JS keys from `role`, but the id itself ultimately comes from the network
 * (snapshot, socket push, or — in demo mode — this module's own generator). Storing the map as a
 * null-prototype object (not a `{}` literal, which always inherits `Object.prototype`) means a
 * lookup for e.g. `"constructor"` finds nothing instead of resolving to `Object.prototype.constructor`.
 * `Object.hasOwn` is used everywhere on top of that, belt-and-braces (same convention as `layoutStore`).
 */

function emptyHeroMap(): Record<string, Hero> {
  return Object.create(null) as Record<string, Hero>;
}

/** Shallow-copies `base` into a fresh null-prototype map (plain object spread would re-inherit
 * `Object.prototype`, undoing the hardening above). */
function cloneHeroMap(base: Record<string, Hero>): Record<string, Hero> {
  return Object.assign(emptyHeroMap(), base);
}

export const getHero = (heroes: Record<string, Hero>, id: string): Hero | undefined => (Object.hasOwn(heroes, id) ? heroes[id] : undefined);

export interface HeroState {
  heroes: Record<string, Hero>;
  setHeroes(list: Hero[]): void;
  upsertHero(h: Hero): void;
  removeHero(id: string): void;
}

export const useHeroStore = create<HeroState>()((set) => ({
  heroes: emptyHeroMap(),
  setHeroes: (list) => {
    const heroes = emptyHeroMap();
    for (const h of list) heroes[h.id] = h;
    set({ heroes });
  },
  upsertHero: (h) =>
    set((s) => {
      const heroes = cloneHeroMap(s.heroes);
      heroes[h.id] = h;
      return { heroes };
    }),
  removeHero: (id) =>
    set((s) => {
      if (!Object.hasOwn(s.heroes, id)) return {};
      const heroes = cloneHeroMap(s.heroes);
      delete heroes[id];
      return { heroes };
    }),
}));

/** Heroes of one floor, for the roster / hero editor. `Object.values` only yields own properties, so
 *  this is already safe against a hostile `projectId` — it can only ever match a stored hero. */
export function heroesForProject(heroes: Record<string, Hero>, projectId: string): Hero[] {
  return Object.values(heroes).filter((h) => h.projectId === projectId);
}

/**
 * Wires the two server-push hero events into this store. Heroes are broadcast to `rooms.all` plus the
 * hero's own project room (docs/design/living-office.md section 2.2), so every connected client stays
 * in sync regardless of which floor it is subscribed to — same pattern as `registerLayoutEvents`.
 *
 * NOT called automatically: `lib/connection.ts` owns wiring up all live socket listeners (`wireLive()`),
 * so it should call `registerHeroEvents(getSocket())` once, alongside its other `s.on(...)` registrations.
 * It should also seed this store from `snapshot.heroes` in `resync()` and on a pushed `snapshot`.
 */
export function registerHeroEvents(socket: OfficeSocket): void {
  socket.on('hero:upsert', (h) => useHeroStore.getState().upsertHero(h));
  socket.on('hero:remove', (id) => useHeroStore.getState().removeHero(id));
}
