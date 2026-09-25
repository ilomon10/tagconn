import { z } from 'zod';

/** REST param/body schemas mirroring the shared socket schemas (`ConversationCreateSchema`,
 * `ReceptionistSendSchema` in `@tagconn/shared`), split so `conversationId` comes from the URL instead
 * of the body (same pattern as `modules/runs/runs.schema.ts`'s `RunFollowUpBodySchema`). */
export const ConversationIdParamsSchema = z.object({ id: z.string().min(1).max(200) });

export const ReceptionistSendBodySchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .refine((s) => !s.includes('\0'), 'text must not contain NUL'),
});
