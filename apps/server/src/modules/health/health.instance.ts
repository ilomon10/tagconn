import { randomUUID } from 'node:crypto';

/**
 * Random per **process** boot (not per request, not persisted). Exposed by `GET /api/health` so
 * `pnpm office:pair` and `office:doctor` can compare it against the `instanceId` returned in an
 * `/api/auth/pairing-challenge` response, through the web proxy, to catch a squatter on :4318
 * (docs/design/runner-and-helpdesk.md §5.2). A module-level constant (not a DI value) so it is
 * trivial to share with `modules/auth` without any registration-order dependency between the two
 * modules (see the comment on that import site).
 */
export const INSTANCE_ID = randomUUID();
