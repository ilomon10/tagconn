/** Memo key for the Receptionist's look: the scene re-applies it only when one of these changes,
 *  so the frequent applyState/busy calls do not restart her pose. Pure, so it is unit-tested. */
export function receptionistLookKey(themeId: string, busy: boolean, enabled: boolean, title: string, ambient: boolean): string {
  return [themeId, busy ? 1 : 0, enabled ? 1 : 0, ambient ? 1 : 0, title].join('|');
}
