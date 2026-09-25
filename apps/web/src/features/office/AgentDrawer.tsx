import { useMemo, type ReactNode } from 'react';
import { useOfficeStore } from '../../stores/officeStore';
import { useNow, useRoleLookup } from '../../lib/hooks';
import { clock, elapsed, formatTokens } from '../../lib/format';
import { contextRatio, contextWindowFor } from '../../lib/tokens';
import { Badge, Button, Checkbox, Dot } from '../../components/ui';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 py-1 text-[11px]">
      <dt className="text-ink-400">{label}</dt>
      <dd className="min-w-0 break-words text-ink-100">{children}</dd>
    </div>
  );
}

export function AgentDrawer({
  agentId,
  onClose,
  follow,
  onFollowChange,
  rootRef,
}: {
  agentId: string;
  onClose: () => void;
  /** Whether the camera should keep this agent centered in view while it moves. */
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  /** Reports the panel's root DOM node so the host can measure it for the camera's safe insets. */
  rootRef?: (el: HTMLElement | null) => void;
}) {
  const agent = useOfficeStore((s) => s.agents[agentId]);
  const events = useOfficeStore((s) => s.events);
  const tasks = useOfficeStore((s) => s.tasks);
  const session = useOfficeStore((s) => (agent ? s.sessions[agent.sessionId] : undefined));
  const project = useOfficeStore((s) => (agent ? s.projects[agent.projectId] : undefined));
  const lookup = useRoleLookup();
  const now = useNow();
  const recent = useMemo(() => events.filter((e) => e.agentId === agentId).slice(-12).reverse(), [events, agentId]);
  const myTasks = useMemo(() => Object.values(tasks).filter((t) => t.assigneeAgentId === agentId), [tasks, agentId]);

  const role = lookup(agent?.role);
  return (
    // Docked to the right on wide screens; collapses to a bottom sheet on narrow ones. Either way
    // this is a plain edge-docked panel with its own scroll — no full-screen backdrop, so the rest
    // of the canvas stays clickable and draggable.
    <aside
      ref={rootRef}
      className="absolute inset-x-0 bottom-0 z-10 flex max-h-[70vh] flex-col rounded-t-xl border-t border-ink-700 bg-ink-850/95 shadow-2xl backdrop-blur sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:top-0 sm:bottom-0 sm:w-80 sm:max-h-none sm:rounded-none sm:border-l sm:border-t-0"
    >
      <header className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
        <Dot color={role.color} />
        <h2 className="truncate text-sm font-semibold">{agent ? role.title : 'Agent left'}</h2>
        <div className="ml-auto flex items-center gap-2">
          {agent && <Checkbox checked={follow} onChange={onFollowChange} label="Follow" />}
          <Button variant="ghost" onClick={onClose} aria-label="Close details">
            ✕
          </Button>
        </div>
      </header>
      {!agent ? (
        <p className="p-4 text-xs text-ink-400">This agent has left the office.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <dl className="divide-y divide-ink-700/60">
            {agent.description && <Row label="Task">{agent.description}</Row>}
            <Row label="Status">
              <Badge>{agent.status}</Badge> <Badge>{agent.activity}</Badge>
            </Row>
            <Row label="Zone">{agent.zone}</Row>
            {agent.bubble && <Row label="Says">“{agent.bubble}”</Row>}
            {agent.currentTool && <Row label="Tool">{agent.currentTool}</Row>}
            <Row label="Tools used">{agent.toolCount}</Row>
            <Row label="Elapsed">{elapsed(agent.startedAt, agent.endedAt ?? now)}</Row>
            <Row label="Agent type">{agent.agentType}</Row>
            <Row label="Role">{agent.role}</Row>
            <Row label="Project">{project?.name ?? agent.projectId}</Row>
            <Row label="Session">
              <span className="font-pixel">{agent.sessionId.slice(0, 18)}</span>
              {session?.status && <span className="text-ink-400"> · {session.status}</span>}
            </Row>
            {session?.lastPrompt && agent.isMain && <Row label="Last prompt">{session.lastPrompt}</Row>}
            {agent.lastMessage && <Row label="Last message">{agent.lastMessage}</Row>}
            {agent.usage && (
              <>
                {agent.usage.model && <Row label="Model">{agent.usage.model}</Row>}
                <Row label="Tokens in">{formatTokens(agent.usage.inputTokens)}</Row>
                <Row label="Tokens out">{formatTokens(agent.usage.outputTokens)}</Row>
                <Row label="Cache read">{formatTokens(agent.usage.cacheReadTokens)}</Row>
                <Row label="Cache write">{formatTokens(agent.usage.cacheCreationTokens)}</Row>
                <Row label="Messages">{agent.usage.messages}</Row>
                <Row label="Context">
                  {formatTokens(agent.usage.contextTokens)} / {formatTokens(contextWindowFor(agent.usage.model))}
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
                    <div className="h-full rounded-full bg-cozy/70" style={{ width: `${contextRatio(agent.usage) * 100}%` }} />
                  </div>
                </Row>
              </>
            )}
          </dl>

          {myTasks.length > 0 && (
            <>
              <h3 className="mt-4 mb-1 text-[11px] font-semibold text-ink-300">Tasks</h3>
              <ul className="space-y-1">
                {myTasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-[11px]">
                    <Badge>{t.status}</Badge>
                    <span className="truncate">{t.title}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="mt-4 mb-1 text-[11px] font-semibold text-ink-300">Recent activity</h3>
          {recent.length === 0 ? (
            <p className="text-[11px] text-ink-400">Nothing yet.</p>
          ) : (
            <ul className="space-y-1">
              {recent.map((e) => (
                <li key={e.id} className="text-[11px]">
                  <span className="font-pixel text-ink-400">{clock(e.ts)}</span> <span className="text-ink-300">{e.toolName ?? e.hookEvent}</span>{' '}
                  <span className="text-ink-100">{e.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
