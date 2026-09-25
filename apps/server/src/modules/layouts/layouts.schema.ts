import { LAYOUT_ID_RE } from '@tagconn/shared';
import { z } from 'zod';

/** Loose on purpose (mirrors `RoleParamsSchema`): an id that doesn't match `LAYOUT_ID_RE` simply
 * won't be found, so GET/DELETE still 404 instead of 400. */
export const LayoutParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** PUT stores under this id, so it must match `LAYOUT_ID_RE` up front (400): letting an invalid id
 * through would write a row that then fails `OfficeLayoutSchema` on read and is unlistable /
 * undeletable (see `LayoutsRepository.purgeInvalidIds`). */
export const LayoutPutParamsSchema = z.object({ id: z.string().regex(LAYOUT_ID_RE) });
