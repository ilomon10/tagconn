import { useEffect, useMemo, useState } from 'react';
import { onFloor, useOfficeStore } from '../../stores/officeStore';
import { useRunsStore } from '../../stores/runsStore';
import { Button, Empty } from '../../components/ui';
import { RunnerStatusBanner } from './RunnerStatusBanner';
import { RunListItem } from './RunListItem';
import { RunDetailPanel } from './RunDetailPanel';
import { NewQuestForm } from './NewQuestForm';

/**
 * Quest board tab (docs/design/runner-and-helpdesk.md section 3). The design doc describes a right
 * drawer opened from the top bar; this task added a single "Quests" tab entry instead (see
 * `app/TopBar.tsx`), so the whole tab body is the board — list on the left, scoped to the selected
 * floor (or every floor, via the Multiverse), detail on the right when a run is selected.
 */
export function QuestBoard() {
  const projects = useOfficeStore((s) => s.projects);
  const selectedFloor = useOfficeStore((s) => s.selectedProjectId);
  const runsMap = useRunsStore((s) => s.runs);
  const refresh = useRunsStore((s) => s.refresh);
  const refreshRunnerStatus = useRunsStore((s) => s.refreshRunnerStatus);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    void refresh();
    void refreshRunnerStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runs = useMemo(
    () =>
      Object.values(runsMap)
        .filter((r) => r.kind === 'quest' && onFloor(selectedFloor, r.projectId ?? ''))
        .sort((a, b) => b.createdAt - a.createdAt),
    [runsMap, selectedFloor],
  );

  const selectedRun = selectedRunId ? runsMap[selectedRunId] : undefined;

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex h-full min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <RunnerStatusBanner />
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold text-ink-100">Quest board</h1>
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            New quest
          </Button>
        </div>
        {runs.length === 0 ? (
          <Empty>No quests yet on this floor. Start one with "New quest".</Empty>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => (
              <RunListItem key={r.id} run={r} floorName={r.projectId ? projects[r.projectId]?.name : undefined} active={r.id === selectedRunId} onOpen={() => setSelectedRunId(r.id)} />
            ))}
          </ul>
        )}
      </div>
      {selectedRun && <RunDetailPanel run={selectedRun} onClose={() => setSelectedRunId(null)} />}
      {formOpen && (
        <NewQuestForm
          initialFloor={selectedFloor}
          onClose={() => setFormOpen(false)}
          onCreated={(run) => setSelectedRunId(run.id)}
        />
      )}
    </div>
  );
}
