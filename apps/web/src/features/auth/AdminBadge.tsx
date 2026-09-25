import { useEffect, useRef, useState } from 'react';
import { useOfficeStore } from '../../stores/officeStore';
import { useAuthStore } from '../../stores/authStore';
import { Button, cx } from '../../components/ui';
import { PairingDialog } from './PairingDialog';
import { SessionsPanel } from './SessionsPanel';

const TOAST_MS = 4000;

/**
 * M8 8m admin badge (docs/design/runner-and-helpdesk.md section 5): shows locked/unlocked in the top
 * bar, and owns the pairing dialog and sessions panel it opens. Mounted once from `TopBar` (always
 * present regardless of the active tab), same pattern as `HeroPanel`.
 *
 * Demo mode has no server enforcing any of this (`useRequireAdmin` also short-circuits there), so the
 * badge just doesn't render — nothing to lock or unlock.
 */
export function AdminBadge() {
  const connection = useOfficeStore((s) => s.connection);
  const status = useAuthStore((s) => s.status);
  const pairingOpen = useAuthStore((s) => s.pairingOpen);
  const toast = useAuthStore((s) => s.toast);
  const consumeFragment = useAuthStore((s) => s.consumeFragment);
  const refreshStatus = useAuthStore((s) => s.refreshStatus);
  const openPairing = useAuthStore((s) => s.openPairing);
  const closePairing = useAuthStore((s) => s.closePairing);
  const clearToast = useAuthStore((s) => s.clearToast);
  const logout = useAuthStore((s) => s.logout);

  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // A `#pair=<code>` link only needs to be consumed once, on the tab that opened it. The REST status
  // check works immediately (no socket needed), and re-runs whenever we (re)gain a live connection —
  // a reconnect after "Offline" may follow a token that changed in another tab.
  useEffect(() => {
    consumeFragment();
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (connection === 'connected') void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, TOAST_MS);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  if (connection === 'demo') return null;

  const locked = !status.admin;

  return (
    <div ref={menuRef} className="relative flex items-center gap-2">
      {toast && (
        <span role="status" className="whitespace-nowrap rounded-full bg-ink-850/95 px-2.5 py-1 text-[11px] text-ink-100 shadow-lg">
          {toast}
        </span>
      )}
      <Button
        variant={locked ? 'ghost' : 'subtle'}
        onClick={() => (locked ? openPairing() : setMenuOpen((v) => !v))}
        title={locked ? 'Pair this browser to make changes' : 'Admin session active — click for sessions and logout'}
      >
        <span className={cx('size-2 rounded-full', locked ? 'bg-ink-500' : 'bg-emerald-400')} />
        {locked ? 'Locked' : 'Admin'}
      </Button>
      {menuOpen && !locked && (
        <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-md border border-ink-700 bg-ink-850 p-1 shadow-lg">
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-ink-200 hover:bg-ink-800"
            onClick={() => {
              setSessionsOpen(true);
              setMenuOpen(false);
            }}
          >
            Sessions…
          </button>
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-ink-200 hover:bg-ink-800"
            onClick={() => {
              setMenuOpen(false);
              void logout();
            }}
          >
            Log out
          </button>
        </div>
      )}
      {pairingOpen && <PairingDialog onClose={closePairing} />}
      {sessionsOpen && <SessionsPanel onClose={() => setSessionsOpen(false)} />}
    </div>
  );
}
