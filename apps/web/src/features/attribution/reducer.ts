import type { AttributionWriteResult, PendingProfileImport } from '@tagconn/shared';

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

/**
 * "Save profile to project" (M8 8k/8l, docs/design/runner-and-helpdesk.md §6.4). Plain-text summary
 * of what a save WOULD write, for the confirm dialog — same style as `describeImport`, but built from
 * local floor/hero state (there's nothing pending to describe: a save is always explicit). It never
 * mentions the target file path itself (the caller shows `<cwd>/.tagconn/office.json` separately) and
 * never any host path, since the written profile can't contain one either (`looksLikeHostPath`).
 */
export function describeSaveTarget(floorName: string, hasLayout: boolean, heroCount: number): string[] {
  const items = [`Floor "${floorName}"`];
  if (hasLayout) items.push('the current layout');
  if (heroCount > 0) items.push(`${heroCount} hero${heroCount === 1 ? '' : 'es'}`);
  return items;
}

/**
 * Turns the runner's `AttributionWriteResult` (relayed by `attribution:save`'s ack) into the one-line
 * toast shown after a save attempt, and whether the caller should re-ask with `overwrite: true`: the
 * file already existed and — because the first attempt never sends `overwrite` — nothing was written.
 */
export function describeSaveResult(result: AttributionWriteResult): { message: string; needsOverwriteConfirm: boolean } {
  if (result.written) return { message: `Saved to ${result.relativePath}${result.existed ? ' (overwritten)' : ''}.`, needsOverwriteConfirm: false };
  return { message: `${result.relativePath} already exists in this project.`, needsOverwriteConfirm: true };
}
