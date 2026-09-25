import { useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { Badge, Button, Empty, Panel } from '../../components/ui';

const fmt = (ms: number) => new Date(ms).toLocaleString();

/** M8 8m sessions list (docs/design/runner-and-helpdesk.md section 5.3): revoke one session or all of
 *  them. Fetched over the socket (`auth:sessions`), so a session revoked or expired elsewhere shows up
 *  as an ack timeout, not a stale list — see `stores/authStore.ts`. */
export function SessionsPanel({ onClose }: { onClose: () => void }) {
  const sessions = useAuthStore((s) => s.sessions);
  const sessionsLoaded = useAuthStore((s) => s.sessionsLoaded);
  const sessionsBusy = useAuthStore((s) => s.sessionsBusy);
  const loadSessions = useAuthStore((s) => s.loadSessions);
  const revoke = useAuthStore((s) => s.revoke);

  useEffect(() => {
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20"
      onClick={onClose}
      data-modal="auth-sessions"
      aria-modal="true"
      role="dialog"
      aria-label="Admin sessions"
    >
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <Panel
          title="Admin sessions"
          actions={
            <>
              <Button variant="danger" disabled={sessionsBusy || sessions.length === 0} onClick={() => void revoke('*')}>
                Revoke all
              </Button>
              <Button variant="ghost" onClick={onClose} aria-label="Close">
                ✕
              </Button>
            </>
          }
        >
          {!sessionsLoaded ? (
            <Empty>Loading…</Empty>
          ) : sessions.length === 0 ? (
            <Empty>No admin sessions.</Empty>
          ) : (
            <ul className="divide-y divide-ink-700">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-xs text-ink-100">
                      <span className="truncate">{s.label || s.userAgent || s.id}</span>
                      {s.current && <Badge>this browser</Badge>}
                    </div>
                    <div className="text-[10px] text-ink-400">
                      last used {fmt(s.lastUsedAt)} · expires {fmt(s.expiresAt)}
                    </div>
                  </div>
                  <Button variant="subtle" className="shrink-0" disabled={sessionsBusy} onClick={() => void revoke(s.id)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
