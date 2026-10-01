import { useMemo, useRef, type ReactNode } from 'react';
import { useOfficeStore } from '../../stores/officeStore';
import { useHeroStore } from '../../stores/heroStore';
import { useHeroPanelStore } from '../heroes/store';
import { useNow, useThemedRoleLookup } from '../../lib/hooks';
import { clock, elapsed, formatTokens } from '../../lib/format';
import { contextRatio, contextWindowFor } from '../../lib/tokens';
import { useModalFocus } from '../../lib/useModalFocus';
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
}: {
  agentId: string;
  onClose: () => void;
  /** Whether the camera should keep this agent centered in view while it moves. */
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}) {
  const agent = useOfficeStore((s) => s.agents[agentId]);
  const events = useOfficeStore((s) => s.events);
  const tasks = useOfficeStore((s) => s.tasks);
  const session = useOfficeStore((s) => (agent ? s.sessions[agent.sessionId] : undefined));
  const project = useOfficeStore((s) => (agent ? s.projects[agent.projectId] : undefined));
  const heroes = useHeroStore((s) => s.heroes);
  const openHeroEditor = useHeroPanelStore((s) => s.openHeroEditor);
  const lookup = useThemedRoleLookup();
  const now = useNow();
  const recent = useMemo(() => events.filter((e) => e.agentId === agentId).slice(-12).reverse(), [events, agentId]);
  const myTasks = useMemo(() => Object.values(tasks).filter((t) => t.assigneeAgentId === agentId), [tasks, agentId]);
  // M8 8i: the hero (persistent named character, docs/design/living-office.md) currently bound to
  // this agent, if any — heroes are broadcast to every client, so a plain scan of the store is cheap.
  const hero = useMemo(() => Object.values(heroes).find((h) => h.boundAgentId === agentId), [heroes, agentId]);

  // M9 8f: not a modal (the map stays clickable behind it, so no Tab trap) — but opening it should
  // still move focus onto the drawer, and give it back to whatever had it once the drawer closes.
  const containerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useModalFocus(true, containerRef, { initialFocusRef: headingRef });

  // Same label as the roster row: hero title, edited role title, else this agent's floor-style title.
  const role = lookup(agent?.role, { projectId: agent?.projectId, hero });
  return (
    // Docked to the right on tablets, desktops and phones in landscape; a bottom sheet on a phone in portrait. Either way
    // this is a plain edge-docked panel with its own scroll — no full-screen backdrop, so the rest
    // of the canvas stays clickable and draggable.
    <aside
      ref={containerRef}
      data-camera-overlay
      className="anim-sheet absolute inset-x-0 bottom-0 z-10 flex max-h-[60%] flex-col rounded-t-xl border-t border-ink-700 bg-ink-850/95 pb-[env(safe-area-inset-bottom)] shadow-2xl backdrop-blur dialog:inset-x-auto dialog:inset-y-0 dialog:right-0 dialog:max-h-none dialog:w-80 dialog:rounded-none dialog:border-l dialog:border-t-0 dialog:pb-0 side:inset-x-auto side:inset-y-0 side:right-0 side:max-h-none side:w-[min(20rem,55%)] side:rounded-none side:border-l side:border-t-0"
    >
      <header className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
        <Dot color={role.color} />
        <h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-semibold">
          {agent ? (hero ? `${hero.name} · ${role.themedTitle}` : role.themedTitle) : 'Agent left'}
        </h2>
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
    </aside>
  );
}
