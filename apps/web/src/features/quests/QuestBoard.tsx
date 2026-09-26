import { useEffect, useMemo, useState } from 'react';
import { onFloor, useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { useRunsStore } from '../../stores/runsStore';
import { Button, Empty } from '../../components/ui';
import { RunnerStatusBanner } from './RunnerStatusBanner';
import { RunListItem } from './RunListItem';
import { RunDetailPanel } from './RunDetailPanel';
import { NewQuestForm } from './NewQuestForm';
import { RUNNER_AND_QUESTS_GUIDE_URL } from './runnerBannerState';

/**
 * Quest board tab (docs/design/runner-and-helpdesk.md section 3). The design doc describes a right
 * drawer opened from the top bar; this task added a single "Quests" tab entry instead (see
 * `app/TopBar.tsx`), so the whole tab body is the board — list on the left, scoped to the selected
 * floor (or every floor, via the Multiverse), detail on the right when a run is selected.
 *
 * `runs:list`/`runner:getStatus` are always admin-gated (`ADMIN_SOCKET_EVENTS_EXECUTION`), so an
 * unpaired browser can't see anything here at all — this tab gates on `allowed` the same way
 * `ReceptionistPanel` does, instead of firing denied requests and showing a misleading "no quests yet".
 */
export function QuestBoard() {
  const projects = useOfficeStore((s) => s.projects);
  const selectedFloor = useOfficeStore((s) => s.selectedProjectId);
  const settingsLoaded = useSettingsStore((s) => s.settingsLoaded);
  const demo = useOfficeStore((s) => s.connection === 'demo');
  const admin = useAuthStore((s) => s.status.admin);
  const authLoaded = useAuthStore((s) => s.statusLoaded);
  const openPairing = useAuthStore((s) => s.openPairing);
  const runsMap = useRunsStore((s) => s.runs);
  const runsLoaded = useRunsStore((s) => s.runsLoaded);
  const refresh = useRunsStore((s) => s.refresh);
  const refreshRunnerStatus = useRunsStore((s) => s.refreshRunnerStatus);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const allowed = demo || admin;

  useEffect(() => {
    if (!allowed) return;
    void refresh();
    void refreshRunnerStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

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
        {!settingsLoaded || (!allowed && !authLoaded) ? (
          <Empty>Loading…</Empty>
        ) : !allowed ? (
          <Empty>
            <p className="mb-2">Pair this browser to see and post quests here — the quest board only works for a paired admin session.</p>
            <Button variant="primary" onClick={() => openPairing()}>
              Pair this browser
            </Button>
          </Empty>
        ) : !runsLoaded ? (
          <Empty>Loading quests…</Empty>
        ) : runs.length === 0 ? (
          <Empty>
            <p>
              Quests post a prompt to a floor and let a character run it here, on this machine, using your own Claude Code
              login.{' '}
              <a href={RUNNER_AND_QUESTS_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">
                Learn more
              </a>
              .
            </p>
            <p className="mt-1">Start one with "New quest" above.</p>
          </Empty>
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
