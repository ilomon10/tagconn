import { useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useOfficeStore } from '../../stores/officeStore';
import { useRequireAdmin } from '../auth/useRequireAdmin';
import { Empty } from '../../components/ui';
import { useAttributionStore } from './store';
import { AttributionCard } from './AttributionCard';

/**
 * Settings → Attribution: the same pending-imports queue as the floating `AttributionToastHost`, so a
 * profile dismissed or imported from one place disappears from the other too (M8 8j, docs/design/
 * runner-and-helpdesk.md section 6.3). Demo mode has no server pushing these, and a non-admin browser
 * never receives them either (`attribution:pending` is admin-room only) — both show a plain notice
 * instead of an empty "no pending imports" that would look like a real answer.
 */
export function PendingImportsPanel() {
  const connection = useOfficeStore((s) => s.connection);
  const admin = useAuthStore((s) => s.status.admin);
  const pending = useAttributionStore((s) => s.pending);
  const loaded = useAttributionStore((s) => s.loaded);
  const busy = useAttributionStore((s) => s.busy);
  const hydrate = useAttributionStore((s) => s.hydrate);
  const resolve = useAttributionStore((s) => s.resolve);
  const { guard } = useRequireAdmin();

  useEffect(() => {
    if (connection !== 'demo' && admin) void hydrate();
  }, [connection, admin, hydrate]);

  if (connection === 'demo' || !admin) return <Empty>Pair this browser as admin to see pending profile imports.</Empty>;
  if (loaded && pending.length === 0) return <Empty>No pending profile imports.</Empty>;

  return (
    <div className="space-y-2">
      {pending.map((item) => (
        <AttributionCard
          key={item.projectId}
          item={item}
          busy={!!busy[item.projectId]}
          onImport={() => guard(() => void resolve(item.projectId, 'import'))}
          onDismiss={() => guard(() => void resolve(item.projectId, 'dismiss'))}
        />
      ))}
    </div>
  );
}
