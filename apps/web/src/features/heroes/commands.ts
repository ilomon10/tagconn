import { generateHeroAppearance, heroSeed, namePoolFor, pickHeroName, type Hero, type HeroCreate, type HeroPatch } from '@tagconn/shared';
import { isDemo } from '../../lib/connection';
import { heroSocket } from '../../lib/socket';
import { demoHeroes } from '../../lib/mock';
import { useHeroStore } from '../../stores/heroStore';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * User-initiated hero writes (the hero editor). Mirrors `lib/layoutCommands.ts`: live mode goes over
 * the `heroes:*` socket (docs/design/living-office.md section 2.2/3.3), demo mode edits `heroStore`
 * directly and persists through `lib/mock.ts`'s `demoHeroes.saveDemoHeroes()` (the same `localStorage`
 * key the automatic agent binding uses), so a hand-edited hero survives a page reload too.
 */

/** Server-generated id shape (`HERO_ID_RE`): `h-` + 8 lowercase hex chars, minted client-side in demo
 *  mode because there's no server to hand one out (mirrors `lib/mock.ts`'s own `nextHeroId`). */
function freshDemoId(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const id = `h-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return Object.hasOwn(useHeroStore.getState().heroes, id) ? freshDemoId() : id;
}

/** Same fallback base `heroes.service.ts` uses: the role's plain (un-themed) title, or the raw role key. */
function roleTitleFallback(role: string): string {
  return useSettingsStore.getState().roles.find((r) => r.name === role)?.title ?? role;
}

export type HeroWriteFailure =
  | { kind: 'conflict'; message: string }
  | { kind: 'cap'; capKind: 'role' | 'project'; message: string }
  | { kind: 'bound'; message: string }
  | { kind: 'other'; message: string };

/**
 * Classifies a failed hero write by matching the server's message text (`heroes.service.ts`), same
 * approach as `classifySaveLayoutError` — the socket ack only carries a message, no status code.
 * Demo mode throws these same messages itself (see `createHero`/`deleteHero` below), so this
 * classifier works identically in both modes.
 */
export function classifyHeroError(err: unknown): HeroWriteFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('was changed since you loaded it')) return { kind: 'conflict', message };
  if (message.includes('heroes.maxPerRole')) return { kind: 'cap', capKind: 'role', message };
  if (message.includes('heroes.maxPerProject')) return { kind: 'cap', capKind: 'project', message };
  if (message.includes('is bound to a live agent')) return { kind: 'bound', message };
  return { kind: 'other', message };
}

/** Recruit (`POST /api/heroes` / `heroes:create`): takes the lowest free slot of (projectId, role),
 *  409s with a clear cap error when `heroes.maxPerRole`/`maxPerProject` is reached. */
export async function createHero(input: HeroCreate): Promise<Hero> {
  if (isDemo()) {
    const cfg = useSettingsStore.getState().settings.heroes;
    const heroes = Object.values(useHeroStore.getState().heroes);
    const projectHeroes = heroes.filter((h) => h.projectId === input.projectId);
    const roleHeroes = projectHeroes.filter((h) => h.role === input.role);
    if (roleHeroes.length >= cfg.maxPerRole) {
      throw new Error(`Cannot create hero: at most ${cfg.maxPerRole} heroes per role may be stored (heroes.maxPerRole)`);
    }
    if (projectHeroes.length >= cfg.maxPerProject) {
      throw new Error(`Cannot create hero: at most ${cfg.maxPerProject} heroes per project may be stored (heroes.maxPerProject)`);
    }
    const used = new Set(roleHeroes.map((h) => h.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const seed = heroSeed(input.projectId, input.role, slot);
    const name = input.name ?? pickHeroName(namePoolFor(cfg.namePools, input.role), projectHeroes.map((h) => h.name), seed, roleTitleFallback(input.role));
    const now = Date.now();
    const hero: Hero = {
      id: freshDemoId(),
      projectId: input.projectId,
      role: input.role,
      slot,
      name,
      title: input.title ?? null,
      appearance: { ...generateHeroAppearance(seed), ...(input.appearance ?? {}) },
      customized: input.name !== undefined || input.title !== undefined || input.appearance !== undefined,
      boundAgentId: null,
      boundAt: null,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    useHeroStore.getState().upsertHero(hero);
    demoHeroes.saveDemoHeroes();
    return hero;
  }
  const hero = await heroSocket.create(input);
  useHeroStore.getState().upsertHero(hero);
  return hero;
}

/** `PATCH /api/heroes/:id` / `heroes:update`. `patch.baseUpdatedAt` asks for a 409 (`classifyHeroError`
 *  -> 'conflict') if the hero changed since it was loaded; demo mode has one client, so it's ignored. */
export async function patchHero(id: string, patch: HeroPatch): Promise<Hero> {
  if (isDemo()) {
    const existing = useHeroStore.getState().heroes[id];
    if (!existing) throw new Error(`Hero "${id}" not found`);
    const updated: Hero = {
      ...existing,
      name: patch.name ?? existing.name,
      title: patch.title === undefined ? existing.title : patch.title,
      appearance: { ...existing.appearance, ...(patch.appearance ?? {}) },
      customized: true,
      updatedAt: Date.now(),
    };
    useHeroStore.getState().upsertHero(updated);
    demoHeroes.saveDemoHeroes();
    return updated;
  }
  const updated = await heroSocket.update(id, patch);
  useHeroStore.getState().upsertHero(updated);
  return updated;
}

/** `POST /api/heroes/:id/reset` / `heroes:reset`: regenerates the seeded name and appearance, clearing `customized`. */
export async function resetHero(id: string): Promise<Hero> {
  if (isDemo()) {
    const existing = useHeroStore.getState().heroes[id];
    if (!existing) throw new Error(`Hero "${id}" not found`);
    const seed = heroSeed(existing.projectId, existing.role, existing.slot);
    const taken = Object.values(useHeroStore.getState().heroes)
      .filter((h) => h.projectId === existing.projectId && h.id !== id)
      .map((h) => h.name);
    const cfg = useSettingsStore.getState().settings.heroes;
    const updated: Hero = {
      ...existing,
      name: pickHeroName(namePoolFor(cfg.namePools, existing.role), taken, seed, roleTitleFallback(existing.role)),
      title: null,
      appearance: generateHeroAppearance(seed),
      customized: false,
      updatedAt: Date.now(),
    };
    useHeroStore.getState().upsertHero(updated);
    demoHeroes.saveDemoHeroes();
    return updated;
  }
  const updated = await heroSocket.reset(id);
  useHeroStore.getState().upsertHero(updated);
  return updated;
}

/** `DELETE /api/heroes/:id` / `heroes:delete`. Rejected while bound to a live agent (`classifyHeroError`
 *  -> 'bound'); the editor also disables the button in that state, this is the defense-in-depth check. */
export async function deleteHero(id: string): Promise<void> {
  if (isDemo()) {
    const existing = useHeroStore.getState().heroes[id];
    if (!existing) throw new Error(`Hero "${id}" not found`);
    if (existing.boundAgentId !== null && existing.releasedAt === null) throw new Error(`Hero "${id}" is bound to a live agent`);
    useHeroStore.getState().removeHero(id);
    demoHeroes.saveDemoHeroes();
    return;
  }
  await heroSocket.delete(id);
  useHeroStore.getState().removeHero(id);
}
