import { useOfficeStore } from '../../stores/officeStore';
import { useRequireAdmin } from '../auth/useRequireAdmin';
import { useAttributionStore } from './store';
import { AttributionCard } from './AttributionCard';

/**
 * Floating toast(s) for freshly-pushed `attribution:pending` imports (M8 8j, docs/design/runner-and-
 * helpdesk.md section 6.3: "the toast shows the repo path... with Import/Dismiss"). Mounted once from
 * `App.tsx`, same "always mounted, renders nothing when there's nothing to show" pattern as
 * `AdminBadge`'s dialogs. Reads the same store `PendingImportsPanel` (Settings → Attribution) does, so
 * resolving one here clears it there too, and vice versa. `attribution:pending` only ever reaches an
 * admin socket (admin-room only push), so nothing extra is needed here to keep a non-admin browser from
 * seeing someone else's pending imports — the list is simply always empty for it.
 */
export function AttributionToastHost() {
  const connection = useOfficeStore((s) => s.connection);
  const pending = useAttributionStore((s) => s.pending);
  const busy = useAttributionStore((s) => s.busy);
  const resolve = useAttributionStore((s) => s.resolve);
  const { guard } = useRequireAdmin();

  if (connection === 'demo' || pending.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-80 flex-col gap-2">
      {pending.map((item) => (
        <div key={item.projectId} className="pointer-events-auto shadow-xl">
          <AttributionCard
            item={item}
            busy={!!busy[item.projectId]}
            onImport={() => guard(() => void resolve(item.projectId, 'import'))}
            onDismiss={() => guard(() => void resolve(item.projectId, 'dismiss'))}
          />
        </div>
      ))}
    </div>
  );
}
