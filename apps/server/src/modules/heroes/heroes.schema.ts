import { HERO_ID_RE } from '@tagconn/shared';
import { z } from 'zod';

/**
 * Unlike layout ids (user-chosen, so GET/DELETE stays 404-only), hero ids are always server-generated,
 * so a URL param that doesn't match `HERO_ID_RE` is rejected up front with 400, before any DB access
 * (docs/design/living-office.md §3.3).
 */
export const HeroParamsSchema = z.object({ id: z.string().regex(HERO_ID_RE) });
