import { RoleSchema } from '@tagconn/shared';
import { z } from 'zod';

export const RoleParamsSchema = z.object({ name: z.string().min(1).max(64) });
/** Body of PUT /api/roles/:name; `name` optional (taken from the URL), `builtin` is server-owned. */
export const RoleBodySchema = RoleSchema.omit({ builtin: true }).partial({ name: true });
