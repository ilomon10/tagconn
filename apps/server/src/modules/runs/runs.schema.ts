import { PromptSchema, RUN_KINDS, UUID_RE } from '@tagconn/shared';
import { z } from 'zod';

/** REST query string version of `RunListQuery` (shared schema takes real numbers; a query string needs coercion). */
export const RunsListQuerySchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
  kind: z.enum(RUN_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const RunIdParamsSchema = z.object({ runId: z.string().regex(UUID_RE) });

/** L5: the same strict `PromptSchema` the socket path (`RunFollowUpRequestSchema`) already used —
 * this REST body previously allowed a bare `z.string()` with no NUL check. */
export const RunFollowUpBodySchema = z.strictObject({ prompt: PromptSchema });
