import { z } from 'zod';
import type { Activity } from './domain.js';
import { MAIN_ROLE } from './roles.js';

/**
 * Named, customizable heroes (M8 8i). A hero is a persistent character identity per
 * (projectId, role, slot): a name, an optional pronoun-free title and an appearance. Live agents are
 * bound to heroes by the server (`chooseHeroForAgent`), so the same named character comes back for
 * the next subagent of that role on that floor, across restarts. See docs/design/living-office.md.
 */

// ------------------------------------------------------------------ limits and ids

export const HERO_LIMITS = {
  maxNameLength: 40,
  maxTitleLength: 60,
  /** Names per role in `heroes.namePools`. */
  maxPoolNames: 200,
  /** Hard ceilings for the `heroes.maxPerRole` / `heroes.maxPerProject` settings. */
  hardMaxPerRole: 64,
  hardMaxPerProject: 256,
  maxProjectIdLength: 200,
} as const;

/** Server-generated: `h-` plus 8 lowercase hex characters. */
export const HERO_ID_RE = /^h-[a-f0-9]{8}$/;

/**
 * Role key of a hero: a role name, or a raw Claude agent type when no role matches (those may be
 * mixed case, e.g. "Explore", or plugin-scoped, e.g. "plugin:agent"). Reserved JS property names are
 * excluded so a role key can never poison a plain-object lookup (e.g. `namePools[role]`).
 */
export const HERO_ROLE_RE = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Key in `heroes.namePools` used for roles without their own pool. */
export const HERO_DEFAULT_POOL_KEY = 'default';

// ------------------------------------------------------------------ appearance vocabulary

/** Curated skin tones (same values as the web's `SKIN_TONES`). The editor also allows a custom hex. */
export const HERO_SKIN_TONES = ['#f5c89a', '#e3ab7c', '#c08457', '#8d5a36', '#ffe0bd'] as const;
/** Curated hair colours (same values as the web's `HAIR_COLORS`). */
export const HERO_HAIR_COLORS = ['#3b2a20', '#16110f', '#d6a852', '#8d3b1f', '#8a8a8a', '#6a4a9a', '#2f4f6f'] as const;
/** Number of `ch-hair-<n>` bitmaps (the web's `HAIR_STYLES`). */
export const HERO_HAIR_STYLE_COUNT = 7;

/** `auto` = whatever the active theme's costume gives the role (nothing under `modern`). */
export const HERO_HATS = ['auto', 'none', 'wizard', 'hood', 'crown', 'helm', 'bard-cap', 'circlet'] as const;
export type HeroHat = (typeof HERO_HATS)[number];
export const HERO_PROPS = ['auto', 'none', 'staff', 'wand', 'hammer', 'quill', 'lute', 'shield'] as const;
export type HeroProp = (typeof HERO_PROPS)[number];
export const HERO_ACCESSORIES = ['auto', 'none', 'goggles', 'cloak'] as const;
export type HeroAccessory = (typeof HERO_ACCESSORIES)[number];

// ------------------------------------------------------------------ schemas

/** Same rule as layout names: strip control chars and bidi override/isolate marks. */
const stripControlAndBidi = (s: string): string => s.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, '');

export const HeroNameSchema = z
  .string()
  .transform(stripControlAndBidi)
  .pipe(z.string().trim().min(1).max(HERO_LIMITS.maxNameLength));

export const HeroTitleSchema = z
  .string()
  .transform(stripControlAndBidi)
  .pipe(z.string().trim().min(1).max(HERO_LIMITS.maxTitleLength));

const HexColorSchema = z
  .string()
  .regex(HEX_COLOR_RE)
  .transform((s) => s.toLowerCase());

export const HeroAppearanceSchema = z.strictObject({
  skin: HexColorSchema,
  hairStyle: z
    .number()
    .int()
    .min(0)
    .max(HERO_HAIR_STYLE_COUNT - 1),
  hairColor: HexColorSchema,
  /** null = the role colour (keeps role colours meaningful). */
  outfitColor: HexColorSchema.nullable(),
  hat: z.enum(HERO_HATS),
  /** null = the theme's hat colour for the role, else the outfit colour. */
  hatColor: HexColorSchema.nullable(),
  prop: z.enum(HERO_PROPS),
  accessory: z.enum(HERO_ACCESSORIES),
  /** Cloak colour when `accessory` is `cloak`; null = the theme's cloak colour, else the role colour. */
  accessoryColor: HexColorSchema.nullable(),
});
export type HeroAppearance = z.infer<typeof HeroAppearanceSchema>;

