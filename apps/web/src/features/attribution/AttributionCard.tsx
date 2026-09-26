import type { PendingProfileImport } from '@tagconn/shared';
import { Button } from '../../components/ui';
import { describeImport } from './reducer';

/**
 * One pending profile import, shared by `AttributionToastHost` (floating toast) and
 * `PendingImportsPanel` (Settings → Attribution) so the copy and the Import/Dismiss buttons stay in
 * sync (docs/design/runner-and-helpdesk.md section 6.3). Every dynamic string (`projectCwd`,
 * `floorName`, `unknownRoles`) is plain JSX text — React escapes it — never `dangerouslySetInnerHTML`,
 * since a profile is untrusted repo content.
 */
export function AttributionCard({
  item,
  busy,
  onImport,
  onDismiss,
}: {
  item: PendingProfileImport;
  busy: boolean;
  onImport: () => void;
  onDismiss: () => void;
}) {
  const { items, skipped } = describeImport(item);
  return (
    <div className="space-y-1.5 rounded-md border border-ink-700 bg-ink-850 p-2.5 text-[11px] text-ink-200">
      <p className="text-ink-100">
        Found a tagconn profile in <span className="font-pixel break-all text-cozy">{item.projectCwd}</span>
      </p>
      <p>Would import: {items.join(', ')}.</p>
      {skipped && <p className="text-amber-300">{skipped}.</p>}
      <div className="flex gap-2 pt-1">
        <Button variant="primary" disabled={busy} onClick={onImport}>
          {busy ? 'Importing…' : 'Import'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
