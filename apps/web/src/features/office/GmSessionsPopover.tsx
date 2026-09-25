import { elapsed, shortId } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useOfficeStore } from '../../stores/officeStore';
import { Badge, Button, Empty, Panel } from '../../components/ui';

/**
 * The Guild Master's session-count chip popover (M8 8b, docs/design/living-office.md section 5).
 * Opened from the scene's `gmSessions` event (the floor's GM chip, "+N"): lists every live main
 * session on that floor (short id, last prompt, status, age), lets you jump to one's agent drawer,
 * and lets you "Pin as Guild Master" — sticking the floor's GM to that session until it ends
 * (`officeStore`'s `pinnedPrimary`, auto-cleared by `prunePins` once the session does).
 */
export function GmSessionsPopover({
  projectId,
  onClose,
  onSelectAgent,
}: {
  projectId: string;
  onClose: () => void;
  /** Opens that main agent's drawer (mirrors `Roster`'s `onSelect`). */
  onSelectAgent: (agentId: string) => void;
}) {
  const now = useNow();
  const agents = useOfficeStore((s) => s.agents);
  const sessions = useOfficeStore((s) => s.sessions);
  const projectName = useOfficeStore((s) => s.projects[projectId]?.name ?? projectId);
  const pinnedAgentId = useOfficeStore((s) => s.pinnedPrimary[projectId]);
  const pinPrimary = useOfficeStore((s) => s.pinPrimary);
  const unpinPrimary = useOfficeStore((s) => s.unpinPrimary);

  // Live main sessions on this floor, most recently updated first — the same population `cast.ts`
  // merges into the Guild Master (the chosen primary) plus its `sessionsChip`.
  const mains = Object.values(agents)
    .filter((a) => a.projectId === projectId && a.isMain && a.status !== 'done' && sessions[a.sessionId]?.status !== 'ended')
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-20" onClick={onClose} data-modal="gm-sessions" aria-modal="true" role="dialog">
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <Panel
          title={`Guild Master · ${projectName}`}
          actions={
            <Button variant="ghost" onClick={onClose} aria-label="Close">
              ✕
            </Button>
          }
        >
          {mains.length === 0 ? (
            <Empty>No live sessions on this floor.</Empty>
          ) : (
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto p-2">
              {mains.map((a) => {
                const session = sessions[a.sessionId];
                const isPinned = pinnedAgentId === a.id;
                const needsYou = a.status === 'waiting' || a.status === 'blocked';
                return (
                  <li key={a.id} className="rounded-md px-2 py-1.5 hover:bg-ink-800">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-ink-100"
                        onClick={() => onSelectAgent(a.id)}
                        title="Open this session's agent"
                      >
                        session {shortId(a.sessionId)}
                      </button>
                      <Badge className={needsYou ? 'bg-amber-500/20 text-amber-300' : 'bg-ink-700 text-ink-300'}>{a.status}</Badge>
                      <span className="shrink-0 font-pixel text-[10px] text-ink-400">{elapsed(a.startedAt, a.endedAt ?? now)}</span>
                    </div>
                    {session?.lastPrompt && <div className="mt-0.5 truncate pl-0.5 text-[11px] text-ink-400">{session.lastPrompt}</div>}
                    <div className="mt-1 pl-0.5">
                      <Button
                        variant={isPinned ? 'primary' : 'subtle'}
                        onClick={() => (isPinned ? unpinPrimary(projectId) : pinPrimary(projectId, a.id))}
                        title="Sticks this session as the floor's Guild Master until it ends"
                      >
                        {isPinned ? 'Pinned as Guild Master ✓' : 'Pin as Guild Master'}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
