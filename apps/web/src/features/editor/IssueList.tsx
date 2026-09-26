import type { DoorSpec, LayoutIssue, LayoutRoom } from '@tagconn/shared';
import type { ReachabilityReport } from '../../game/procgen';
import { REASON_LABEL } from './reachability';
import { Button, Empty } from '../../components/ui';

const roomLabel = (rooms: readonly LayoutRoom[], roomId: string) => {
  const r = rooms.find((x) => x.id === roomId);
  return r ? (r.name ?? `${r.type} (${r.id})`) : roomId;
};

/**
 * The bottom issue list (guild-hall.md section 5): `validateLayout` issues plus the generator's
 * reachability report (M8 8n) — richer than the plain `unreachable-room`/`unreachable-seat` issues,
 * with a reason and a one-click "Fix: add door on <side>" when the generator can suggest one.
 * Clicking a row selects (and the caller flashes) its rooms on the canvas. Save is blocked while any
 * error remains — see `OfficeEditor`.
 */
export function IssueList({
  issues,
  rooms,
  reachability,
  onSelectIssue,
  onFix,
}: {
  issues: LayoutIssue[];
  rooms: readonly LayoutRoom[];
  reachability?: ReachabilityReport;
  onSelectIssue: (roomIds: string[]) => void;
  onFix: (roomId: string, suggestion: DoorSpec) => void;
}) {
  // The reachability report says the same thing as `unreachable-room`/`unreachable-seat`, only with
  // more detail (a reason and a fix), so those two plain issues are dropped in favor of the richer rows below.
  const plain = issues.filter((i) => i.code !== 'unreachable-room' && i.code !== 'unreachable-seat');
  const errors = plain.filter((i) => i.severity === 'error');
  const warnings = plain.filter((i) => i.severity === 'warning');

  const unreachableRows = reachability?.unreachableRooms ?? [];
  const unreachableSeats = reachability?.unreachableSeats ?? 0;

  if (errors.length === 0 && warnings.length === 0 && unreachableRows.length === 0 && unreachableSeats === 0) {
    return <Empty>No issues — this floor is ready to save.</Empty>;
  }

  return (
    <ul className="max-h-full space-y-0.5 overflow-y-auto p-1.5">
      {unreachableRows.map((u) => (
        <li key={`unreachable-${u.roomId}`} className="flex items-center gap-2 rounded px-2 py-1 text-[11px] text-red-300">
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-red-400" />
          <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onSelectIssue([u.roomId])}>
            {roomLabel(rooms, u.roomId)} is unreachable: {REASON_LABEL[u.reason]}.
          </button>
          {u.suggestion && (
            <Button variant="subtle" className="shrink-0" onClick={() => onFix(u.roomId, u.suggestion!)}>
              Fix: add door on {u.suggestion.side.toUpperCase()}
            </Button>
          )}
        </li>
      ))}
      {unreachableSeats > 0 && (
        <li className="flex items-center gap-2 rounded px-2 py-1 text-[11px] text-amber-300">
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-amber-400" />
          <span className="truncate">
            {unreachableSeats} seat{unreachableSeats === 1 ? '' : 's'} unreachable from the entrance.
          </span>
        </li>
      )}
      {[...errors, ...warnings].map((issue, i) => (
        <li key={`${issue.code}-${i}`}>
          <button
            type="button"
            className={
              'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-ink-800 ' +
              (issue.severity === 'error' ? 'text-red-300' : 'text-amber-300')
            }
            onClick={() => onSelectIssue(issue.roomIds ?? [])}
            disabled={!issue.roomIds?.length}
            title={issue.roomIds?.length ? 'Click to select and flash on the plan' : undefined}
          >
            <span
              className={
                'inline-block size-1.5 shrink-0 rounded-full ' + (issue.severity === 'error' ? 'bg-red-400' : 'bg-amber-400')
              }
            />
            <span className="truncate">{issue.message}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
