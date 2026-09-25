import type { OfficeEvent } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import type { HookContext } from '../../core/event-bus/index.js';

const RETENTION_SWEEP_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const clip = (s: string, max = 120) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One-line human summary of a hook for the event log. */
export function summarize(ctx: HookContext): string {
  const p = ctx.payload;
  const who = p.agent_type ?? 'main';
  switch (p.hook_event_name) {
    case 'SessionStart':
      return `Session started${p.source ? ` (${p.source})` : ''}`;
    case 'SessionEnd':
      return `Session ended${p.reason ? ` (${p.reason})` : ''}`;
    case 'UserPromptSubmit':
      return p.prompt ? `Prompt: ${clip(p.prompt, 100)}` : 'Prompt submitted';
    case 'PreToolUse':
      return ctx.bubble ?? p.tool_name ?? 'Tool call';
    case 'PostToolUse':
      return `${p.tool_name ?? 'Tool'} finished`;
    case 'PostToolUseFailure':
      return `${p.tool_name ?? 'Tool'} failed`;
    case 'SubagentStart':
      return `${who} started${ctx.bubble && ctx.bubble !== 'Starting' ? `: ${clip(ctx.bubble, 80)}` : ''}`;
    case 'SubagentStop':
      return `${who} finished`;
    case 'Stop':
      return 'Turn finished';
    case 'Notification':
      return p.message ? clip(p.message) : 'Notification';
    case 'PreCompact':
      return 'Compacting context';
    default:
      return p.hook_event_name;
  }
}

export class EventsService {
  private retentionTimer?: NodeJS.Timeout;

  constructor(
    private readonly deps: Deps<'eventsRepository' | 'sessionsRepository' | 'tasksRepository' | 'agentsRepository' | 'settings' | 'bus' | 'logger'>,
  ) {}

  onHook(ctx: HookContext): void {
    const p = ctx.payload;
    const payload =
      ctx.storePayload && (p.tool_input !== undefined || p.tool_response !== undefined)
        ? { tool_input: p.tool_input, tool_response: p.tool_response }
        : undefined;
    const event = this.deps.eventsRepository.insert({
      ts: ctx.ts,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      hookEvent: p.hook_event_name,
      toolName: p.tool_name,
      activity: ctx.activity,
      summary: summarize(ctx),
      payload,
    });
    this.deps.bus.emit('event.created', event);
  }

  list(opts: { projectId?: string; limit: number; before?: number }): OfficeEvent[] {
    return this.deps.eventsRepository.list(opts);
  }

  /** Hourly retention: drops old events, ended sessions, done/failed tasks and removed agents.
   *  Projects are never pruned. */
  pruneOld(now = Date.now()): number {
    const days = this.deps.settings.get().storage.eventRetentionDays;
    const cutoff = now - days * DAY_MS;
    const events = this.deps.eventsRepository.deleteOlderThan(cutoff);
    const sessions = this.deps.sessionsRepository.deleteEndedBefore(cutoff);
    const tasks = this.deps.tasksRepository.deleteFinishedBefore(cutoff);
    const agents = this.deps.agentsRepository.deleteRemovedBefore(cutoff);
    if (events || sessions || tasks || agents) {
      this.deps.logger.info({ events, sessions, tasks, agents, days }, 'pruned old records');
    }
    return events;
  }

  start(): void {
    const run = () => {
      try {
        this.pruneOld();
      } catch (err) {
        this.deps.logger.error({ err }, 'event retention failed');
      }
    };
    run();
    this.retentionTimer = setInterval(run, RETENTION_SWEEP_MS);
    this.retentionTimer.unref();
  }

  stop(): void {
    clearInterval(this.retentionTimer);
  }
}
