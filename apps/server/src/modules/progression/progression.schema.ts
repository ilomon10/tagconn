import { BATTLE_ID_RE, CLASS_IDS, LOOT_IDS, LootIdSchema, PROGRESSION_LIMITS, SKILL_ID_RE, type HeroProgressCore } from '@tagconn/shared';
import { z } from 'zod';

export const BattleParamsSchema = z.object({ id: z.string().regex(BATTLE_ID_RE) });

/** Per route family, in memory, per app instance. */
export const WRITE_LIMIT = { max: 30, windowMs: 60_000 } as const;
/** F10: per-route request body limits (bytes). */
export const BODY_LIMIT = { default: 16_384, resolve: 32_768 } as const;
/** F1: largest serialized BattleSetup the repository stores. */
export const MAX_SETUP_BYTES = 32 * 1024;
/** F1: resolved rows keep setup/log this long for idempotent repeats. */
export const RESOLVED_KEEP_MS = 24 * 3_600_000;

const nullProto = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/**
 * F14: parse schema for the stored hero_progress JSON columns. Input is `{ skills, loot }` as parsed from the
 * columns. Skill keys that fail SKILL_ID_RE (e.g. a stored `__proto__`) are dropped, not an error; a matching key
 * with a bad rank, or more than `maxSkillKeys` keys, fails the parse. The result is a null-prototype record, built
 * from `Object.entries` so no key can reach `Object.prototype`. Loot is validated and deduped.
 */
export const StoredCoreSchema: z.ZodType<Pick<HeroProgressCore, 'skills' | 'loot'>> = z.object({
  skills: z.unknown().transform((v, ctx) => {
    const out = nullProto<number>();
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      ctx.addIssue({ code: 'custom', message: 'skills must be an object' });
      return out;
    }
    for (const [key, rank] of Object.entries(v)) {
      if (!SKILL_ID_RE.test(key)) continue;
      if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1 || rank > 10) {
        ctx.addIssue({ code: 'custom', message: `bad rank for ${key}` });
        return out;
      }
      out[key] = rank;
    }
    if (Object.keys(out).length > PROGRESSION_LIMITS.maxSkillKeys) ctx.addIssue({ code: 'custom', message: 'too many skills' });
    return out;
  }),
  loot: z
    .array(LootIdSchema)
    .max(LOOT_IDS.length)
    .transform((l) => [...new Set(l)]),
});

/** Scalar columns of a stored hero_progress row. */
export const StoredScalarsSchema = z.object({
  classId: z.enum(CLASS_IDS),
  xp: z.number().int().min(0),
  bonusPoints: z.number().int().min(0),
  koUntil: z.number().nullable(),
  wins: z.number().int().min(0),
  losses: z.number().int().min(0),
  flees: z.number().int().min(0),
  equippedTitle: LootIdSchema.nullable(),
  updatedAt: z.number(),
  skillsUpdatedAt: z.number().default(0),
});

/** Sliding-window rate limiter (in memory). `max` is read per call so a settings change applies at once. */
export class SlidingWindowLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max: () => number,
    private readonly windowMs: number,
  ) {}

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.hits.length && (this.hits[i] as number) <= cutoff) i++;
    if (i > 0) this.hits = this.hits.slice(i);
  }

  /** True when another event fits the window (does not record it). */
  check(now: number): boolean {
    this.trim(now);
    return this.hits.length < this.max();
  }

  /** Records one event. */
  record(now: number): void {
    this.hits.push(now);
  }

  /** check + record in one call (used where every attempt counts). */
  take(now: number): boolean {
    if (!this.check(now)) return false;
    this.record(now);
    return true;
  }
}
