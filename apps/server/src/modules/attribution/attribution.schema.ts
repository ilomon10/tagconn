import { z } from 'zod';

/** `GET /api/attribution/export?cwd=`; loose on purpose (an unknown/unregistered cwd just 404s). */
export const AttributionExportQuerySchema = z.object({ cwd: z.string().min(1).max(4096) });
