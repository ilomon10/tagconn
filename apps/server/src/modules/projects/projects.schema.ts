import { LAYOUT_ID_RE } from '@tagconn/shared';
import { z } from 'zod';

export const ProjectParamsSchema = z.object({ id: z.string().min(1) });
export const ProjectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    archived: z.boolean().optional(),
    /** M7: set or clear (null) this floor's layout. Unknown id -> 400. */
    layoutId: z.string().regex(LAYOUT_ID_RE).nullable().optional(),
  })
  .strict();
