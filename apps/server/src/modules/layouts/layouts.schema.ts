import { z } from 'zod';

/** Loose on purpose (mirrors `RoleParamsSchema`): an id that doesn't match `LAYOUT_ID_RE` simply
 * won't be found, so lookups still 404 instead of 400. */
export const LayoutParamsSchema = z.object({ id: z.string().min(1).max(64) });
