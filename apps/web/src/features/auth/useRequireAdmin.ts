import { useCallback } from 'react';
import { useOfficeStore } from '../../stores/officeStore';
import { useAuthStore } from '../../stores/authStore';
import { PAIR_TO_CHANGE_MESSAGE } from '../../lib/auth';

/**
 * Gate for a write action this browser might not be allowed to perform (M8 8m). Demo mode has no
 * server enforcing auth at all, so it's always allowed there (docs/design/runner-and-helpdesk.md
 * section 5 doesn't apply — there's nothing to pair with). Elsewhere, `guard` runs `fn` only while an
 * admin session is active; otherwise it opens the pairing dialog and shows the same gentle prompt the
 * centralized 401/timeout handling shows, instead of the action failing (or doing nothing) silently.
 *
 * `settings`/`roles`/`layout`/`hero` commands already get this for free once they go through
 * `lib/api.ts`/`lib/socket.ts` (a denied write there surfaces the same toast). This hook is for UI that
 * wants to know *before* attempting the write — e.g. disabling a button or showing an inline prompt.
 */
export function useRequireAdmin() {
  const demo = useOfficeStore((s) => s.connection === 'demo');
  const admin = useAuthStore((s) => s.status.admin);
  const openPairing = useAuthStore((s) => s.openPairing);
  const showToast = useAuthStore((s) => s.showToast);
  const allowed = demo || admin;

  const guard = useCallback(
    <T,>(fn: () => T): T | undefined => {
      if (allowed) return fn();
      showToast(PAIR_TO_CHANGE_MESSAGE);
      openPairing();
      return undefined;
    },
    [allowed, openPairing, showToast],
  );

  return { allowed, guard };
}
