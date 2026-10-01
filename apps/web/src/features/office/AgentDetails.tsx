import { useMemo, type ReactNode } from 'react';
import { useOfficeStore } from '../../stores/officeStore';
import { useHeroStore } from '../../stores/heroStore';
import { useHeroPanelStore } from '../heroes/store';
import { useNow } from '../../lib/hooks';
import { clock, elapsed, formatTokens } from '../../lib/format';
import { contextRatio, contextWindowFor } from '../../lib/tokens';
import { Badge, Button } from '../../components/ui';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-1 text-[11px]">
      <dt className="text-ink-400">{label}</dt>
      <dd className="min-w-0 break-words text-ink-100">{children}</dd>
    </div>
  );
}

/** The full agent record (the body of `AgentDetailsDialog`): everything the status card leaves out. */
export function AgentDetails({ agentId }: { agentId: string }) {
  const agent = useOfficeStore((s) => s.agents[agentId]);
  const events = useOfficeStore((s) => s.events);
  const tasks = useOfficeStore((s) => s.tasks);
  const session = useOfficeStore((s) => (agent ? s.sessions[agent.sessionId] : undefined));
  const project = useOfficeStore((s) => (agent ? s.projects[agent.projectId] : undefined));
  const heroes = useHeroStore((s) => s.heroes);
  const openHeroEditor = useHeroPanelStore((s) => s.openHeroEditor);
  const now = useNow();
  const recent = useMemo(() => events.filter((e) => e.agentId === agentId).slice(-12).reverse(), [events, agentId]);
  const myTasks = useMemo(() => Object.values(tasks).filter((t) => t.assigneeAgentId === agentId), [tasks, agentId]);
  // M8 8i: the hero (persistent named character, docs/design/living-office.md) currently bound to
  // this agent, if any: heroes are broadcast to every client, so a plain scan of the store is cheap.
  const hero = useMemo(() => Object.values(heroes).find((h) => h.boundAgentId === agentId), [heroes, agentId]);

  return (
    <>
      {!agent ? (
        <p className="p-4 text-xs text-ink-300">This agent has left the office.</p>
      ) : (
        <div className="h-full overflow-y-auto px-4 py-3">
          <dl className="divide-y divide-ink-700/60">
            {hero && (
              <Row label="Hero">
                <div className="flex items-center gap-2">
                  <Badge>
                    {hero.name}
                    {hero.title ? ` · ${hero.title}` : ''}
                  </Badge>
                  <Button variant="ghost" className="ml-auto shrink-0" onClick={() => openHeroEditor(hero)}>
                    Edit hero
                  </Button>
                </div>
              </Row>
            )}
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
    </>
  );
}
