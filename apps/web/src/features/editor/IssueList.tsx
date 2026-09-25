import type { LayoutIssue } from '@tagconn/shared';
import { Empty } from '../../components/ui';

/**
 * The bottom issue list (guild-hall.md section 5): `validateLayout` issues plus the generator's
 * (`no-door`, `unreachable-room`, `unreachable-seat`). Clicking one selects (and the caller flashes)
 * its rooms on the canvas. Save is blocked while any error remains — see `OfficeEditor`.
 */
export function IssueList({ issues, onSelectIssue }: { issues: LayoutIssue[]; onSelectIssue: (roomIds: string[]) => void }) {
  if (issues.length === 0) {
    return <Empty>No issues — this floor is ready to save.</Empty>;
  }
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const ordered = [...errors, ...warnings];
  return (
    <ul className="max-h-full space-y-0.5 overflow-y-auto p-1.5">
      {ordered.map((issue, i) => (
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
