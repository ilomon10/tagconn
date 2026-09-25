import { createHash } from 'node:crypto';
import type { Task, TaskStatus } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import type { HookContext } from '../../core/event-bus/index.js';
import { DEFAULT_SUBAGENT_TYPE } from '../agents/index.js';
import { parseHandoff, taskStatusFromHandoff } from './handoff.js';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TODO_STATUS: Record<string, TaskStatus> = { pending: 'todo', in_progress: 'doing', completed: 'done' };
const FINAL: TaskStatus[] = ['done', 'failed', 'review'];

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export const todoTaskId = (sessionId: string, content: string) =>
  `todo:${createHash('sha1').update(`${sessionId}\n${content}`).digest('hex').slice(0, 16)}`;

export class TasksService {
  constructor(private readonly deps: Deps<'tasksRepository' | 'agentsService' | 'bus'>) {}

  onHook(ctx: HookContext): void {
    const p = ctx.payload;
    const tool = p.tool_name ?? '';
    switch (p.hook_event_name) {
      case 'PreToolUse':
        if (AGENT_TOOLS.has(tool) && p.tool_use_id) this.onAgentCall(ctx, p.tool_use_id);
        else if (tool === 'TodoWrite') this.onTodos(ctx);
        break;
      case 'SubagentStart':
        if (ctx.linkedToolUseId) this.patch(ctx.linkedToolUseId, ctx.ts, (t) => ({ assigneeAgentId: t.assigneeAgentId ?? ctx.agentId }));
        break;
      case 'PostToolUse': {
        const agentId = str(obj(p.tool_response).agentId);
        if (AGENT_TOOLS.has(tool) && p.tool_use_id && agentId) this.linkAssignee(p.tool_use_id, agentId, ctx.ts);
        break;
      }
      case 'PostToolUseFailure':
        if (AGENT_TOOLS.has(tool) && p.tool_use_id) this.patch(p.tool_use_id, ctx.ts, () => ({ status: 'failed' }));
        break;
      case 'SubagentStop': {
        const task = p.agent_id ? this.deps.tasksRepository.byAssignee(p.agent_id) : undefined;
        if (task) {
          const status = taskStatusFromHandoff(parseHandoff(p.last_assistant_message));
          this.patch(task.id, ctx.ts, () => ({ status }));
        }
        break;
      }
      case 'SessionEnd':
        // Todo-source tasks are left as-is; still-open agent-call tasks never got a SubagentStop
        // (their handoff would already have finalized them), so they are stuck mid-flight: fail them.
        for (const t of this.deps.tasksRepository.bySession(ctx.sessionId)) {
          if (t.source === 'agent-call' && (t.status === 'todo' || t.status === 'doing')) {
            this.patch(t.id, ctx.ts, () => ({ status: 'failed' }));
          }
        }
        break;
    }
  }

  /**
   * PostToolUse's tool_response.agentId + tool_input.description are paired exactly by tool_use_id,
   * so this is authoritative and overwrites the SubagentStart FIFO guess (set unconditionally, not
   * only when unset). If another task was wrongly given this same agentId by an earlier guess,
   * un-assign it — it belongs to a different tool_use_id.
   */
  private linkAssignee(toolUseId: string, agentId: string, ts: number): void {
    const wrong = this.deps.tasksRepository.byAssignee(agentId);
    if (wrong && wrong.id !== toolUseId) this.patch(wrong.id, ts, () => ({ assigneeAgentId: undefined }));
    this.patch(toolUseId, ts, () => ({ assigneeAgentId: agentId }));
  }

  private onAgentCall(ctx: HookContext, id: string): void {
    const input = obj(ctx.payload.tool_input);
    const existing = this.deps.tasksRepository.get(id);
    if (existing && FINAL.includes(existing.status)) return;
    const subagentType = str(input.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
    this.save(existing, {
      id,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      title: str(input.description) ?? `${subagentType} task`,
      assigneeAgentId: existing?.assigneeAgentId,
      role: this.deps.agentsService.resolveRole(subagentType),
      status: 'doing',
      source: 'agent-call',
      createdAt: existing?.createdAt ?? ctx.ts,
      updatedAt: ctx.ts,
    });
  }

  private onTodos(ctx: HookContext): void {
    const todos = obj(ctx.payload.tool_input).todos;
    if (!Array.isArray(todos)) return;
    for (const todo of todos) {
      const content = str(obj(todo).content);
      if (!content) continue;
      const id = todoTaskId(ctx.sessionId, content);
      const existing = this.deps.tasksRepository.get(id);
      this.save(existing, {
        id,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        title: content,
        assigneeAgentId: ctx.agentId,
        role: ctx.role,
        status: TODO_STATUS[String(obj(todo).status)] ?? 'todo',
        source: 'todo',
        createdAt: existing?.createdAt ?? ctx.ts,
        updatedAt: ctx.ts,
      });
    }
  }

  private patch(id: string, ts: number, fn: (t: Task) => Partial<Task>): void {
    const existing = this.deps.tasksRepository.get(id);
    if (existing) this.save(existing, { ...existing, ...fn(existing), updatedAt: ts });
  }

  /** Persists and broadcasts only when something other than updatedAt changed. */
  private save(prev: Task | undefined, next: Task): void {
    if (prev && JSON.stringify({ ...prev, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 })) return;
    this.deps.tasksRepository.upsert(next);
    this.deps.bus.emit('task.upserted', next);
  }
}
