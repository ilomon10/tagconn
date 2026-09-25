import { z } from 'zod';

export const ProjectParamsSchema = z.object({ id: z.string().min(1) });
export const ProjectPatchSchema = z
  .object({ name: z.string().trim().min(1).max(200).optional(), archived: z.boolean().optional() })
  .strict();
