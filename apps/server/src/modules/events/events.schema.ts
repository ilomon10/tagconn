import { z } from 'zod';

export const EventsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  /** Event id cursor: only events with a smaller id. */
  before: z.coerce.number().int().positive().optional(),
});
