import { z } from 'zod';

export const SnapshotQuerySchema = z.object({ projectId: z.string().min(1).optional() });