export const HeroRoleSchema = z.string().regex(HERO_ROLE_RE);
const ProjectIdSchema = z.string().min(1).max(HERO_LIMITS.maxProjectIdLength);

/** A stored hero, as returned by REST, socket acks and broadcasts. */
export const HeroSchema = z.object({
  id: z.string().regex(HERO_ID_RE),
  projectId: ProjectIdSchema,
  /** `MAIN_ROLE` ('pm') for heroes of main agents; slot 0 of 'pm' is the floor's Guild Master. */
  role: HeroRoleSchema,
  slot: z
    .number()
    .int()
    .min(0)
    .max(HERO_LIMITS.hardMaxPerRole - 1),
  name: HeroNameSchema,
  /** Pronoun-free title override, e.g. "Keeper of Tests". null = the themed role title. */
  title: HeroTitleSchema.nullable(),
  appearance: HeroAppearanceSchema,
  /** True once a user edited the name, title or appearance; `reset` clears it. */
  customized: z.boolean(),
  /** Agent currently (or last) bound. Kept after release so a finished agent keeps its hero look. */
  boundAgentId: z.string().nullable(),
  boundAt: z.number().nullable(),
  /** Set when the bound agent finished or was removed; null while bound to a live agent. */
  releasedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Hero = z.infer<typeof HeroSchema>;

/** `POST /api/heroes` / `heroes:create`: takes the lowest free slot of (projectId, role). */
export const HeroCreateSchema = z.strictObject({
  projectId: ProjectIdSchema,
  role: HeroRoleSchema,
  /** Omitted = next name from the role's pool. */
  name: HeroNameSchema.optional(),
  title: HeroTitleSchema.nullable().optional(),
  /** Omitted fields come from the seeded default appearance. */
  appearance: HeroAppearanceSchema.partial().optional(),
});
export type HeroCreate = z.input<typeof HeroCreateSchema>;

/** `PATCH /api/heroes/:id`. Appearance fields merge into the stored appearance. */
export const HeroPatchSchema = z.strictObject({
  name: HeroNameSchema.optional(),
  title: HeroTitleSchema.nullable().optional(),
  appearance: HeroAppearanceSchema.partial().optional(),
  /** Optimistic concurrency, same semantics as layouts: 409 when the stored `updatedAt` differs. */
  baseUpdatedAt: z.number().optional(),
});
export type HeroPatch = z.input<typeof HeroPatchSchema>;

/** Socket payload of `heroes:update`. */
export const HeroUpdateRequestSchema = z.strictObject({
  id: z.string().regex(HERO_ID_RE),
  patch: HeroPatchSchema,
});
export type HeroUpdateRequest = z.input<typeof HeroUpdateRequestSchema>;

/** Socket payload of `heroes:list` and query of `GET /api/heroes`. Omitted projectId = all. */
export const HeroListRequestSchema = z.strictObject({ projectId: ProjectIdSchema.optional() });
export type HeroListRequest = z.input<typeof HeroListRequestSchema>;

/** `heroes.namePools`: role key (or `default`) → names. Replaced wholesale by settings patches. */
export const HeroNamePoolsSchema = z.record(HeroRoleSchema, z.array(HeroNameSchema).max(HERO_LIMITS.maxPoolNames));
export type HeroNamePools = z.infer<typeof HeroNamePoolsSchema>;

/** Guild-flavoured defaults. Editable in the GUI (Heroes → Name pools) or `config/office.yaml`. */
export const DEFAULT_HERO_NAME_POOLS: HeroNamePools = {
  pm: ['Aldric', 'Seraphine', 'Magnus', 'Isolde', 'Theron', 'Rowena', 'Cassian', 'Elowen'],
  analyst: ['Sybil', 'Orin', 'Pythia', 'Lark', 'Vesna', 'Quill', 'Ismay', 'Corvin'],
  architect: ['Merriwen', 'Balthazar', 'Ysolde', 'Caspian', 'Morwenna', 'Elric', 'Thalia', 'Gideon'],
  developer: ['Brom', 'Tamsin', 'Wendel', 'Pip', 'Hilda', 'Garrick', 'Nessa', 'Tobin', 'Maren', 'Fenn', 'Odile', 'Rurik'],
  'qa-engineer': ['Hazel', 'Alaric', 'Brewin', 'Saffi', 'Tansy', 'Mortimer', 'Juniper', 'Cobb'],
  'code-reviewer': ['Ambrose', 'Wren', 'Ottilie', 'Ferris', 'Mabel', 'Silas', 'Verity', 'Jory'],
  'security-engineer': ['Aldous', 'Brienne', 'Cedric', 'Gwendolyn', 'Roderick', 'Ysolt', 'Tristan', 'Hale'],
  'devops-engineer': ['Thorgrim', 'Anvil', 'Greta', 'Bram', 'Sigrun', 'Durin', 'Kettle', 'Ingrid'],
  'tech-writer': ['Lyra', 'Emrys', 'Calliope', 'Finnian', 'Rosalind', 'Taliesin', 'Oriel', 'Bardolph'],
  [HERO_DEFAULT_POOL_KEY]: ['Rook', 'Ember', 'Ash', 'Briar', 'Colm', 'Dara', 'Esk', 'Fable', 'Gale', 'Heath'],
};

// ------------------------------------------------------------------ pure helpers (server + web demo)

/** Role key a hero is looked up by: main agents use `MAIN_ROLE`, subagents their resolved role. */
export const heroRoleFor = (agent: { isMain: boolean; role: string }): string => (agent.isMain ? MAIN_ROLE : agent.role);

/** A hero is free when it was never bound, or its agent finished/was removed. */
export const isHeroReleased = (h: Pick<Hero, 'boundAgentId' | 'releasedAt'>): boolean => h.boundAgentId === null || h.releasedAt !== null;

/** Own-property lookup of a role's pool, falling back to `default`, then to no names. */
export function namePoolFor(pools: HeroNamePools, role: string): readonly string[] {
  const own = (k: string): string[] | undefined => (Object.prototype.hasOwnProperty.call(pools, k) ? pools[k] : undefined);
  return own(role) ?? own(HERO_DEFAULT_POOL_KEY) ?? [];
}

/** FNV-1a 32-bit. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable seed of a hero identity: the same (project, role, slot) always looks and is named the same. */
export const heroSeed = (projectId: string, role: string, slot: number): number => fnv1a(`${projectId}|${role}|${slot}`);

/** Deterministic default look. Costume fields stay `auto` so the theme still dresses the role. */
export function generateHeroAppearance(seed: number): HeroAppearance {
  const rand = mulberry32(seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length) % arr.length]!;
  return {
    skin: pick(HERO_SKIN_TONES),
    hairStyle: Math.floor(rand() * HERO_HAIR_STYLE_COUNT) % HERO_HAIR_STYLE_COUNT,
    hairColor: pick(HERO_HAIR_COLORS),
    outfitColor: null,
    hat: 'auto',
    hatColor: null,
    prop: 'auto',
    accessory: 'auto',
    accessoryColor: null,
  };
}

const ROMAN_SUFFIXES = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'] as const;

/**
 * Next name for a new hero: walks the pool from a seeded start index and returns the first name not
 * in `taken` (case-insensitive; pass the names of the project's heroes). When the whole pool is used
 * it tries "Name II" … "Name X", then "<fallbackBase> <n>" (fallbackBase is usually the role title).
 */
export function pickHeroName(pool: readonly string[], taken: Iterable<string>, seed: number, fallbackBase: string): string {
  const max = HERO_LIMITS.maxNameLength;
  const used = new Set<string>();
  for (const t of taken) used.add(t.trim().toLowerCase());
  const isFree = (s: string) => s.length > 0 && !used.has(s.toLowerCase());
  const withSuffix = (base: string, suffix: string) => `${base.slice(0, max - suffix.length - 1).trim()} ${suffix}`;

  const names = pool.map((n) => n.trim().slice(0, max).trim()).filter((n) => n.length > 0);
  if (names.length > 0) {
    const start = (seed >>> 0) % names.length;
    for (const suffix of ['', ...ROMAN_SUFFIXES]) {
      for (let i = 0; i < names.length; i++) {
        const base = names[(start + i) % names.length]!;
        const candidate = suffix ? withSuffix(base, suffix) : base;
        if (isFree(candidate)) return candidate;
      }
    }
  }
  const base = fallbackBase.trim().slice(0, max).trim() || 'Hero';
  for (let n = 1; n <= 10_000; n++) {
    const candidate = withSuffix(base, String(n));
    if (isFree(candidate)) return candidate;
  }
  return withSuffix(base, String(seed >>> 0));
}

/** What the heroes module knows about a bound agent (tracked from `agent.upserted` / `agent.removed`). */
export interface BoundAgentState {
  /** Not removed from the floor and not `done`. */
  live: boolean;
  activity: Activity;
  /** `Agent.updatedAt` of the latest upsert. */
  lastEventAt: number;
}

export interface HeroAssignInput {
  agent: { id: string; projectId: string; isMain: boolean; role: string };
  /** Heroes of at least this project (others are ignored). */
  heroes: readonly Pick<Hero, 'id' | 'projectId' | 'role' | 'slot' | 'boundAgentId' | 'releasedAt'>[];
  /** State of bound agents by id. A bound id missing from the map counts as gone (free). */
  agents: ReadonlyMap<string, BoundAgentState>;
  maxPerRole: number;
  maxPerProject: number;
  /** Seconds a live subagent must sit `idle` before its hero may be taken over; 0 = never. */
  reuseIdleAfterSec: number;
  now: number;
}

export type HeroAssignment =
  | { kind: 'keep'; heroId: string }
  | { kind: 'reuse'; heroId: string; /** Live idle agent that loses this hero, if any. */ takenFrom: string | null }
  | { kind: 'create'; slot: number }
  | { kind: 'none'; reason: 'role-full' | 'project-full' };

/**
 * Assignment rule (docs/design/living-office.md section 3.2), in order:
 * 1. keep the hero already bound to this agent (also after a stale release, if nobody took it);
 * 2. reuse a released hero of the same role on the floor: main agents prefer slot 0 (Guild Master),
 *    otherwise the most recently released (most likely still resting in the tavern), then lowest slot;
 * 3. subagents only: take over the hero of a live agent idle for at least `reuseIdleAfterSec`
 *    (longest idle first);
 * 4. create a hero in the lowest unused slot while under `maxPerRole` and `maxPerProject`;
 * 5. otherwise none (the web draws an anonymous character).
 */
export function chooseHeroForAgent(input: HeroAssignInput): HeroAssignment {
  const { agent } = input;
  const role = heroRoleFor(agent);
  const projectHeroes = input.heroes.filter((h) => h.projectId === agent.projectId);
  const roleHeroes = projectHeroes.filter((h) => h.role === role);

  const own = roleHeroes.find((h) => h.boundAgentId === agent.id);
  if (own) return { kind: 'keep', heroId: own.id };

  const isFree = (h: (typeof roleHeroes)[number]): boolean => {
    if (isHeroReleased(h) || h.boundAgentId === null) return true;
    const state = input.agents.get(h.boundAgentId);
    return !state || !state.live;
  };
  const free = roleHeroes.filter(isFree);
  if (free.length > 0) {
    const guildMaster = agent.isMain ? free.find((h) => h.slot === 0) : undefined;
    const best = guildMaster ?? [...free].sort((a, b) => (b.releasedAt ?? -1) - (a.releasedAt ?? -1) || a.slot - b.slot)[0]!;
    return { kind: 'reuse', heroId: best.id, takenFrom: null };
  }

  if (!agent.isMain && input.reuseIdleAfterSec > 0) {
    const cutoff = input.now - input.reuseIdleAfterSec * 1000;
    let pick: { id: string; slot: number; agentId: string; at: number } | undefined;
    for (const h of roleHeroes) {
      if (h.boundAgentId === null) continue;
      const s = input.agents.get(h.boundAgentId);
      if (!s || !s.live || s.activity !== 'idle' || s.lastEventAt > cutoff) continue;
      if (!pick || s.lastEventAt < pick.at || (s.lastEventAt === pick.at && h.slot < pick.slot)) {
        pick = { id: h.id, slot: h.slot, agentId: h.boundAgentId, at: s.lastEventAt };
      }
    }
    if (pick) return { kind: 'reuse', heroId: pick.id, takenFrom: pick.agentId };
  }

  if (roleHeroes.length >= input.maxPerRole) return { kind: 'none', reason: 'role-full' };
  if (projectHeroes.length >= input.maxPerProject) return { kind: 'none', reason: 'project-full' };
  const used = new Set(roleHeroes.map((h) => h.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return { kind: 'create', slot };
}
