import type { PendingProfileImport } from '@tagconn/shared';

/**
 * Pure list transforms for the pending-imports queue (M8 8j, docs/design/runner-and-helpdesk.md
 * section 6.3). Kept separate from `store.ts` so the "toast reducer" behavior — how a fresh
 * `attribution:pending` push or a `attribution:pendingCleared` affects what's on screen — is testable
 * without a socket or zustand in the loop.
 */

/** A newer push for a project already pending replaces it (never duplicates); otherwise it's newest-first. */
export function upsertPending(list: PendingProfileImport[], item: PendingProfileImport): PendingProfileImport[] {
  const i = list.findIndex((p) => p.projectId === item.projectId);
  if (i === -1) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** Used both after a local resolve() and on the server's `attribution:pendingCleared` push. */
export function removePending(list: PendingProfileImport[], projectId: string): PendingProfileImport[] {
  return list.filter((p) => p.projectId !== projectId);
}

/**
 * Plain-text summary of what an Import would do, shared by the toast host and the Settings →
 * Attribution list (section 6.3: "what will be imported, and the unknown roles that will be
 * dropped"). Every piece is interpolated as JSX text (never `dangerouslySetInnerHTML`), so untrusted
 * profile strings (`floorName`) are always escaped by React regardless of how this is rendered.
 */
export function describeImport(item: PendingProfileImport): { items: string[]; skipped: string | null } {
  const items = [`Floor "${item.floorName}"`];
  if (item.hasLayout) items.push('a saved layout');
  if (item.heroCount > 0) items.push(`${item.heroCount} hero${item.heroCount === 1 ? '' : 'es'}`);
  const skipped = item.unknownRoles.length
    ? `${item.unknownRoles.length} hero${item.unknownRoles.length === 1 ? '' : 'es'} skipped (role not found here): ${item.unknownRoles.join(', ')}`
    : null;
  return { items, skipped };
}
