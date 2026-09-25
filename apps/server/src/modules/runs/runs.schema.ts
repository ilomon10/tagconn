import { RUN_KINDS, UUID_RE } from '@tagconn/shared';
import { z } from 'zod';

/** REST query string version of `RunListQuery` (shared schema takes real numbers; a query string needs coercion). */
export const RunsListQuerySchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
  kind: z.enum(RUN_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const RunIdParamsSchema = z.object({ runId: z.string().regex(UUID_RE) });

export const RunFollowUpBodySchema = z.object({ prompt: z.string().trim().min(1).max(100_000) });
