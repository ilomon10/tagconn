import { useEffect, useState } from 'react';
import type { Run } from '@tagconn/shared';
import { isTerminalRunStatus } from '@tagconn/shared';
import { useOfficeStore } from '../../stores/officeStore';
import { useRunsStore } from '../../stores/runsStore';
import { useRequireAdmin } from '../auth/useRequireAdmin';
import { Badge, Button, Textarea } from '../../components/ui';
import { Transcript } from './Transcript';
import { guidanceForEndReason, guidanceForError } from './rejectionGuidance';

/**
 * Run detail (docs/design/runner-and-helpdesk.md section 3: "Stop, Follow up, Focus" plus
 * "rejections explain the fix"). Rendered inline next to the quest list rather than as a drawer —
 * this task's tab is the whole "Quest board" surface, so there's no separate drawer to slide out of.
 */
export function RunDetailPanel({ run, onClose }: { run: Run; onClose: () => void }) {
  const events = useRunsStore((s) => s.eventsByRun[run.id] ?? []);
  const loadDetail = useRunsStore((s) => s.loadDetail);
  const followUp = useRunsStore((s) => s.followUp);
  const stop = useRunsStore((s) => s.stop);
  const selectFloor = useOfficeStore((s) => s.selectProject);
  const { guard } = useRequireAdmin();

  const [followUpText, setFollowUpText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadDetail(run.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  const terminal = isTerminalRunStatus(run.status);
  const canStop = !terminal;
  const canFollowUp = terminal && run.status === 'succeeded' && !!run.sessionId;
  const rejectionText = guidanceForEndReason(run.endReason);

  const doStop = async () => {
    setBusy(true);
    setError(null);
    try {
      await stop(run.id);
    } catch (err) {
      setError(err instanceof Error ? guidanceForError(err.message) : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doFollowUp = async () => {
    if (!followUpText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await followUp({ runId: run.id, prompt: followUpText.trim() });
      setFollowUpText('');
    } catch (err) {
      setError(err instanceof Error ? guidanceForError(err.message) : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-ink-700 bg-ink-900">
      <header className="flex items-center justify-between gap-2 border-b border-ink-700 px-3 py-2">
        <div className="flex items-center gap-2">
          <Badge>{run.status}</Badge>
          <span className="text-xs font-semibold text-ink-100">Quest</span>
        </div>
        <div className="flex items-center gap-1.5">
          {run.projectId && (
            <Button variant="ghost" onClick={() => selectFloor(run.projectId!)} title="Jump to this floor">
              Focus
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <p className="whitespace-pre-wrap text-xs text-ink-200">{run.prompt}</p>

        {rejectionText && (
          <p className="rounded-md border border-red-800 bg-red-950/30 px-3 py-2 text-[11px] leading-relaxed text-red-100">{rejectionText}</p>
        )}
        {run.error && !rejectionText && <p className="rounded-md border border-red-800 bg-red-950/30 px-3 py-2 text-[11px] text-red-100">{run.error}</p>}

        <Transcript events={events} />
      </div>

      <footer className="space-y-2 border-t border-ink-700 p-3">
        {error && <p className="text-[11px] text-red-300">{error}</p>}
        <div className="flex gap-2">
          <Button variant="danger" disabled={!canStop || busy} onClick={() => guard(doStop)}>
            Stop
          </Button>
        </div>
        {canFollowUp && (
          <div className="space-y-1.5">
            <Textarea rows={2} placeholder="Follow up on this quest…" value={followUpText} onChange={(e) => setFollowUpText(e.target.value)} />
            <Button variant="primary" disabled={busy || !followUpText.trim()} onClick={() => guard(doFollowUp)}>
              Follow up
            </Button>
          </div>
        )}
      </footer>
    </aside>
  );
}
